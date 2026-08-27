# Testing & Quality

## Quality gate

```bash
make check      # hard gate: every package's lint + tests. Must pass before every commit.
```

`make check` is the single CI gate; each package appends its own target to `check`
(`forge fmt --check && forge test`, `cargo fmt --check && cargo clippy -- -D warnings &&
cargo test`, `npm run ci`, `ruff check && pytest`). If it fails, diagnose and fix before
continuing — never bypass it. `make check` always precedes the package-specific command.

## Per-package verification

| Package | Path | Command | Notes |
|---|---|---|---|
| Contracts (WP-1, WP-2, WP-B) | `contracts/` | `forge test` | Unit, fuzz and invariant suites (TS-1, TS-B). The mainnet-fork suite (TS-2) runs at a pinned block: `forge test --fork-url $ETH_RPC --fork-block-number <N>`. |
| Settler (WP-3) | `settler/` | `cargo test` | Window-builder unit and property tests (TS-3); enclave integration tests behind a feature or env flag. |
| Scenario (WP-4) | `scenario/` | `scenario/dex-scenario.sh` | Kurtosis enclave. Happy path + first failure rows on every PR; full matrix and the 200-slot soak nightly (RL-4, HX-4). |
| Indexer (WP-5) | `indexer/` | `npm test` | Schema round-trip, replay-equals-live (TS-5). |
| Frontend (WP-6) | `frontend/` | `npm run ci` | Reducer unit tests + headless e2e against the recorded-run fixture (TS-5). |

Mainnet RPC: copy `.env.example` → `.env`. `https://eth.drpc.org` works keyless and serves
10k-block `eth_getLogs` ranges. Anything that replays real flow runs sequentially, never in CI.

## Test mandate

Every feature commit includes at least one test for the new behaviour, named for the
requirement ID it pins (e.g. `test_ct10_rejects_fill_below_min_buy`). Every bug fix
includes a regression test that would have caught the bug. A commit that adds behaviour
without a test, or fixes a bug without a regression test, is incomplete.

These invariants are load-bearing for user safety and **must** carry a test whenever the
code they depend on is touched:

- **Escrow invariant (CT-13)** — Foundry `invariant_` test per asset; asserted after every
  scenario and the soak.
- **Limit enforcement (CT-10)** — no fill below `minBuyAmount`, including the
  favourable-to-residual move that violates a *crossed* order's limit and must revert.
- **Selection determinism (SV-2, TS-3)** — property test: selection converges, is
  inclusion-maximal, never selects a limit-violating order, and is identical across
  permutations of the input.
- **Rounding and dust (CT-12)** — fuzz: `Σ outputs ≤ leg amountOut + crossed volume`;
  dust lands in the fee bucket.
- **Cancel race (CT-7, CT-9)** — a cancel landing in the Sync block before `settleWindow`
  shrinks the selection and never reverts it.
- **Leg parity** — on-chain leg construction (CT-9) equals the settler's (SV-2) for
  identical inputs.
- **`latestPrice()` (CT-14)** — equals the last settlement's `referencePriceX96` and ages
  correctly.
- **Replay equals live (IX-1, TS-5)** — the frontend cannot tell a recorded run from live.
- **Adversarial settler (TS-3, EC-4)** — a settler that omits fillable orders is caught by
  the reconciler's audit and surfaces as `selection_omitted_total`.

## Two test patterns

**Unit tests** — pure logic, no infrastructure: Solidity unit/fuzz tests in
`contracts/test/`, Rust `#[cfg(test)]` modules beside the window builder, reducer tests in
the frontend. Fast; run on every `make check`.

**Integration tests** — real subsystems: Foundry fork tests against real Uniswap v3 pools
via `vm.prank(zoneProxy)`; settler restart-mid-window and known-dropped resubmission
against the enclave; the scenario failure matrix; headless e2e against recorded fixtures.

Use unit tests for anything expressible as a pure function (selection, pricing, fee
arithmetic, schema reducers). Use integration tests for behaviour that needs the enclave,
a fork, or the full stream.

## Lint

- Solidity: `forge fmt --check`; `solc 0.8.34`, `via_ir`, `optimizer_runs 200`.
- Rust: `cargo fmt --check` + `cargo clippy -- -D warnings`. Fix warnings; a targeted
  `#[allow]` needs a one-line reason. Never silence globally.
- TypeScript: the package's `npm run lint`.
- Python: `ruff check .` (line length 100).

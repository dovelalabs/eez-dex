# eez-dex

A unified-liquidity DEX on the eez synchronous L1↔L2 framework (`eez-rollup0`). L2 users
trade against a working copy (the **mirror**) of a real mainnet Uniswap v3 pool at L2 cost.
Each **window** of fills is netted on L2 and its *residual* settles against the real pool
in one atomic cross-layer transaction per L1 slot. Ethereum settles every 12 s, the zone
every 2 s — the product is that cadence arbitrage.

## Quality gate

```bash
make check      # every package's lint + tests. Must pass before every commit.
```

Each package appends its own target to `check`. Package-specific verification comes after
`make check`, never instead of it. See `.claude/rules/testing.md`.

## Requirements are the source of truth

The design is specified in **RD-2 (`REQUIREMENTS.md`)**, a standalone requirements document
in which every requirement carries a stable ID:

| Prefix | Area | Prefix | Area |
|---|---|---|---|
| `FL-*` | window flow | `IX-*` | indexer |
| `CT-*` | contracts | `FE-*` | frontend |
| `SV-*` | settler service | `EC-*` | economics |
| `HX-*` | harness / scenario | `TS-*` | tests |
| `UP-*` | upstream hooks (eez-rollup0) | `RL-*` | repository |

Implement the ID as written — not a superset, not an interpretation. Cite IDs in commit
bodies, PR descriptions, and test names (RL-3). If a requirement is ambiguous, ask before
building. If the framework seems to need a change, that is an open question for the
maintainers, not a commit (RL-2).

## Two build profiles, one codebase

Profile is **configuration, never a fork**. Requirements are tagged **[full]** or
**[genesis]** where they differ.

- **Full form** — Kurtosis devnet, bidirectional calls. Bought assets are delivered into
  L2 balances inside the settlement frame through the DEX's own `DexBridge` (L1) /
  `DexBridgeL2` (L2) pair. This is what the demo shows.
- **Genesis form** — production chain at launch, atomic L2→L1 calls only. Users pay zone
  ETH as call `value` and receive the bought asset at an L1 address. Every order sells
  ETH, so there is no opposing flow and no crossing; the benefit is gas amortisation only.

## Layout

| Path | Package | Verify |
|---|---|---|
| `contracts/` | Foundry — `WindowBook`, `Mirror`, `SettlementRouter`, Uniswap v3 adapter, `DexBridge`, `DexBridgeL2`, mocks | `forge test` |
| `settler/` | Rust crate `eez-dex-settler` — watcher, window builder, submitter, reconciler over one state store | `cargo test` |
| `scenario/` | `dex-scenario.sh`, external ops (`place`, `cancel`, `drift`), failure matrix, recorded-run fixtures | `scenario/dex-scenario.sh` |
| `indexer/` | Read-side gateway: JSON-over-WebSocket stream + REST snapshot; typed event schema (TypeScript) | `npm test` |
| `frontend/` | Trading UI + window theater; demo / replay / observe modes | `npm run ci` |
| `FRAMEWORK_COMMIT` | The single pin of eez-rollup0 (and, by gitlink, the eez-core-protocol tag) from which the Foundry remapping, cargo `git+rev`, and Kurtosis reference are generated | bump = one deliberate commit |

Solidity `0.8.34`, `via_ir`, `optimizer_runs 200` for bytecode parity with the framework.
Foundry remaps to the pinned `eez-core-protocol` tag — never to rollup0's devnet contracts.

Build order: scaffold → WP-1 (L1 router) / WP-2 (L2 book) / WP-B (bridge) → WP-3 (settler)
→ WP-4 (scenario; needs WP-U upstream hooks) → WP-5 (indexer) → WP-6 (frontend).
One work package per branch; see `.claude/rules/commits.md` for names.

## Load-bearing invariants — never weaken

- **The contract is the last check.** `WindowBook.settleWindow` builds the leg, derives the
  price band, and enforces every order's `minBuyAmount` on-chain (CT-9, CT-10). The settler
  cannot fill anyone at a worse — or better — price than the L1 leg achieved. A violation
  reverts the whole transaction, which is poison-evicted at zero L1 cost.
- **Per-asset escrow invariant** (CT-13) at every L2 safe head:
  `Σ open escrow + Σ fees + Σ dust == Σ deposits − Σ released − Σ withdrawn`.
- **Determinism.** Window selection is a pure function; ties and drop order resolve by
  ascending order id; identical inputs produce identical selections on any settler (SV-2).
  **No LLM in the control path.**
- **Prices** are B per A in Q96 regardless of `Side`; all price arithmetic via `mulDiv`;
  per-order outputs round down; dust accrues to the protocol fee bucket (CT-2, CT-12).
- **Deadlines are L1 timestamps.** The L1 head is not visible from L2; mirror age is
  `(block.timestamp − mirrorTimestamp) / 12` (CT-1, CT-8).
- **One settlement in flight per window** (SV-3). In-flight vs known-dropped is explicit
  state, never inferred from a timer alone (SV-5).
- **Order ids are derived on-chain** as `keccak256(owner, nonce)`, never user-supplied (CT-7).

## Do not touch

- **`eez-rollup0`** — off-limits except WP-U's harness hooks (UP-1 … UP-3), which live on a
  branch in that repo. Never the composer, held pool, front, proof signer, deriver, or
  registry.
- No inventory, market-making, or L2 liquidity buffer — the DEX holds no working capital.
- One venue (Uniswap v3), one ETH-quoted pair family at launch. A second venue is a new
  adapter, not a router change (CT-3).
- No mainnet deployment; a public testnet is the rehearsal.

## Conventions

- Commits: `type(scope): description`, `make check` before each — `.claude/rules/commits.md`
- Tests: every feature has a test, every fix a regression test — `.claude/rules/testing.md`
- Review gate before any PR — `.claude/rules/review-gate.md`
- Draft PRs to `main` with an Agent Run Report — `.claude/rules/pull-requests.md`

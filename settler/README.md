# `eez-dex-settler` — the off-chain half of one window

WP-3 of RD-2. Four tasks over one state store: **watcher** reads the open
window and the L1 head, **builder** crosses, simulates against that head and
selects the fillable subset, **submitter** posts exactly one settlement per
window to the L2→L1 front, **reconciler** matches the outcome and audits it.

Two properties hold everywhere in the crate:

- **Determinism.** Selection is a pure function of its inputs; ties and drop
  order resolve by ascending order id, so any two settlers with the same inputs
  produce the same selection (SV-2). No LLM in the control path.
- **The settler is not the last check.** It never holds user funds and its
  selection is a *suggestion*: `WindowBook.settleWindow` takes order ids,
  rebuilds the leg itself, and enforces every limit (CT-9, CT-10). What the
  settler owes is liveness and fairness, and both are observable on-chain
  (EC-4).

## Layout

| Module | What it is |
|---|---|
| `config` | **Frozen at the scaffold.** A.5's configuration keys and metric names. |
| `types` · `math` · `mirror` | The Rust twins of `Types.sol` and `Mirror.sol` — the same curve, the same rounding, the same `mulDiv`. |
| `abi` | `sol!` bindings generated from `contracts/src/**`. |
| `window` | The Rust twin of `WindowBook`'s private settlement functions: fees, cross and residual, the CT-9 price band, the fill distribution. Pure. |
| `selection` | FL-8's loop: build, simulate, drop limit-violating orders, re-simulate, re-add to a fixed point. Pure. |
| `attempt` | SV-3 and SV-5 as a state machine: one settlement per window, in-flight versus known-dropped. |
| `state` | The one store the four tasks share (SV-1). |
| `metrics` | A.5's metrics, under the frozen names. |
| `chain` | Every chain access, behind a trait. |
| `watcher` · `builder` · `submitter` · `reconciler` | The four A.5 tasks. |
| `stream` | The settler's state projected into the frozen IX-2 event schema. |

## Running it

Every key is A.5's, parsed once and whole, so a misconfigured deployment fails
at startup rather than at the first slot boundary.

```bash
export L1_RPC=http://127.0.0.1:8545        # the L1 head, pool state, eth_call
export L2_RPC=http://127.0.0.1:9545        # WindowBook logs and the safe head
export L2_FRONT=http://127.0.0.1:9547      # settleWindow MUST be sent here
export WINDOW_BOOK=0x…                     # WindowBook on L2
export ROUTER=0x…                          # SettlementRouter on L1
export POOL=0x…                            # the target Uniswap v3 pool
export SETTLER_KEY=0x…                     # signs offline; never leaves the process

cargo run --release
```

Optional keys and their launch defaults: `FEE_BPS=1` (or `FEE_FIXED`),
`ROUTE_FEE_MODEL=absorb`, `WINDOW_SLOTS=2`, `FLOW_THRESHOLD=4`,
`MIRROR_REFRESH_AGE=5`, `DEADLINE_SECONDS=24`, `L1_GAS=1000000`,
`WINDOW_HALT=3`, `MAX_USER_TXS_PER_BUNDLE=3`, `MIN_WINDOW_NOTIONAL=0`, and
**\[full\]** `DEX_BRIDGE_L1` / `DEX_BRIDGE_L2`. Setting the bridge pair is what
selects the full profile — profile is configuration, never a fork.

`RUST_LOG=eez_dex_settler=debug` turns on the per-tick line.

## Tests

```bash
make check                 # the gate: lint and the whole suite, offline and fast
cd settler && cargo test   # the same suite on its own
```

TS-3's named suites:

Cargo takes one filter as a positional argument and several after `--`:

```bash
cargo test selection_is_deterministic_across_permutations -- --nocapture
cargo test leg_parity_matches_onchain_fixture
cargo test adversarial_settler_is_detected
cargo test -- restart_mid_window known_dropped_resubmission
```

`leg_parity_matches_onchain_fixture` asserts the builder's `WindowLeg` against
`contracts/test/l2/fixtures/leg-parity.json`, the same fixture WP-2 asserts its
on-chain construction against — so the two sides are compared to the wei rather
than to each other's prose.

### The enclave suite

`restart_mid_window` and `known_dropped_resubmission` exist twice: in
`tests/service.rs`, against the fake chains, on every `make check`; and in
`tests/enclave.rs`, against a real enclave, behind the `enclave` feature. The
in-process pair proves the logic; the enclave pair proves the settler reads the
real thing correctly, with the framework's timing rather than the test's.

```bash
# 1. bring up an enclave with the DEX deployed (WP-4, once it lands):
scenario/dex-scenario.sh --up

# 2. point the settler at it and run the gated suite:
export L1_RPC=… L2_RPC=… L2_FRONT=… WINDOW_BOOK=0x… ROUTER=0x… POOL=0x… SETTLER_KEY=0x…
cargo test --features enclave -- restart_mid_window known_dropped_resubmission
```

The feature is opt-in and the suite fails loudly, naming the missing key, if the
configuration is not there: a suite that silently passed without an enclave
would be worse than no suite. It is not part of `make check` — it needs
Kurtosis and Docker, and it runs at the chain's own pace.

## Known gaps

- **CT-6's empty settlement has no path on L2.** SV-3 has the settler submit a
  mirror refresh when an empty window's mirror ages past `MIRROR_REFRESH_AGE`,
  and the submitter does exactly that. `WindowBook.settleWindow` currently
  reverts `NothingToSettle` on an empty selection (`WindowBook.sol:487`), so
  the refresh cannot land until WP-2 gains CT-6's zero-residual path. The
  revert happens before any L1 call, so it costs L2 gas and nothing else —
  escrow is untouched and the window stays open. Raised against Phase 2b rather
  than worked around here (RD-2 RL-2).
- **The framework crates are not linked.** SV-1 asks the settler to reuse the
  node's RPC and signing crates at the `FRAMEWORK_COMMIT` pin. `eez-l1` and
  `eez-protocol` depend transitively on reth from a git revision, which would
  make resolving this crate's lockfile a multi-gigabyte fetch and `make check`
  slow enough to stop being a gate. What is pinned instead is the *same alloy
  stack at the majors the node resolves*, and the settler's chain access is
  plain JSON-RPC, so no framework type crosses the boundary. Worth revisiting
  when the framework publishes a thin client crate.

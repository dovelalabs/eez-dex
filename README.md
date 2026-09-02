# eez-dex

A unified-liquidity DEX on the [eez](https://github.com/dovelalabs/eez-rollup0)
synchronous L1↔L2 framework. L2 users trade against a working copy — the **mirror** — of a
real mainnet Uniswap v3 pool, at L2 cost. Each **window** of fills is netted on L2 and only
its *residual* settles against the real pool, in one atomic cross-layer transaction per L1
slot.

The mechanism is a cadence arbitrage. Ethereum settles every 12 seconds and the zone
produces a block every 2, so one window of cheap trading fits inside one L1 slot. One
mainnet transaction is amortised over every fill in that window, and the funds never leave
mainnet custody except inside that atomic frame. A settlement that would revert is evicted
before it is posted: no mainnet gas, no partial fills, escrow untouched, orders still open.

The window clears at a single reference price — the pool's spot read inside the L1 leg
immediately before the swap — and the residual's realised impact is borne by the residual
side alone. Nobody is filled outside their limit: the contract, not the settler, is the
last check.

## Two build profiles, one codebase

Profile is configuration, never a fork.

| | Runs on | What differs |
|---|---|---|
| **Full form** | A Kurtosis devnet with bidirectional calls | Bought assets are delivered into L2 balances inside the settlement frame, through the DEX's own `DexBridge` / `DexBridgeL2` pair. |
| **Genesis form** | The production chain at launch, atomic L2→L1 calls only | Every order sells zone ETH and the bought asset is delivered at an L1 address. There is no opposing flow and no crossing; the benefit is gas amortisation alone. |

## Packages

| Path | What | Verify |
|---|---|---|
| `contracts/` | Foundry: `WindowBook` and `Mirror` (L2), `SettlementRouter` and the Uniswap v3 adapter (L1), the bridge pair, and the shared types every package compiles against | `forge test` |
| `settler/` | Rust crate `eez-dex-settler`: watcher, window builder, submitter and reconciler over one state store | `cargo test` |
| `scenario/` | The enclave scenario, the external ops, the failure matrix and the recorded-run fixture | `scenario/dex-scenario.sh` |
| `indexer/` | The read-side gateway and the typed event schema: one JSON-over-WebSocket stream plus a REST snapshot | `npm test` |
| `frontend/` | The trading UI and the window theater; demo, replay and observe modes | `npm run ci` |
| `scripts/` | The framework pin, the acceptance suite (`verify.sh`) and the demo (`demo.sh`) | `scripts/verify.sh` |

`FRAMEWORK_COMMIT` is the single pin of the framework. The Foundry remapping, the settler's
cargo `git+rev` dependency and the Kurtosis package reference are all generated from it by
`scripts/framework-pin.sh`; bumping it is a deliberate, single commit.

## Build

```bash
git clone --recurse-submodules <this repo>
cp .env.example .env          # endpoints, addresses, and the launch parameters
make check                    # lint and every package's tests — the gate
```

`make check` is the hard gate: it must pass before every commit. Package-specific
verification runs after it, never instead of it.

```bash
make pin                      # regenerate every framework reference
make contracts-fork           # the mainnet-fork suite; needs a real ETH_RPC
make scenario                 # the enclave scenario; needs Kurtosis and Docker
make fix                      # format and auto-fix everything lint checks

scenario/dex-scenario.sh --self-test   # the scenario's hermetic half; no enclave
scenario/dex-scenario.sh --matrix      # appendix A.6's failure matrix
```

## The acceptance criteria, as one command

```bash
scripts/verify.sh             # every acceptance criterion, with its evidence
```

Each criterion is one line: `PASS`, `FAIL`, or `SKIP` — and `SKIP` is not a soft
pass. A row that cannot be asserted on this machine names what is missing (a
mainnet RPC, a Kurtosis runner, a browser) and the whole run reports
**INCOMPLETE** rather than green. Every row also carries the *tier* its evidence
came from, because the same claim is worth different amounts at different tiers:

| Tier | What it means |
|---|---|
| `unit` | the package suites: contracts, settler, indexer, frontend |
| `frame` | both chains in one EVM: the real router, the real bridge, the framework's own `CrossChainProxy` |
| `recorded` | the committed recorded runs — what a devnet run produced |
| `simulated` | the seeded soak against the settlement oracle; no chain |
| `fork` | real Uniswap v3 pools at a pinned block |
| `enclave` | Kurtosis: the composer, the bundle, four processes at once |

`scripts/verify.sh --enclave` includes the rows that need a running devnet;
`--fast` skips re-running `make check`.

## The demo

```bash
scripts/demo.sh               # enclave, settler, indexer and frontend, together
```

One command brings up the devnet, deploys both halves, starts the settler and
the read-side gateway, and serves the trading UI at
`http://127.0.0.1:5173/?mode=demo`. The window theater draws the orders arriving,
the cross at the boundary, the residual descending to the L1 lane as one
transaction, and the fresh mirror coming back. The director's three controls are
in the UI on the devnet profile and compiled out everywhere else; the same ops
are a command away:

```bash
scenario/dex-scenario.sh --op place --count 8    # a burst of orders
scenario/dex-scenario.sh --op drift --bps 50     # move the pool mid-window
scenario/dex-scenario.sh --op stall --slots 2    # stall the builder
```

Ctrl-C stops all four and removes the enclave. Needs Kurtosis, Docker and the
framework's images; `scenario/README.md` says how to build them.

Without any infrastructure at all:

```bash
cd frontend && npm run dev -- --open '/?mode=replay'
```

replays a recorded run from `scenario/fixtures/`, and the frontend cannot tell
it from a live one.

## Running it

`docs/OPERATIONS.md` is the operator's page: the configuration keys, the two
metrics that must read zero, and what a window halt means.

## Status

Every package has landed: `SettlementRouter` and the Uniswap v3 adapter on L1,
`WindowBook` and `Mirror` on L2, the `DexBridge` pair, the settler's four tasks,
the enclave scenario with the failure matrix and the recorded runs, the read-side
gateway, and the trading UI with its three modes. `make check` is green and
`scripts/verify.sh` reports where every acceptance criterion stands.

Two things are deliberately not built, and the code says so where it matters:
the settler serves no socket, so the gateway's settler upstream is absent and
the price band, evictions and rollbacks are reported as unavailable rather than
guessed; and the enclave rows run only where a Kurtosis runner is configured.

## Licence

MIT.

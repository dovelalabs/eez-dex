# eez-dex

A unified-liquidity DEX on the [eez](https://github.com/eez-association/eez-rollup0)
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
```

## Status

The repository is at the scaffold. The shared types, the contract interfaces, the test
fixtures, the event schema and the settler's configuration are frozen and tested; every
product module is a stub that names the phase that owns it. `make check` passes on the
stubbed tree.

## Licence

MIT.

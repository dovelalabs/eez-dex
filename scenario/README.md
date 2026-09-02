# scenario — the enclave scenario and failure matrix

**WP-4 of RD-2.** Brings the whole system up in the framework's Kurtosis
enclave, drives scripted order flow through it, and asserts appendix A.6: a
happy path, thirteen failure rows, and a 200-slot soak. It also emits the
recorded run Phase 5 replays offline (HX-5).

The failure matrix *is* the integration suite. Two of its rows are what
distinguish this system from a batch auction with extra steps, and they are
deliberately kept apart:

- **Poison eviction costs zero L1 gas.** The composed transaction reverts at
  compose time, so no L1 transaction ever exists. The window stays open and
  every escrow is intact.
- **The raced pool move is a rollback, not an eviction.** The L1 entry was
  included and then *skipped* at `postBatch`: the batch landed without it, the
  framework rolled the Sync block back — and **the L1 gas was spent**. That row
  asserts the gas, because it is the only difference between the two that costs
  money.

## Running it

```bash
scenario/dex-scenario.sh                      # A.6's happy path (HX-2)
scenario/dex-scenario.sh --matrix             # the full failure matrix (HX-3)
scenario/dex-scenario.sh --matrix --pr        # the rows CI runs on every PR
scenario/dex-scenario.sh --matrix --row poison_eviction
scenario/dex-scenario.sh --soak --slots 200 --seed 1   # the window soak (HX-4)
scenario/dex-scenario.sh --record             # rewrite the HX-5 fixtures
scenario/dex-scenario.sh --self-test          # the hermetic half; no enclave
```

`--keep` leaves the enclave up for inspection. `--profile genesis` selects the
other build profile (RD-2 §1: profile is configuration, never a fork), which
skips the `[full]`-only bridge row and asserts L1 balances instead of L2 ones.

### What an enclave run needs

- Linux with Docker, the [Kurtosis CLI](https://docs.kurtosis.com/install/),
  Foundry (`cast`, `forge`, `anvil`), Node ≥ 22.18, `jq`, and Rust for the
  settler.
- The framework's `:ci` images already built. **A remote Kurtosis run evaluates
  `main.star` directly and never runs the framework's `start.sh`, so it builds
  nothing** (UP-3). Build them once:
  ```bash
  cd <eez-rollup0>
  bash testing/kurtosis/start.sh testing/kurtosis/ci-args.yaml
  bash testing/kurtosis/stop.sh
  ```
- This repository's deployment bundle:
  ```bash
  scenario/bundle/build.sh
  ```

`dex_preflight` checks all of it and names what is missing before Kurtosis
spends five minutes discovering the same thing.

### What `--self-test` needs

Foundry, Node and `shellcheck`. No Docker, no network, no enclave. This is the
half that runs on every pull request, and it covers:

- shellcheck over every script under `scenario/` — `make lint-scenario` only
  globs `scenario/*.sh`, and most of this package is below that
- the settlement oracle, the recorder and the A.6 assertions (`npm run ci`)
- the three `ext:` ops against UP-2's output contract, driven end to end
  against a stubbed `cast`
- the UP-1 bundle and the UP-3 args file against the seam they consume
- the committed HX-5 fixtures against the frozen `indexer/schema/`
- **`MockPool`'s curve against `MockPool` itself**: deployed to a local anvil
  and swapped through the real `UniswapV3Adapter`, comparing output, price and
  tick in both directions across five sizes

## How it is put together

```
dex-scenario.sh        the entry point: modes, bring-up, teardown
args/dex-args.yaml     the UP-3 args file — the framework's profile, plus the bundle
bundle/                the UP-1 external deployment bundle (HX-1)
ops/                   the UP-2 external ops: place, cancel, drift (HX-3)
lib/*.sh               the enclave, the L2 deployment, the settler, the waves, the matrix
lib/*.ts               the oracle, the recorder, the observer, the assertions
fixtures/              the HX-5 recorded runs — see fixtures/README.md
test/                  the hermetic self-test and the MockPool parity check
accounts.env           the identities the ops sign with and the fixtures expect
```

**The shell induces and observes; it decides nothing.** Every assertion lives
in `lib/assert.ts` and is made against `lib/book.ts`, which recomputes the
settlement — the fees, the cross and residual, the price band, the L1 swap and
every fill — from the window's own inputs. Three sources have to agree: what
the chain said (the recorded run), what the chain is (the readings), and what
should have happened (the oracle).

That split is the point. "Every crossed order filled at `referencePriceX96`",
checked by reading the number back out of the event it was emitted in, would
pass against a contract that had quietly changed its mind. And because the
oracle is pure, most of this work package is exercised by `--self-test`, which
CI runs on every pull request, rather than only on the nights the enclave runs.

### The seams it consumes

| Hook | What this repository supplies |
|---|---|
| **UP-1** external deployment bundle | `bundle/` — an image layered on the framework's deploy image, running the framework's deploy first and appending the DEX's bindings to the same `deployments.env`. Six env vars in, one artifact out. |
| **UP-2** `ext:` wave ops | `ops/place.sh`, `ops/cancel.sh`, `ops/drift.sh`. Each prints one raw signed transaction and the side to submit it on, or nothing to decline the wave. |
| **UP-3** `run(plan, args)` | `args/dex-args.yaml` and `lib/enclave.sh`, which brings the enclave up by the locator `FRAMEWORK_COMMIT` generates. |

### The addresses, and why the order matters

The UP-1 step runs **before the node starts**, so there is no L2 to deploy on.
The bundle predicts `DexBridgeL2` and `WindowBook` from the DEX deployer's L2
nonce and constructs `SettlementRouter` against them; `dex-scenario.sh` then
deploys the L2 half and **stops the run** if either lands anywhere else.

```
L2 nonce 0   DexBridgeL2 implementation
L2 nonce 1   its ERC-1967 proxy          -> DEX_BRIDGE_L2
L2 nonce 2   WindowBook                  -> DEX_WINDOW_BOOK
```

`registerToken` sits between 1 and 2 but is sent by governance, so it does not
move the deployer's nonce. **Nothing else may ever sign from that account.**

### The pair

A is the pool's `token0` and the rail's native asset — zone ETH on L2,
`MockWETH` on L1. B is an ERC-20 that reaches L2 through the DEX's own bridge
(CT-5, CT-11), which is also how the traders are funded: one `DexBridge.deposit`
through the L1 front both creates the L1 reserve and credits eight L2 balances
in the same frame.

Prices are B per A in Q96 regardless of `Side` (A.1). The bundle deploys B
repeatedly until it sorts above A, so A really is `token0` and that convention
holds without a special case.

The pool is the 0.05% fee tier, the deepest mainnet ETH pool's and the one
ER-2's density baseline is measured against. It matters to every limit in the
scenario: a residual-side order can never be filled inside a tolerance tighter
than the fee its swap pays.

## Order flow is planned, never improvised

The ops decide nothing. The scenario writes one file per wave per op kind under
`.plan/`, and each op instance emits the line for its slot:

```
.plan/wave-3.place    <trader> <side> <sellAmount> <minBuyAmount> <expiresAfter>
.plan/wave-3.cancel   <trader> <orderId>
.plan/wave-3.drift    <sqrtPriceX96> [priorityBoost]
```

The soak's plan is a pure function of its seed, printed at the start of every
run and written to `.run/soak-plan.json`. A soak that fails at slot 173 is
re-run with `--soak --slots 200 --seed <the same seed>`; a soak that could not
be re-run would not be a test.

## What is observed and what is derived

An assertion built on a derived number is only as good as the derivation, so
`lib/observe.ts` states it field by field:

| Field | Where it comes from |
|---|---|
| orders, fills, every deduction | `WindowBook` logs, decoded |
| `WindowResult` | the `WindowSettled` log |
| the leg's `residualIn` | `result.amountIn` — CT-9 makes them the same number |
| the leg's `deadline`, the settler's selection | `settleWindow`'s calldata |
| the leg's `residualSide` | the side whose fills carry impact; only the residual side pays it (CT-12) |
| the leg's price band | recomputed from the filled orders — the contract does not emit it |
| the states the leg was built against | snapshotted every L2 block, never inverted out of the result |
| the L1 receipt | the batch transaction in `result.l1Block` |
| evictions and rollbacks | marks the harness wrote when it induced them, each carrying its evidence |

## The failure matrix

| Row | Induced by | Asserts |
|---|---|---|
| `mid_window_drift` | `drift` after placement | the subset inside limit fills; the rest stay open |
| `all_outside_limit` | a larger `drift` | nothing fills; the mirror refreshes |
| `empty_window` | no orders, waited past `MIRROR_REFRESH_AGE` | a CT-6 refresh with a zero swap |
| `poison_eviction` | a same-block move the leg cannot satisfy | **zero L1 gas**, window open, escrow intact, next window settles |
| `bundle_not_included` | the builder stopped for two L1 blocks | settled then rolled back; fills undone; resubmission lands |
| `raced_pool_move` | a higher-priority `drift` in the bundle's block | a rollback, not an eviction — **and the L1 gas is asserted** |
| `missed_l1_slot` | the canonical EL paused for a slot | the window stretches; no eviction; settles inside `DEADLINE_SECONDS` |
| `short_bridge_reserve` **[full]** | the bridge paused | `release` reverts, the frame is evicted, no L1 gas |
| `cancel_in_sync_block` | `cancel` in the settlement's wave | N−1 fills, no revert, escrow released |
| `favourable_move_breaks_crossed_limit` | a move in the residual's favour | the band reverts the leg rather than filling outside a limit |
| `settler_restart_mid_window` | stop/start between selection and submission | exactly one settlement, no duplicate |
| `shared_slot` (TS-4) | the framework's own `out:set` in the same slot | both ride the bundle inside the cap; the DEX is unaffected |
| `window_stall` | the proof signer paused past `WINDOW_HALT` | the settler halts and accepts nothing while halted |

## Known limits

- The enclave rows have not been run on this machine: they need Linux with
  Docker and Kurtosis, and the framework's `:ci` images. Everything that does
  not need a network is exercised by `--self-test`, including the curve parity
  check against the real contract.
- The committed HX-5 fixtures are generated by the settlement oracle, not by an
  enclave. `--record` rewrites them from a real run through the same recorder;
  `fixtures/README.md` records which of the two produced the files on disk.
- The settler publishes its A.5 metrics into an in-process registry and no
  further (`settler/src/metrics.rs`), so the scenario derives the same figures
  from the chain rather than reading them. That is the right thing for an audit
  (EC-4) but it means `fills_per_settlement` is asserted against the harness's
  own count, not the settler's. A metrics endpoint on the settler would let the
  two be cross-checked; that is a note for WP-3, not a change here.

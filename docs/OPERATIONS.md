# Running eez-dex

The operator's page: what to set, what to watch, and what to do when the settler
halts. Everything here is RD-2's — appendix A.5 for the keys and the metric
names, SV-4 for the halt, EC-4 for the two numbers that must read zero.

## Configuration

Every key the settler reads is in `.env.example`, with the launch value and the
requirement it comes from. Copy it to `.env` and set the four that have no
sensible default:

| Key | What it is |
|---|---|
| `L1_RPC` | Ethereum. The settler reads the head and simulates the leg here with `eth_call` (SV-2). |
| `L2_RPC` | The zone. `WindowBook` logs and the safe head. |
| `L2_FRONT` | The L2→L1 front. **`settleWindow` must be sent here**, not to the plain L2 RPC: it is the endpoint that opens the atomic cross-layer frame (A.2, SV-3). |
| `WINDOW_BOOK` · `ROUTER` · `POOL` | The three addresses. The book on L2, the router on L1, and the pool the mirror copies. |
| `SETTLER_KEY` | Signs settlements offline. A liveness-and-fairness role, never a custody one: escrow lives in `WindowBook` and the contract enforces every limit (CT-10, EC-4). Rotatable on-chain with `setSettler`. |

The parameters that change behaviour rather than wiring:

| Key | Launch value | What moving it does |
|---|---|---|
| `FEE_BPS` | `1` | The protocol fee, basis points of notional. **The ceiling is derived from measured gas** (EC-1): above it the median user is worse off than a direct swap. See the gas table in the pull request that shipped this build before raising it. |
| `ROUTE_FEE_MODEL` | `absorb` | Who pays the L1 leg's gas. `recover` splits it pro-rata across the window's fills — the high-gas fallback. |
| `MIN_WINDOW_NOTIONAL` | `0` | A window below this does not settle until it grows or times out. At measured gas the useful setting is ~$1.3k; it rarely binds, and it is what keeps the protocol solvent if gas returns to 5+ gwei. |
| `WINDOW_SLOTS` · `FLOW_THRESHOLD` | `2` · `4` | How many L1 slots a window spans (EC-6). Two below the flow threshold, one above it. The settler decides at the boundary and **says so in the log**; the change itself is `setWindowSlots`, which is the owner's call. |
| `MIRROR_REFRESH_AGE` | `5` | Mirror age in slots above which a quiet window submits a CT-6 refresh — one cross-layer call and no swap. Quote demand is not observable on-chain, so this threshold is the only trigger there is. |
| `DEADLINE_SECONDS` | `24` | Added to the Sync block's timestamp to form the leg's deadline, checked on L1 against `block.timestamp` (CT-1). A settlement unseen after this long is *known dropped*, not merely late (SV-5). |
| `L1_GAS` | `1000000` | Explicit gas for the L1 leg; the settler never estimates in flight. Measured settlement gas is 196k–291k depending on residual size and pair. |
| `WINDOW_HALT` | `3` | Consecutive unposted windows after which the settler halts. See below. |
| `MAX_USER_TXS_PER_BUNDLE` | `3` | Must equal the node's `EEZ_MAX_USER_TXS_PER_BUNDLE`. It is env-only upstream and cannot be read from chain or RPC (EC-5), so a mismatch is silent until a bundle is over the cap. |
| `DEX_BRIDGE_L1` · `DEX_BRIDGE_L2` | — | **[full]** only. Unset in the genesis form, where the rail's native value path carries ETH and there is no ERC-20 leg. |

## The two numbers that must be zero

The settler publishes appendix A.5's metrics and checks two of them on every
tick. Either being non-zero is logged at `error` with the metric named:

**`escrow_invariant_drift_wei` (CT-13).** Per asset, at every L2 safe head:

```
Σ open escrow + Σ fees + Σ dust + Σ credited == Σ deposits − Σ released − Σ withdrawn
```

`WindowBook.escrowInvariantDrift(asset)` returns it, so it is readable from any
node with one `eth_call` and needs no service. A non-zero value means value has
moved outside the ledger — **stop settling and investigate before anything
else**; nothing else on this page matters while it is non-zero.

**`selection_omitted_total` (EC-4).** The reconciler recomputes the
inclusion-maximal selection from the settled `P0` and counts any order that was
fillable and left out. It is the audit that makes the settler a liveness role
rather than a trusted one: the contract already stops a *bad* fill (CT-10), and
this catches a *missing* one. Non-zero means the settler is not selecting what
it should — a bug or an operator playing favourites.

Beside them, the numbers that say whether the product is working rather than
whether it is safe: `fills_per_settlement`, `netting_ratio` (`1 − |residual| /
gross`), `roll_rate`, `gas_per_fill_wei` against `counterfactual_l1_gas_wei`,
`impact_bps`, `mirror_age_slots`, and `window_slots`.

The settler holds no socket and serves nothing (it is a service, not a
gateway), so today these are read from its log. The read-side gateway carries
the same names in its snapshot when it is given a settler endpoint to read;
until something serves that projection, the gateway reports its settler
upstream as **absent** and leaves the fields it alone could fill — the price
band, evictions, rollbacks — null rather than guessing them.

## `WINDOW_HALT`

A window is *unposted* when its settlement did not land on L1: it was
poison-evicted at compose time, or it was rolled back. A settled window clears
the counter; an empty window never touches it, because nothing failed to post —
there was nothing to post. One eviction is ordinary and by design free.
`WINDOW_HALT` of them in a row is not, and the settler stops:

- it logs at `error` with the count, and
- **accepts no further settlements** while halted.

That is deliberate. In-flight versus known-dropped is explicit state, never
inferred from a timer alone (SV-5), and a settler that kept submitting into a
rail that is not posting would burn windows and confuse the reconciler about
which attempt is live.

Nothing user-visible is lost by halting: orders stay open with their escrow
intact, and the next window settles them when the rail recovers. Clearing the
halt is a restart, after the reason the batches stopped landing has been fixed —
the builder, the proof signer, or the front.

## Checking a deployment

```bash
scripts/verify.sh                # every acceptance criterion, with its evidence
scripts/verify.sh --enclave      # including the rows that need a running devnet
make contracts-fork              # the leg against real pools at a pinned block
```

`scripts/verify.sh` prints `PASS`, `FAIL` or `SKIP` per criterion and the tier
each was checked at. A `SKIP` makes the run INCOMPLETE, not green.

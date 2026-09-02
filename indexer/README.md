# `indexer/` — the read-side gateway

**RD-2 WP-5 · IX-1, IX-2, IX-3.** One small read-only service that folds three
upstream views into a single typed stream, and that serves a recorded run so
the frontend cannot tell replay from live.

It **holds no keys and exposes no write path.** Every chain call it makes is an
`eth_` read. The one exception is the demo director's control proxy, which
exists on the devnet profile and nowhere else (see below).

```bash
npm test            # the package's own suite (make check runs it)
npm run start -- --replay ./test/fixtures/run.json --speed 1
npm run start -- --l2 http://127.0.0.1:8545 --book 0x… --l1 http://… --settler http://…/state
```

## What it serves

| Route | What |
|---|---|
| `GET /snapshot` | windows, orders, settlements, the mirror, the A.5 metrics, and IX-3 per settlement and cumulative |
| `GET /health` | the stream's own state: mode, activity, and every upstream's health |
| `GET /events?since=N` | events after `N`, for a reconnect or FE-10's scrubber |
| `ws://…/stream` | `snapshot` first, then `event` frames in sequence, with `status` frames on every change |
| `POST /director/{burst,drift,stall}` | **devnet only** — see below |

The frames are typed in `src/protocol.ts`; everything inside an `event` frame
is the frozen schema in `schema/`, which this branch does not touch.

## The three upstreams, and what each is the only source of

| Upstream | Carries | Absent means |
|---|---|---|
| **L2 RPC** | `WindowBook`'s five events, the views, the safe head | no stream at all |
| **L1 RPC** | the settlement's receipt, and the sampled receipts IX-3's counterfactual is measured from | no L1 receipt and no amortisation |
| **Settler** | the price band, the selection, evictions and rollbacks | those fields stay null |

The third is a separate upstream because the chain cannot answer it. The leg's
price band is built inside `settleWindow` and never emitted (A.2); an eviction
is the *absence* of a transaction (FL-7); a rollback un-happens the blocks that
carried the logs (SV-4). Where the settler is not configured the stream says
so, in `status.sources`, with what is missing — it never fills those in with a
guess.

**The settler document.** `SETTLER_URL` is expected to serve
`settler/src/stream.rs`'s projection as JSON — it is already the frozen schema,
so this is a boundary check rather than a translation:

```json
{ "window": Window, "orders": [Order], "mirror": MirrorSnapshot,
  "metrics": { "<A.5 name>": number },
  "settlements": [ { ...Settlement, "l1TxHash": "0x…" } ] }
```

Every part is optional. `settlements` carries the reconciler's classification;
the gateway reads the L1 receipt itself and computes IX-3 itself, so a settler
that omits `l1Receipt` and `amortisation` is not a settler that is wrong.

## Honest data

Empty, loading and error are **first-class**, never absent fields (RD-2 §7
preamble). `status.activity` is `loading` before anything is observed, `empty`
when the open window holds no orders — a quiet chain is quiet, not broken —
`active`, or `ended` when a replay reaches the end of its recording. Each
upstream reports `loading | ok | degraded | unavailable | absent` with the
reason attached. Nothing here dresses up silence as activity.

## IX-3, the counterfactual

Per settlement: fills, L1 gas, gas per fill, and what the same fills would have
cost as direct L1 swaps — computed once, here, so the swap panel's cost line
(FE-3) and the theater's counter (FE-6) cannot disagree. Per order, in IX-3's
order: **the gas the user's own address last paid for a swap on L1** where the
sampler observed one, else the **median retail swap gas** from the last sampled
window of L1 receipts. There is no third branch: where nothing was observed the
amortisation is `null`, because a saving quoted against a made-up denominator
is a made-up saving. Both sides are priced at the settlement's own effective
gas price, so the comparison is like for like.

## The director — devnet only

`FE-9`'s controls (a burst of orders, a mid-window price move, a stalled
builder) proxy to WP-4's HX-3 external ops. The absence off devnet is
structural: `server/director.ts` is imported only inside
`profile === "devnet"`, so elsewhere the module is never loaded and the routes
do not exist to be disabled. Within devnet the proxy is narrow — three controls
by name, one integer parameter each inside a stated range, `argv` rather than a
shell string, and no keys.

## Configuration

Flags beat environment variables; both are optional except `WINDOW_BOOK` in
live mode.

| Flag | Variable | Default |
|---|---|---|
| `--l2` | `L2_RPC` | `http://127.0.0.1:8545` |
| `--l1` | `L1_RPC` | unset — no L1, and so no IX-3 |
| `--book` | `WINDOW_BOOK` | — |
| `--settler` | `SETTLER_URL` | unset |
| `--port` / `--host` | `PORT` / `HOST` | `8080` / `127.0.0.1` |
| `--profile` | `PROFILE` | `devnet` (`devnet \| testnet \| mainnet`) |
| `--replay` | `FIXTURE` | unset — live |
| `--speed` | `SPEED` | `1` (`0` is as fast as the socket allows) |
| `--poll` | `POLL_MS` | `2000`, one L2 block |
| `--from-block` / `--history` | `FROM_BLOCK` / `HISTORY_BLOCKS` | head − 2000 |
| `--gas-sample` | `GAS_SAMPLE_BLOCKS` | `50` L1 blocks |
| `--director-command` | `DIRECTOR_COMMAND` | `scenario/dex-scenario.sh` |

## The fixture

`test/fixtures/run.json` is a recorded run covering all four A.4 window
outcomes — settled, an order rolled at the boundary, a poison eviction, and a
settled window rolled back. It is generated by driving the **real live source**
over a scripted chain (`test/script.ts`), so it is by construction what the
live path emits:

```bash
node test/fixtures/build.ts     # regenerate; test/replay.test.ts fails if it drifts
```

WP-4 owns the real HX-5 recording. Both conform to the frozen schema, which is
the arbiter if the two ever disagree.

## No runtime dependencies

Keccak-256, the slice of ABI coding this service decodes with, the JSON-RPC
client and the WebSocket server are all in `src/`, each in the smallest form
that does the job, each tested. Topics and selectors are derived from signature
strings and pinned against `cast sig-event`, so a signature that drifts from
`contracts/src/l2/WindowBook.sol` fails a test rather than quietly decoding
nothing.

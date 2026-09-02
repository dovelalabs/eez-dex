# `frontend/` — the trading surface and the window theater

**RD-2 WP-6 · FE-1 … FE-12.** A static SPA — TypeScript, Vite, React — that is a
**product surface first**: a trading interface real users place orders through,
and a demo second. Nothing in it assumes the demo. Every view renders honest
empty, loading and error states against a live chain where windows are often
quiet.

```bash
npm run dev                     # observe mode against http://127.0.0.1:8080
npm run dev -- --open '/?mode=replay'   # a recorded run, nothing behind it
npm run ci                      # typecheck, unit tests, end-to-end, build
```

## One reducer, one code path

The app is a single reducer over the IX-2 event stream (FE-11). A **source**
pushes frames at it and does nothing else:

| Mode | Source | Trading surface |
|---|---|---|
| `observe` | the IX-1 gateway's socket, live | read-only until a wallet is connected to the chain |
| `demo` | the same socket against a devnet, plus the director | read-only until a wallet is connected |
| `replay` | an HX-5 recording read as a static asset | **disabled** — an order against a recording would be a lie |

Everything downstream of the source is identical, which is what makes the three
modes cheap rather than triplicated — and why a bug cannot live on one of them.
Pointing `observe` at a gateway that is itself replaying is IX-1's other half:
the app cannot tell the difference, because there is nothing in it that could.

```
source ──► Action ──► reduce ──► AppState ──► App
  socket        frame          chain fold     panels
  replay        tick           clock          theater
```

Seeking is folding a prefix of the received events (`state/chain.ts` is pure),
so FE-10's scrubber is not a second playback path.

## What each part is

| Path | What |
|---|---|
| `src/state/chain.ts` | the IX-2 fold, recording every A.4 transition and whether the frozen table allows it |
| `src/state/app.ts` | the app reducer: frames, the clock, the scrubber, the wallet session |
| `src/state/selectors.ts` | the derived views — the cross, the slot clock, drift, IX-3's totals |
| `src/domain/` | Q96 arithmetic, `Mirror.sol`'s curve, EC-1's fee, and the formatting they print in |
| `src/stream/` | the socket source, the replay source, and the version check at the door |
| `src/ui/` | the panels, and one token set for light and dark |
| `src/wallet/` | EIP-6963 discovery and the two calls this app can make |
| `src/director/` | FE-9's controls — **devnet only** (below) |

## Honest by construction

- **Never invent activity.** No placeholder fills, no synthetic ticks, no
  optimistic "confirmed". An order is *pending in window* until the Sync block,
  then *filled at P* or *rolled to next window (limit not met)* (FE-2). The word
  "confirmed" appears nowhere before settlement, and the end-to-end suite
  asserts it.
- **Numbers come from the stream.** IX-3 computes amortisation and the
  counterfactual once, in the indexer, so the swap panel's cost line (FE-3) and
  the theater's counter (FE-6) cannot disagree. The only arithmetic here is the
  addition across settlements, and the direct-L1 figure is rendered as "your
  last L1 swap cost" **only** when it is the user's own (IX-3).
- **A stalled chain is a visibly stalled window.** The slot bar runs on real
  time but is anchored to the last event received; when nothing arrives for
  longer than an L2 block allows, the window says so rather than animating on
  (FE-12). `prefers-reduced-motion` sets the one motion token to zero, which
  turns every transition into a stepped state change.
- **Absence is a value.** No mirror, no L1 head, no counterfactual, no
  gateway — each is stated, with the reason, and never filled in with a guess.

## The demo director is compiled out, not hidden

`vite.config.ts` resolves `@demo-controls` to `src/director/panel.tsx` on
`PROFILE=devnet` and to a module that renders nothing on every other profile.
Off devnet the panel is never imported, so nothing it contains — including the
gateway routes it would call — reaches the bundle:

```bash
PROFILE=testnet npm run build && grep -r "director" dist/ | wc -l   # 0
```

`test/bundle.test.ts` builds both profiles and asserts exactly that, including
the devnet half — a check that cannot fail proves nothing. Source maps are
emitted on devnet only: a map republishes every source file beside the bundle,
which is more than a deployment needs and enough to make this check answer on
comments instead of on code.

## Configuration

Query parameters beat `VITE_*` variables; neither can turn on the demo
controls, because the profile is compiled in.

| Variable | Query | Default |
|---|---|---|
| `VITE_INDEXER_URL` | `indexer` | `http://127.0.0.1:8080` |
| `VITE_FIXTURE_URL` | `fixture` | `/fixtures/run.json` |
| `VITE_SPEED` | `speed` | `1` (`0` is as fast as the machine allows) |
| — | `mode` | `observe` |
| `VITE_WINDOW_BOOK` | — | unset — no order can be placed |
| `VITE_L2_CHAIN_ID` | — | unset — no chain is required of a wallet |
| `VITE_FEE_MODE` · `VITE_FEE_BPS` · `VITE_FEE_FIXED_A` · `VITE_FEE_FIXED_B` | — | `bps`, `1` (EC-1's ceiling at 2026 gas) |
| `VITE_ROUTE_FEE_MODEL` | — | `absorb` — the launch setting, so the share is zero |
| `VITE_ASSET_{A,B}_{SYMBOL,DECIMALS,ADDRESS}` | — | `ETH`/`USD`, 18 decimals |
| `VITE_L1_EXPLORER_URL` | — | `https://etherscan.io/tx/` |

The EC-1 parameters are configuration because the stream does not carry them:
they are the book's deployment parameters, and the cost line states the shape it
was told. `test/domain.test.ts` checks the default against the recorded run's
own fills, to the wei.

## Tests

```bash
npm test          # reducer, domain, stream, calldata, and the FE-9 bundle check
npm run test:e2e  # headless, over scenario/fixtures, through the real components
```

`test/reduce.test.ts` walks **every** transition in both A.4 tables, read from
the frozen schema rather than transcribed. `e2e/theater.test.ts` folds each HX-5
recording, renders the real `App`, and asserts the terminal render of all four
window outcomes — settled, rolled, evicted, rolled back — then runs the indexer
in-process over the same recording and asserts the quote, the cost line and the
amortisation counter agree with it **to the wei**.

The recorded runs are read from `scenario/fixtures/` and emitted into
`dist/fixtures/` at build, so replay stands alone with no infrastructure behind
it. They are never copied into this package: a second copy is a copy that goes
stale.

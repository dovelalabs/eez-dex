/**
 * One recorded run, produced by the real gateway — RD-2 TS-5, HX-5.
 *
 * The script drives {@link LiveSource} over the fake chain through the four
 * window outcomes A.4 names — settled, an order rolled at the boundary, a
 * poison eviction, and a settled window rolled back — and returns the events
 * the gateway emitted.
 *
 * This is the fixture's provenance: `test/fixtures/run.json` is this run,
 * recorded. A fixture that is *the output of the live path* is the strongest
 * form of the TS-5 property — replay cannot differ from live, because replay
 * is serving what live emitted.
 *
 * Until WP-4's HX-5 fixture exists it is also the stand-in the prompt asks
 * for, and it conforms to the same frozen schema, which is the arbiter if the
 * two ever disagree.
 */

import type { SlotEvent } from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";
import { EventHub } from "../src/hub.ts";
import { loading } from "../src/protocol.ts";
import { LiveSource } from "../src/sources/live.ts";
import { BOOK, FakeL1, FakeL2, ORDERS, OWNERS, PRICE_X96 } from "./fakechain.ts";

const START_UNIX = 1_800_000_000;
const ONE_A = 10n ** 18n;
const ONE_B = 10n ** 18n;

/** The settler's projection, as the fake settler serves it over the tick. */
interface SettlerDocument {
  window?: unknown;
  orders?: unknown[];
  mirror?: unknown;
  metrics?: Record<string, number>;
  settlements?: unknown[];
}

/** The A.5 metrics, under their frozen names. */
function metrics(fills: number, netting: number): Record<string, number> {
  return {
    'windows_total{outcome="settled"}': fills > 0 ? 1 : 0,
    fills_per_settlement: fills,
    netting_ratio: netting,
    impact_bps: 5,
    roll_rate: 0.25,
    mirror_age_slots: 1,
    window_slots: 2,
    escrow_invariant_drift_wei: 0,
    selection_omitted_total: 0,
    unposted_window: 0,
  };
}

function leg(windowId: string, residualIn: string) {
  return {
    windowId,
    residualSide: "SELL_A_FOR_B",
    residualIn,
    minPriceX96: (PRICE_X96 - PRICE_X96 / 100n).toString(),
    maxPriceX96: (PRICE_X96 + PRICE_X96 / 100n).toString(),
    deadline: START_UNIX + 24,
  };
}

/** What the recording produced, so tests can assert on both halves. */
export interface Recording {
  readonly events: readonly SlotEvent[];
  readonly hub: EventHub;
}

/**
 * Runs the script and returns the stream it produced.
 *
 * `startUnix` shifts every timestamp, which is how the "identical modulo
 * timestamps" half of TS-5 is exercised without a second script.
 */
export async function recordScriptedRun(startUnix: number = START_UNIX): Promise<Recording> {
  const l2 = new FakeL2();
  const l1 = new FakeL1();
  const shift = startUnix - START_UNIX;
  l2.timestamp += shift;
  l2.book.mirrorTimestamp += shift;

  let settler: SettlerDocument = {};
  let unix = startUnix;

  const hub = new EventHub({
    mode: "live",
    profile: "devnet",
    now: () => unix,
    sources: [loading("l2"), loading("l1"), loading("settler")],
  });

  const events: SlotEvent[] = [];
  hub.subscribe((frame) => {
    if (frame.type === "event") events.push(frame.event);
  });

  const source = new LiveSource(
    {
      l2,
      l1,
      windowBook: BOOK,
      settlerUrl: "http://settler.test/state",
      fromBlock: 0,
      gasSampleBlocks: 5,
      now: () => unix,
      fetchImpl: (async () =>
        new Response(JSON.stringify(settler), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    },
    hub,
  );

  const tick = async (advanceSeconds: number): Promise<void> => {
    unix += advanceSeconds;
    await source.tick();
  };

  // IX-3's sample: what a retail swap costs on L1 right now, and one swap of
  // Alice's own — the figure FE-3 is allowed to print as "your last L1 swap".
  for (const [index, gas] of [380_000, 400_000, 420_000].entries()) {
    l1.swap(l1.head - index, `0x0000000000000000000000000000000000000${index}00`, gas);
  }
  l1.swap(l1.head - 3, OWNERS.alice, 355_000);

  // ---- window 1: a cross, a residual, and one order that rolls -------------

  await tick(0);

  l2.advance(2);
  l2.place(ORDERS.alice, OWNERS.alice, 0, ONE_A, 1_900n * ONE_B);
  l2.place(ORDERS.bob, OWNERS.bob, 1, 1_000n * ONE_B, ONE_A / 2n - ONE_A / 100n);
  // Carol's limit is above what the window can clear at, so she rolls (FL-8).
  l2.place(ORDERS.carol, OWNERS.carol, 0, ONE_A / 2n, 1_990n * ONE_B);
  await tick(4);

  settler = {
    metrics: metrics(0, 0),
    window: {
      schemaVersion: SCHEMA_VERSION,
      windowId: "1",
      state: "settling",
      slots: 2,
      openedAtL2Block: 1,
      openedAtUnix: startUnix,
      syncL2Block: null,
      orderIds: [ORDERS.alice, ORDERS.bob, ORDERS.carol],
      selectedOrderIds: [ORDERS.alice, ORDERS.bob],
      settlementId: null,
      grossIn: "0",
      residualIn: "0",
      residualSide: null,
      nettingRatio: null,
    },
    settlements: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: `0x${"5e".repeat(32)}`,
        windowId: "1",
        outcome: "submitted",
        leg: leg("1", "499950000000000000"),
        submittedAtUnix: startUnix + 8,
        filledOrderIds: [],
        droppedOrderIds: [],
      },
    ],
  };
  await tick(4);

  l2.advance(2);
  l2.settle(
    `0x${"5e".repeat(32)}`,
    [
      // Alice is on the residual side: she bears her pro-rata impact (FL-5).
      {
        id: ORDERS.alice,
        amountOut: 1_998_500_000_000_000_000_000n,
        fee: ONE_A / 10_000n,
        routeFee: 0n,
        impact: 500_000_000_000_000n,
      },
      // Bob crossed inside the window: no impact, ever (FL-5, EC-3).
      { id: ORDERS.bob, amountOut: 499_950_000_000_000_000n, fee: ONE_B / 10n, routeFee: 0n, impact: 0n },
    ],
    {
      amountIn: 499_950_000_000_000_000n,
      amountOut: 999_400_000_000_000_000_000n,
      referencePriceX96: PRICE_X96,
      executionPriceX96: PRICE_X96 - PRICE_X96 / 2000n,
    },
  );
  l1.head += 1;
  l1.settlement(`0x${"11".repeat(32)}`, 214_000);
  settler = {
    metrics: metrics(2, 0.5),
    window: {
      schemaVersion: SCHEMA_VERSION,
      windowId: "2",
      state: "open",
      slots: 2,
      openedAtL2Block: l2.head,
      openedAtUnix: unix + 4,
      syncL2Block: null,
      orderIds: [ORDERS.carol],
      selectedOrderIds: [],
      settlementId: null,
      grossIn: "0",
      residualIn: "0",
      residualSide: null,
      nettingRatio: null,
    },
    settlements: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: `0x${"5e".repeat(32)}`,
        windowId: "1",
        outcome: "settled",
        leg: leg("1", "499950000000000000"),
        l1TxHash: `0x${"11".repeat(32)}`,
        submittedAtUnix: startUnix + 8,
        settledAtUnix: unix + 4,
        filledOrderIds: [ORDERS.alice, ORDERS.bob],
        droppedOrderIds: [],
      },
    ],
  };
  await tick(4);

  // The receipt is read on the tick after the settler names its transaction,
  // and IX-3's figures land with it.
  await tick(2);

  // ---- window 2: poison-evicted, and free (FL-7) ---------------------------

  l2.advance(2);
  l2.place(ORDERS.dave, OWNERS.dave, 1, 500n * ONE_B, ONE_A / 5n);
  await tick(4);

  settler = {
    ...settler,
    metrics: metrics(2, 0.5),
    settlements: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: `0x${"e0".repeat(32)}`,
        windowId: "2",
        outcome: "evicted",
        leg: leg("2", "200000000000000000"),
        submittedAtUnix: unix + 2,
        filledOrderIds: [],
        droppedOrderIds: [ORDERS.carol],
      },
    ],
  };
  await tick(4);

  // ---- window 2 again: settled, then rolled back (SV-4) -------------------

  l2.advance(2);
  l2.settle(
    `0x${"7c".repeat(32)}`,
    [{ id: ORDERS.carol, amountOut: 995_000_000_000_000_000_000n, fee: ONE_A / 20_000n, routeFee: 0n, impact: 0n }],
    {
      amountIn: 499_950_000_000_000_000n,
      amountOut: 999_000_000_000_000_000_000n,
      referencePriceX96: PRICE_X96,
      executionPriceX96: PRICE_X96 - PRICE_X96 / 1000n,
    },
  );
  settler = { ...settler, settlements: [] };
  await tick(4);

  settler = {
    ...settler,
    settlements: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: `0x${"7c".repeat(32)}`,
        windowId: "2",
        outcome: "rolled_back",
        rollbackCause: "bundle_missed",
        leg: leg("2", "499950000000000000"),
        l1GasSpent: false,
        submittedAtUnix: unix - 2,
        filledOrderIds: [ORDERS.carol],
        droppedOrderIds: [],
      },
    ],
  };
  await tick(4);

  source.stop();
  return { events, hub };
}

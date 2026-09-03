/**
 * RD-2 §10, as numbers — the evidence `scripts/verify.sh` prints.
 *
 * Phase 6 part B. Each acceptance criterion is a claim about a run, and this
 * computes the figures each claim is made of from the artefacts that exist:
 * the committed HX-5 recordings (which is what a devnet run produced) and the
 * seeded soak against the settlement oracle. It asserts nothing and formats
 * nothing — `verify.sh` decides PASS or FAIL, so the rule and the measurement
 * are not the same line of code.
 *
 * What it cannot see it does not report: an enclave bringing four processes up
 * together, a wallet placing an order, a browser. Those rows are the shell's,
 * and where no enclave ran they are SKIP and never PASS.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MirrorSnapshot, Order, Settlement, SlotEvent } from "../../indexer/schema/index.ts";
import { stateOf } from "./assert.ts";
import { toBig } from "./math.ts";
import { runSimulatedSoak } from "./simulated-soak.ts";
import type { SoakReport } from "./simulated-soak.ts";
import { validate } from "./validate.ts";

const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");

/** One L1 slot, the unit `mirrorAgeSlots` is counted in (CT-8). */
const SLOT_SECONDS = 12;

/** The recordings a run produces, and what each one is the evidence for. */
const RECORDINGS = ["run", "settled", "rolled", "evicted", "rolled-back"] as const;

/** §10's first criterion, from the recorded happy path. */
export interface AmortisationEvidence {
  readonly fills: number;
  readonly accounts: number;
  readonly crossLayerTransactions: number;
  readonly gasPerFillWei: string;
  readonly counterfactualPerFillWei: string;
  /** RD-2 EC-5's mainnet density baseline, quoted so no reader mistakes the
   * scripted burst for it. */
  readonly densityBaseline: {
    readonly fillsPerWindow: number;
    readonly windowsAtLeastEight: string;
    readonly nettingRatio: string;
    readonly source: string;
  };
  /** EC-1's fee ceiling at measured gas, likewise quoted. */
  readonly feeCeilingBps: number;
}

/** §10's second criterion, over every artefact that carries a fill. */
export interface LimitEvidence {
  readonly fillsChecked: number;
  readonly violations: number;
  readonly sources: readonly string[];
}

/** §10's third criterion, from the eviction row. */
export interface FreeFailureEvidence {
  readonly evictions: number;
  readonly l1GasSpent: boolean;
  readonly ordersLeftOpen: number;
  readonly ordersFilled: number;
  readonly escrowDriftWei: number;
}

/** §10's fourth criterion, per artefact. */
export interface EscrowEvidence {
  readonly worstDriftWei: number;
  readonly checked: readonly string[];
}

/** §10's fifth criterion. */
export interface MirrorEvidence {
  /** The most settlements any recording went through without refreshing. */
  readonly worstSettlementsBetweenRefreshes: number;
  /** Snapshots whose `ageSlots` is not `(observed − stamped) / 12` (CT-8). */
  readonly ageMismatches: number;
  readonly snapshots: number;
}

/** Everything §10 can be measured from without an enclave. */
export interface Acceptance {
  readonly amortisation: AmortisationEvidence;
  readonly limits: LimitEvidence;
  readonly freeFailure: FreeFailureEvidence;
  readonly escrow: EscrowEvidence;
  readonly mirror: MirrorEvidence;
  readonly soak: SoakReport;
}

function events(name: string): SlotEvent[] {
  return validate(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")));
}

function fillsOf(orders: Iterable<Order>): Order[] {
  return [...orders].filter((order) => order.fill !== null);
}

function amortisationEvidence(): AmortisationEvidence {
  const state = stateOf(events("settled"));
  const settled = [...state.settlements.values()].filter((settlement) => settlement.outcome === "settled");
  const filled = fillsOf(state.orders.values());

  return {
    fills: settled.reduce((total, settlement) => total + settlement.filledOrderIds.length, 0),
    accounts: new Set(filled.map((order) => order.owner)).size,
    crossLayerTransactions: settled.length,
    gasPerFillWei: (state.metrics["gas_per_fill_wei"] ?? 0).toString(),
    counterfactualPerFillWei: (state.metrics["counterfactual_l1_gas_wei"] ?? 0).toString(),
    densityBaseline: {
      fillsPerWindow: 1.08,
      windowsAtLeastEight: "0.8%",
      nettingRatio: "14–23%",
      source: "RD-2 EC-5 (ER-2), deepest mainnet ETH pool at 100% capture",
    },
    feeCeilingBps: 1,
  };
}

function limitEvidence(soak: SoakReport): LimitEvidence {
  let fillsChecked = 0;
  let violations = 0;
  const sources: string[] = [];

  for (const name of RECORDINGS) {
    const state = stateOf(events(name));
    const filled = fillsOf(state.orders.values());
    for (const order of filled) {
      fillsChecked += 1;
      if (toBig(order.fill!.amountOut) < toBig(order.minBuyAmount)) violations += 1;
    }
    sources.push(`${name}.json`);
  }

  fillsChecked += soak.fills;
  violations += soak.limitViolations;
  sources.push(`soak(seed=${soak.seed}, slots=${soak.slots})`);

  return {fillsChecked, violations, sources};
}

function freeFailureEvidence(): FreeFailureEvidence {
  const state = stateOf(events("evicted"));
  const evictions = [...state.settlements.values()].filter(
    (settlement: Settlement) => settlement.outcome === "evicted",
  );
  const orders = [...state.orders.values()];

  return {
    evictions: evictions.length,
    l1GasSpent: evictions.some((settlement) => settlement.l1GasSpent),
    ordersLeftOpen: orders.filter((order) => order.state === "open").length,
    ordersFilled: orders.filter((order) => order.state === "filled").length,
    escrowDriftWei: state.metrics["escrow_invariant_drift_wei"] ?? 0,
  };
}

function escrowEvidence(soak: SoakReport): EscrowEvidence {
  let worst = 0;
  const checked: string[] = [];
  for (const name of RECORDINGS) {
    const drift = stateOf(events(name)).metrics["escrow_invariant_drift_wei"] ?? 0;
    worst = Math.max(worst, Math.abs(drift));
    checked.push(`${name}.json`);
  }
  worst = Math.max(worst, Math.abs(soak.metrics["escrow_invariant_drift_wei"] ?? 0));
  checked.push(`soak(seed=${soak.seed}, slots=${soak.slots})`);
  return {worstDriftWei: worst, checked};
}

function mirrorEvidence(): MirrorEvidence {
  let worst = 0;
  let ageMismatches = 0;
  let snapshots = 0;

  for (const name of RECORDINGS) {
    // A settlement is emitted more than once as it acquires its receipt, so
    // what is counted is the first time each one reaches `settled`.
    const counted = new Set<string>();
    let sinceRefresh = 0;
    for (const event of events(name)) {
      if (event.kind === "settlement" && event.settlement.outcome === "settled") {
        if (!counted.has(event.settlement.id)) {
          counted.add(event.settlement.id);
          sinceRefresh += 1;
          worst = Math.max(worst, sinceRefresh);
        }
      }
      if (event.kind !== "mirror") continue;
      const mirror: MirrorSnapshot = event.mirror;
      snapshots += 1;
      sinceRefresh = 0;
      const expected = Math.max(0, Math.floor((mirror.observedAtUnix - mirror.mirrorTimestamp) / SLOT_SECONDS));
      if (mirror.ageSlots !== expected) ageMismatches += 1;
    }
  }

  return {worstSettlementsBetweenRefreshes: worst, ageMismatches, snapshots};
}

/** Everything §10 can be measured from here, in one document. */
export function acceptance(seed = "1", slots = 200): Acceptance {
  const soak = runSimulatedSoak(seed, slots);
  return {
    amortisation: amortisationEvidence(),
    limits: limitEvidence(soak),
    freeFailure: freeFailureEvidence(),
    escrow: escrowEvidence(soak),
    mirror: mirrorEvidence(),
    soak,
  };
}

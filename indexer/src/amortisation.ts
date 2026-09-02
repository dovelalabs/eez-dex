/**
 * The derived amortisation stream — RD-2 IX-3, FE-3, FE-6.
 *
 * Computed **once, here**, so the swap panel's cost line and the theater's
 * counter cannot disagree: one settlement's fills, its real L1 gas, gas per
 * fill, and what the same fills would have cost as direct L1 swaps.
 *
 * The counterfactual is IX-3's, in its order:
 *
 *   1. the gas the user's own address last paid for a swap on L1, when the
 *      sampler observed one — the only figure FE-3 may print as "your last L1
 *      swap cost";
 *   2. otherwise the median retail swap gas from the last sampled window of L1
 *      receipts.
 *
 * There is no third branch. IX-3 forbids a fixed single-hop estimate, so when
 * the sample has observed nothing this returns **null** — no amortisation, and
 * the stream says why — rather than quoting a saving against a number nobody
 * measured.
 *
 * Both sides are priced at the settlement's own effective gas price: the
 * question FE-6 asks is what these fills cost *here* against what they would
 * have cost *on L1 in the same conditions*, and pricing the two halves at
 * different gas prices would answer a different one.
 */

import type { Amortisation, OrderCounterfactual } from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";
import type { GasSample, Receipt } from "./chain/l1.ts";

/** One filled order, as far as the counterfactual cares. */
export interface FilledOrder {
  readonly id: string;
  readonly owner: string;
}

/** What one settlement's figures are computed from. */
export interface AmortisationInput {
  readonly settlementId: string;
  readonly windowId: string;
  readonly filled: readonly FilledOrder[];
  readonly receipt: Receipt;
  readonly sample: GasSample;
}

/** One order's counterfactual, or null when nothing was ever observed. */
function counterfactualFor(
  order: FilledOrder,
  sample: GasSample,
  gasPriceWei: bigint,
): OrderCounterfactual | null {
  const own = sample.perAddress.get(order.owner.toLowerCase());
  const gasUsed = own ?? sample.medianSwapGas;
  if (gasUsed === null || gasUsed === undefined) return null;

  return {
    orderId: order.id,
    gasUsed: gasUsed.toString(),
    gasCostWei: (gasUsed * gasPriceWei).toString(),
    source: own === undefined ? "median_retail_swap" : "user_last_l1_swap",
  };
}

/**
 * One settlement's IX-3 figures, or null when no counterfactual was observed.
 *
 * A settlement with no fills is a real settlement — a CT-6 refresh is exactly
 * that — and it reports `fills: 0` with a null `gasPerFillWei` rather than
 * being left out of the stream.
 */
export function amortisationFor(input: AmortisationInput): Amortisation | null {
  const { receipt, sample } = input;
  const gasPriceWei = receipt.effectiveGasPriceWei;
  const l1GasCostWei = receipt.gasUsed * gasPriceWei;

  const perOrder: OrderCounterfactual[] = [];
  for (const order of input.filled) {
    const counterfactual = counterfactualFor(order, sample, gasPriceWei);
    // Either every fill has an observed counterfactual or the settlement has
    // none: a total that silently skips the orders nothing was observed for
    // would understate the comparison without saying so.
    if (counterfactual === null) return null;
    perOrder.push(counterfactual);
  }

  const counterfactualGasCostWei = perOrder.reduce((total, entry) => total + BigInt(entry.gasCostWei), 0n);
  const fills = input.filled.length;

  return {
    schemaVersion: SCHEMA_VERSION,
    settlementId: input.settlementId,
    windowId: input.windowId,
    fills,
    l1GasUsed: receipt.gasUsed.toString(),
    l1GasCostWei: l1GasCostWei.toString(),
    gasPerFillWei: fills === 0 ? null : (l1GasCostWei / BigInt(fills)).toString(),
    counterfactualGasCostWei: counterfactualGasCostWei.toString(),
    savingsWei: (counterfactualGasCostWei - l1GasCostWei).toString(),
    perOrder,
  };
}

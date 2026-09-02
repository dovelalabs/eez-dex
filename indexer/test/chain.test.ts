/**
 * The chain plumbing — RD-2 IX-1.
 *
 * Topics and selectors are derived from signature strings at load time, so
 * these vectors (produced by `cast sig-event` / `cast sig` against
 * `contracts/src/l2/WindowBook.sol`) are what pins the derivation to the
 * contracts WP-2 deployed. A signature that drifts fails here rather than
 * silently decoding nothing on a live chain.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeCall, toHashArray, toInt, words } from "../src/chain/abi.ts";
import { TOPICS, decodeBookLog } from "../src/chain/book.ts";
import { EMPTY_GAS_SAMPLE, SWAP_TOPICS, sampleSwapGas, type Receipt } from "../src/chain/l1.ts";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const OWNER = "0x000000000000000000000000000000000000000000000000000000000000beef";

function w(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

test("ix1: the topics are the contracts' topics", () => {
  assert.equal(TOPICS.orderPlaced, "0x87e31270c886f5cb5e3099fcb8f64604ea1f3e32193a665d14cbeee5ea4f3881");
  assert.equal(TOPICS.orderCancelled, "0xb2705df32ac67fc3101f496cd7036bf59074a603544d97d73650b6f09744986a");
  assert.equal(TOPICS.orderExpired, "0x054331359b0c6405f15e0f99a4920c1851eb4ad7f78e8a3bf5820169d9dae50f");
  assert.equal(TOPICS.orderFilled, "0xe2b3127eb797a3c7afe2607f51fec73fc9cd05cfe11ef16f4a5089e63c43cfba");
  assert.equal(TOPICS.windowSettled, "0x89c8b21723b1f942421d089b58e89eae5087bc56f7998138da4183890ef3b0e9");
});

test("ix1: the view selectors are the contracts' selectors", () => {
  assert.equal(encodeCall("windowId()"), "0x9af1d03e");
  assert.equal(encodeCall("openOrderIds()"), "0x3c570911");
  assert.equal(encodeCall("latestPrice()"), "0xa3e6ba94");
  assert.equal(encodeCall("quoteState()"), "0xfbc7d757");
  assert.equal(encodeCall("orderOf(bytes32)", [ID]), `0xd5a014e5${w(0xa1)}`);
  assert.equal(encodeCall("statusOf(bytes32)", [ID]), `0xc7df14e2${w(0xa1)}`);
});

test("ct7: OrderPlaced decodes to the schema's named side, not an ordinal", () => {
  const log = decodeBookLog({
    address: "0xbook",
    topics: [TOPICS.orderPlaced, ID, OWNER, `0x${w(7)}`],
    data: `0x${w(1)}${w(10n ** 18n)}${w(99n)}${OWNER.slice(2)}${w(4)}`,
    blockNumber: "0x400",
    transactionHash: "0xAB",
    logIndex: "0x2",
  });

  assert.equal(log?.kind, "order_placed");
  if (log?.kind !== "order_placed") return;
  assert.equal(log.side, "SELL_B_FOR_A");
  assert.equal(log.id, ID);
  assert.equal(log.owner, "0x000000000000000000000000000000000000beef");
  assert.equal(log.windowId, "7");
  assert.equal(log.sellAmount, 10n ** 18n);
  assert.equal(log.minBuyAmount, 99n);
  assert.equal(log.expiresAfter, 4);
  // The position a fold orders and de-duplicates by.
  assert.deepEqual(log.at, { blockNumber: 1024, logIndex: 2, transactionHash: "0xab" });
});

test("ct12: OrderFilled carries every deduction absolutely, so nothing is inferred", () => {
  const log = decodeBookLog({
    address: "0xbook",
    topics: [TOPICS.orderFilled, ID],
    data: `0x${w(995n)}${w(1n)}${w(2n)}${w(3n)}`,
    blockNumber: "0x1",
    transactionHash: "0xcc",
    logIndex: "0x0",
  });
  assert.equal(log?.kind, "order_filled");
  if (log?.kind !== "order_filled") return;
  assert.deepEqual(
    { out: log.amountOut, fee: log.feeAmount, route: log.routeFeeAmount, impact: log.impactAmount },
    { out: 995n, fee: 1n, route: 2n, impact: 3n },
  );
});

test("fl-1: WindowSettled carries the result the next mirror is taken from", () => {
  const log = decodeBookLog({
    address: "0xbook",
    topics: [TOPICS.windowSettled, `0x${w(12)}`],
    // amountIn, amountOut, P0, execution, (sqrtPrice, liquidity, tick), l1Block
    data: `0x${w(1000n)}${w(1900n)}${w(2n ** 96n)}${w(2n ** 96n - 5n)}${w(2n ** 96n)}${w(4242n)}${"f".repeat(64 - 4)}fff2${w(21_000_000n)}`,
    blockNumber: "0x2",
    transactionHash: "0xdd",
    logIndex: "0x1",
  });
  assert.equal(log?.kind, "window_settled");
  if (log?.kind !== "window_settled") return;
  assert.equal(log.windowId, "12");
  assert.equal(log.result.amountIn, 1000n);
  assert.equal(log.result.post.liquidity, "4242");
  // int24 is two's complement: the tick can be negative and often is.
  assert.equal(log.result.post.tick, -14);
  assert.equal(log.result.l1Block, 21_000_000);
});

test("ix1: an unrelated log decodes to null rather than to a guess", () => {
  const log = decodeBookLog({
    address: "0xbook",
    topics: ["0x" + "11".repeat(32)],
    data: "0x",
    blockNumber: "0x1",
    transactionHash: "0xee",
    logIndex: "0x0",
  });
  assert.equal(log, null);
});

test("ix1: bytes32[] returns decode through their head offset", () => {
  const data = `0x${w(32)}${w(2)}${w(0xaa)}${w(0xbb)}`;
  assert.deepEqual(toHashArray(data), [`0x${w(0xaa)}`, `0x${w(0xbb)}`]);
  assert.equal(words(data).length, 4);
  assert.equal(toInt(`0x${"f".repeat(64)}`, 24), -1);
});

function receipt(from: string, gasUsed: bigint, isSwap: boolean): Receipt {
  return {
    transactionHash: `0x${from.slice(2)}`,
    from,
    blockNumber: 1,
    gasUsed,
    effectiveGasPriceWei: 2_000_000_000n,
    status: "success",
    isSwap,
  };
}

test("ix3: the swap sample is measured from receipts, never assumed", () => {
  const sample = sampleSwapGas(
    [
      receipt("0xa", 100_000n, true),
      receipt("0xb", 400_000n, true),
      receipt("0xc", 21_000n, false),
      receipt("0xd", 300_000n, true),
    ],
    10,
    20,
  );
  assert.equal(sample.swapCount, 3);
  assert.equal(sample.medianSwapGas, 300_000n);
  assert.equal(sample.perAddress.get("0xb"), 400_000n);
  // A transfer is not a swap, so it is not in the median.
  assert.equal(sample.perAddress.has("0xc"), false);
  assert.equal(sample.medianGasPriceWei, 2_000_000_000n);
});

test("ix3: a sample with no swaps in it yields no counterfactual at all", () => {
  const sample = sampleSwapGas([receipt("0xc", 21_000n, false)], 1, 2, EMPTY_GAS_SAMPLE);
  assert.equal(sample.medianSwapGas, null);
  assert.equal(sample.swapCount, 0);
  // And the swap topics are the ones a real router leaves behind.
  assert.equal(SWAP_TOPICS[0], "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67");
});

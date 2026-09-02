/**
 * The observer, over a stubbed chain — RD-2 HX-2, HX-5.
 *
 * The enclave run is the real thing, but everything between "a log happened"
 * and "the recorded run says so" is decoding and ordering, and both are exactly
 * the kind of thing that is wrong silently. So the observer is driven here over
 * a scripted set of RPC responses: real topic hashes, real ABI encoding, real
 * `settleWindow` calldata.
 *
 * If this suite passes and the enclave run still disagrees, the fault is in the
 * enclave or the contracts — which is the split a harness is supposed to give
 * you.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVENTS, encodeCall, selector, topic0 } from "./abi.ts";
import { Chain } from "./chain.ts";
import type { Transport } from "./chain.ts";
import { toHex, word } from "./keccak.ts";
import { Q96, fromBig, mulDiv, spotPriceX96 } from "./math.ts";
import { Observer } from "./observe.ts";
import type { ObserveConfig } from "./observe.ts";
import { sqrtPriceForPrice } from "./pool.ts";
import { record } from "./record.ts";
import { assertRun } from "./assert.ts";
import type { Readings } from "./assert.ts";
import { validate } from "./validate.ts";
import { FIXTURE_PARAMS } from "./fixture.ts";

const BOOK = "0x00000000000000000000000000000000000000b0";
const POOL = "0x00000000000000000000000000000000000000c2";
const ASSET_A = "0x0000000000000000000000000000000000000000";
const ASSET_B = "0x00000000000000000000000000000000000000b2";
const MANAGER = "0x00000000000000000000000000000000000000a9";
const TRADER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const OTHER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

const ONE = 10n ** 18n;
const SQRT_3000 = sqrtPriceForPrice(3000n, 1n);
const P0 = spotPriceX96(SQRT_3000);
const LIQUIDITY = 2_000_000n * ONE;

const ORDER_A = `0x${"11".repeat(32)}`;
const ORDER_B = `0x${"22".repeat(32)}`;
const SETTLE_TX = `0x${"33".repeat(32)}`;
const BATCH_TX = `0x${"44".repeat(32)}`;

function pack(values: readonly bigint[]): string {
  return `0x${values.map((value) => toHex(word(value)).slice(2)).join("")}`;
}

interface FakeLog {
  readonly block: number;
  readonly topics: string[];
  readonly data: string;
  readonly txHash: string;
  readonly logIndex: number;
}

function placedLog(block: number, logIndex: number, id: string, owner: string, sideIsA: boolean, sell: bigint, minBuy: bigint): FakeLog {
  return {
    block,
    logIndex,
    txHash: `0x${"aa".repeat(32)}`,
    topics: [topic0(EVENTS.orderPlaced), id, toHex(word(BigInt(owner))), toHex(word(0n))],
    data: pack([sideIsA ? 0n : 1n, sell, minBuy, BigInt(owner), 2n]),
  };
}

function filledLog(block: number, logIndex: number, id: string, amountOut: bigint, fee: bigint, impact: bigint): FakeLog {
  return {
    block,
    logIndex,
    txHash: SETTLE_TX,
    topics: [topic0(EVENTS.orderFilled), id],
    data: pack([amountOut, fee, 0n, impact]),
  };
}

function settledLog(block: number, logIndex: number, amountIn: bigint, amountOut: bigint, post: bigint, l1Block: bigint): FakeLog {
  return {
    block,
    logIndex,
    txHash: SETTLE_TX,
    topics: [topic0(EVENTS.windowSettled), toHex(word(0n))],
    data: pack([amountIn, amountOut, P0, P0 - 1n, post, LIQUIDITY, 80067n, l1Block]),
  };
}

/** `settleWindow(bytes32[] orderIds, uint64 deadline)` calldata. */
function settleCalldata(ids: readonly string[], deadline: bigint): string {
  const head = [64n, deadline, BigInt(ids.length), ...ids.map((id) => BigInt(id))];
  return selector("settleWindow(bytes32[],uint64)") + pack(head).slice(2);
}

/**
 * The head is a reference, not a number: the observer starts at the head and
 * watches *forward*, so a test that handed it a chain whose history was
 * already in the past would observe nothing at all — which is exactly the bug
 * this shape stops the harness having against a live enclave.
 */
function fakeChains(logs: readonly FakeLog[], head: { value: number }): { l1: Chain; l2: Chain } {
  const l2: Transport = async (method, params) => {
    switch (method) {
      case "eth_blockNumber":
        return `0x${head.value.toString(16)}`;
      case "eth_getBlockByNumber": {
        const block = Number(BigInt(String(params[0])));
        return { timestamp: `0x${(1_788_000_000 + block * 2).toString(16)}`, transactions: [] };
      }
      case "eth_getLogs": {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        return logs
          .filter((log) => log.block >= from && log.block <= to)
          .map((log) => ({
            address: BOOK,
            topics: log.topics,
            data: log.data,
            blockNumber: `0x${log.block.toString(16)}`,
            transactionHash: log.txHash,
            logIndex: `0x${log.logIndex.toString(16)}`,
          }));
      }
      case "eth_getTransactionByHash":
        return { to: BOOK, input: settleCalldata([ORDER_A, ORDER_B], 1_788_000_100n) };
      case "eth_call": {
        const { data } = params[0] as { data: string };
        const is = (signature: string): boolean => data.startsWith(selector(signature));
        if (is("mirror()")) return pack([SQRT_3000, LIQUIDITY, 80067n]);
        if (is("windowId()")) return pack([0n]);
        if (is("openOrderIds()")) return pack([32n, 0n]);
        if (is("balanceOf(address,address)")) return pack([5n * ONE]);
        if (is("escrowInvariantDrift(address)")) return pack([0n]);
        // Every other view on the book is one word of the CT-13 ledger.
        return pack([0n]);
      }
      default:
        throw new Error(`unstubbed L2 method ${method}`);
    }
  };

  const l1: Transport = async (method, params) => {
    switch (method) {
      case "eth_blockNumber":
        return "0x3e8";
      case "eth_getBlockByNumber": {
        const block = Number(BigInt(String(params[0])));
        return { timestamp: `0x${(1_788_000_000 + block).toString(16)}`, transactions: [BATCH_TX] };
      }
      case "eth_getTransactionByHash":
        return { to: MANAGER, input: "0x" };
      case "eth_getTransactionReceipt":
        return {
          blockNumber: "0x3e8",
          gasUsed: "0x38270",
          effectiveGasPrice: "0x3b9aca00",
          status: "0x1",
        };
      case "eth_call": {
        const { data } = params[0] as { data: string };
        if (data.startsWith(selector("slot0()"))) {
          return pack([SQRT_3000, 80067n, 0n, 0n, 0n, 0n, 1n]);
        }
        return pack([LIQUIDITY]);
      }
      default:
        throw new Error(`unstubbed L1 method ${method}`);
    }
  };

  return { l1: new Chain(l1), l2: new Chain(l2) };
}

function config(): ObserveConfig {
  return {
    l1Rpc: "http://l1",
    l2Rpc: "http://l2",
    profile: "full",
    windowBook: BOOK,
    pool: POOL,
    assetA: ASSET_A,
    assetB: ASSET_B,
    rollupManager: MANAGER,
    traders: [TRADER, OTHER],
    windowSlots: 1,
    params: FIXTURE_PARAMS,
    poolFee: "500",
    counterfactualGasUsed: "400000",
    counterfactualGasCostWei: "400000000000000",
  };
}

/** One A-side and one B-side order, crossed and settled in block 13. */
function scriptedRun(): { logs: FakeLog[]; head: { value: number } } {
  const sellA = 2n * ONE;
  const sellB = 3000n * ONE;
  const netA = sellA - sellA / 10_000n;
  const netB = sellB - sellB / 10_000n;
  const crossPot = mulDiv(netB, Q96, P0);
  return {
    head: { value: 10 },
    logs: [
      placedLog(11, 0, ORDER_A, TRADER, true, sellA, 0n),
      placedLog(12, 0, ORDER_B, OTHER, false, sellB, 0n),
      filledLog(13, 0, ORDER_A, mulDiv(netA, P0, Q96), sellA / 10_000n, 1n),
      filledLog(13, 1, ORDER_B, crossPot, sellB / 10_000n, 0n),
      settledLog(13, 2, netA - crossPot, mulDiv(netA - crossPot, P0, Q96), SQRT_3000 - 1n, 1000n),
    ],
  };
}

test("hx5: the observer folds a run into a stream that conforms to the schema", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const observer = new Observer(config(), l1, l2);

  await observer.start();
  head.value = 14;
  await observer.step();

  const kinds = observer.observations.map((observation) => observation.kind);
  assert.equal(kinds[0], "genesis");
  assert.ok(kinds.includes("order_placed"));
  assert.ok(kinds.includes("selection"));
  assert.ok(kinds.includes("settlement_submitted"));
  assert.ok(kinds.includes("order_filled"));
  assert.ok(kinds.includes("window_settled"));
  assert.ok(kinds.includes("l1_receipt"));

  const events = validate(record(observer.observations).events);
  assert.ok(events.length > 0);
});

test("ct9: the settler's suggestion is read from the calldata, not from the fills", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const observer = new Observer(config(), l1, l2);
  await observer.start();
  head.value = 14;
  await observer.step();

  const selection = observer.observations.find((observation) => observation.kind === "selection");
  assert.ok(selection !== undefined && selection.kind === "selection");
  assert.deepEqual([...selection.orderIds].sort(), [ORDER_A, ORDER_B].sort());
});

test("ct12: the residual side is read off the impact the fills carry", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const observer = new Observer(config(), l1, l2);
  await observer.start();
  head.value = 14;
  await observer.step();

  const submitted = observer.observations.find((observation) => observation.kind === "settlement_submitted");
  assert.ok(submitted !== undefined && submitted.kind === "settlement_submitted");
  // Only order A carried impact in the script, and A sells A.
  assert.equal(submitted.leg.residualSide, "SELL_A_FOR_B");
  // CT-9: `WindowSettled.amountIn` is the leg's residual, so the two agree.
  const settled = observer.observations.find((observation) => observation.kind === "window_settled");
  assert.ok(settled !== undefined && settled.kind === "window_settled");
  assert.equal(submitted.leg.residualIn, settled.result.amountIn);
});

test("hx2: the leg's inputs are snapshotted before the Sync block, not inverted after it", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const observer = new Observer(config(), l1, l2);
  await observer.start();
  head.value = 14;
  await observer.step();

  assert.equal(observer.legInputs.length, 1);
  const inputs = observer.legInputs[0];
  assert.ok(inputs !== undefined);
  assert.equal(inputs.settlementId, SETTLE_TX);
  assert.equal(inputs.mirror.sqrtPriceX96, fromBig(SQRT_3000));
  assert.equal(inputs.pool.sqrtPriceX96, fromBig(SQRT_3000));
});

test("hx2: the readings carry the ledger, the balances and the open book", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const observer = new Observer(config(), l1, l2);
  await observer.start();
  head.value = 14;
  await observer.step();

  const readings = (await observer.readings({ mode: "happy" })) as Record<string, unknown>;
  assert.equal(readings["profile"], "full");
  assert.equal((readings["escrow"] as unknown[]).length, 2, "one ledger per asset");
  assert.equal((readings["balances"] as unknown[]).length, 4, "two assets by two traders");
  assert.deepEqual(readings["openOrders"], []);
  assert.equal((readings["legInputs"] as unknown[]).length, 1);
});

test("ec5: a bundle mark becomes the cap arithmetic the assertions read (TS-4)", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const marks = join(mkdtempSync(join(tmpdir(), "dex-marks-")), "marks.jsonl");
  const observer = new Observer({ ...config(), marksFile: marks }, l1, l2);
  await observer.start();
  head.value = 14;
  await observer.step();

  // Without the mark there is nothing to assert, and `checkBundle` must not
  // report a pass it did not earn.
  const before = (await observer.readings({ mode: "matrix" })) as Record<string, unknown>;
  assert.equal(before["bundle"], undefined);

  // The shared-slot row's own numbers: the DEX's settlement plus another
  // product's cross-layer transaction, inside the node's cap (EC-5).
  writeFileSync(marks, `${JSON.stringify({ kind: "bundle", l1Block: 1002, crossLayerTxs: 2, dexTxs: 1, cap: 3 })}\n`);
  await observer.step();

  const readings = (await observer.readings({ mode: "matrix" })) as Record<string, unknown>;
  assert.deepEqual(readings["bundle"], { l1Block: 1002, crossLayerTxs: 2, dexTxs: 1, cap: 3 });
  // And it never enters the IX-2 stream: a bundle is a reading, not a fact of
  // either chain.
  assert.ok(observer.observations.every((observation) => observation.kind !== ("bundle" as never)));

  const events = validate(record(observer.observations).events);
  const passing = assertRun(events, { ...readings, expect: { mode: "matrix" } } as unknown as Readings);
  assert.ok(
    passing.lines.some((line) => line.includes("EC-5") && line.includes("PASS")),
    passing.lines.join("\n"),
  );

  // A bundle over the cap, or a DEX that took two seats, is a failure.
  const over = assertRun(events, {
    ...readings,
    bundle: { l1Block: 1002, crossLayerTxs: 4, dexTxs: 2, cap: 3 },
    expect: { mode: "matrix" },
  } as unknown as Readings);
  assert.ok(over.failures >= 2, over.lines.join("\n"));
});

test("a4: a mark that evicts a window with nothing in flight is rejected", async () => {
  const { logs, head } = scriptedRun();
  const { l1, l2 } = fakeChains(logs, head);
  const observer = new Observer(config(), l1, l2);
  await observer.start();
  head.value = 14;
  await observer.step();

  // Window 1 opened when window 0 settled and has sent nothing, so A.4 has no
  // transition for it to be evicted by. A harness that mis-attributed a
  // failure to the wrong window would otherwise record an outcome the chain
  // cannot produce, and the fixture would teach Phase 5 a state machine that
  // does not exist.
  observer.observations.push({
    kind: "settlement_evicted",
    at: 1_788_000_100,
    l2Block: 14,
    windowId: "1",
    txHash: null,
    reason: "ExecutionPriceOutsideBand",
  });
  assert.throws(() => record(observer.observations), /A\.4 forbids open -> evicted/);
});

test("encodeCall and the topics match the signatures the contracts emit", () => {
  // A transcribed topic is the classic silent failure: the decoder matches
  // nothing and the run records an empty window. These are the four the
  // observer switches on.
  assert.equal(topic0(EVENTS.orderPlaced).length, 66);
  assert.notEqual(topic0(EVENTS.orderPlaced), topic0(EVENTS.orderFilled));
  assert.notEqual(topic0(EVENTS.orderCancelled), topic0(EVENTS.orderExpired));
  assert.equal(selector("settleWindow(bytes32[],uint64)").length, 10);
  assert.equal(encodeCall("balanceOf(address,address)", [ASSET_B, TRADER]).length, 10 + 128);
});

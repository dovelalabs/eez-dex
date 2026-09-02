/**
 * Mainnet, as the read side sees it — RD-2 IX-1, IX-3.
 *
 * Three reads: the settlement's own receipt (what the leg really cost), the
 * pool's live state (FE-8's mirror-versus-head gap), and a sampled window of
 * recent receipts — the only honest source for IX-3's counterfactual.
 *
 * **The counterfactual is measured, never assumed.** IX-3 forbids a fixed
 * single-hop estimate, so this module observes: a receipt that emitted a swap
 * log is a swap, its `gasUsed` is what that swap cost, and the sample's median
 * is what a retail swap costs right now. When the sample is empty there is no
 * counterfactual, and the stream says so rather than inventing 400k gas.
 */

import type { PoolState } from "../../schema/index.ts";
import { encodeCall, toBigInt, toInt, word, words } from "./abi.ts";
import { keccak256Hex } from "./keccak.ts";
import { ethCall, type JsonRpc, RpcError } from "./rpc.ts";

/** The swap logs a retail swap leaves behind, whatever router routed it. */
export const SWAP_TOPICS: readonly string[] = [
  // Uniswap v3 / v4-style pools.
  keccak256Hex("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  // Uniswap v2 and its forks, which still carry a large share of retail flow.
  keccak256Hex("Swap(address,uint256,uint256,uint256,uint256,address)"),
];

/** A transaction receipt, cut down to what IX-3 and the schema need. */
export interface Receipt {
  readonly transactionHash: string;
  readonly from: string;
  readonly blockNumber: number;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceWei: bigint;
  readonly status: "success" | "reverted";
  /** True when the receipt carries a swap log — this was a swap (IX-3). */
  readonly isSwap: boolean;
}

interface RawReceipt {
  readonly transactionHash?: string;
  readonly from?: string;
  readonly blockNumber?: string;
  readonly gasUsed?: string;
  readonly effectiveGasPrice?: string;
  readonly status?: string;
  readonly logs?: readonly { readonly topics?: readonly string[] }[];
}

function decodeReceipt(raw: RawReceipt): Receipt | null {
  if (
    typeof raw.transactionHash !== "string" ||
    typeof raw.blockNumber !== "string" ||
    typeof raw.gasUsed !== "string"
  ) {
    return null;
  }
  const logs = raw.logs ?? [];
  return {
    transactionHash: raw.transactionHash.toLowerCase(),
    from: (raw.from ?? "0x").toLowerCase(),
    blockNumber: Number(BigInt(raw.blockNumber)),
    gasUsed: BigInt(raw.gasUsed),
    effectiveGasPriceWei: BigInt(raw.effectiveGasPrice ?? "0x0"),
    status: BigInt(raw.status ?? "0x1") === 1n ? "success" : "reverted",
    isSwap: logs.some((log) => (log.topics ?? []).some((t) => SWAP_TOPICS.includes(t.toLowerCase()))),
  };
}

/** One transaction's receipt, or null while it is not yet mined. */
export async function readReceipt(rpc: JsonRpc, txHash: string): Promise<Receipt | null> {
  const raw = await rpc.call("eth_getTransactionReceipt", [txHash]);
  if (raw === null || typeof raw !== "object") return null;
  return decodeReceipt(raw as RawReceipt);
}

/**
 * Every receipt in a block.
 *
 * `eth_getBlockReceipts` is one round trip where the endpoint has it; where it
 * does not, the block's transaction hashes are fetched one at a time. Both
 * paths return the same shape, so the sampler does not care which it got.
 */
export async function readBlockReceipts(rpc: JsonRpc, blockNumber: number): Promise<readonly Receipt[]> {
  const tag = `0x${blockNumber.toString(16)}`;
  try {
    const raw = await rpc.call("eth_getBlockReceipts", [tag]);
    if (Array.isArray(raw)) {
      return raw.map((entry) => decodeReceipt(entry as RawReceipt)).filter((r): r is Receipt => r !== null);
    }
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
  }

  const block = await rpc.call("eth_getBlockByNumber", [tag, false]);
  if (block === null || typeof block !== "object") return [];
  const hashes = (block as { transactions?: readonly string[] }).transactions ?? [];
  const receipts = await Promise.all(hashes.map((hash) => readReceipt(rpc, hash)));
  return receipts.filter((r): r is Receipt => r !== null);
}

/** The adapter's live view of the pool — the head the mirror is compared to. */
export async function readPoolState(rpc: JsonRpc, adapter: string): Promise<PoolState> {
  const data = words(await ethCall(rpc, adapter, encodeCall("quoteState()")));
  return {
    sqrtPriceX96: toBigInt(word(data, 0)).toString(),
    liquidity: toBigInt(word(data, 1)).toString(),
    tick: toInt(word(data, 2), 24),
  };
}

/**
 * What the last sampled window of L1 receipts says a swap costs (IX-3).
 *
 * `perAddress` is the last swap each address paid for — the first of IX-3's
 * two sources, and the only figure FE-3 may print as "your last L1 swap cost".
 */
export interface GasSample {
  /** The median `gasUsed` of the swaps in the sample, or null if there were none. */
  readonly medianSwapGas: bigint | null;
  /** How many swaps the median was taken over. */
  readonly swapCount: number;
  /** The most recent swap gas observed per sending address, lower case. */
  readonly perAddress: ReadonlyMap<string, bigint>;
  /** The block range sampled, inclusive. */
  readonly fromBlock: number;
  readonly toBlock: number;
  /** The gas price the sample's swaps paid, median — what a saving is priced at. */
  readonly medianGasPriceWei: bigint | null;
}

/** An empty sample: no observation, and therefore no counterfactual. */
export const EMPTY_GAS_SAMPLE: GasSample = {
  medianSwapGas: null,
  swapCount: 0,
  perAddress: new Map(),
  fromBlock: 0,
  toBlock: 0,
  medianGasPriceWei: null,
};

function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2n;
}

/** Folds receipts into a {@link GasSample}, carrying earlier observations forward. */
export function sampleSwapGas(
  receipts: readonly Receipt[],
  fromBlock: number,
  toBlock: number,
  previous: GasSample = EMPTY_GAS_SAMPLE,
): GasSample {
  const swaps = receipts.filter((receipt) => receipt.isSwap && receipt.status === "success");
  const perAddress = new Map(previous.perAddress);
  for (const swap of swaps) perAddress.set(swap.from, swap.gasUsed);

  return {
    medianSwapGas: median(swaps.map((swap) => swap.gasUsed)) ?? previous.medianSwapGas,
    swapCount: swaps.length,
    perAddress,
    fromBlock,
    toBlock,
    medianGasPriceWei:
      median(swaps.map((swap) => swap.effectiveGasPriceWei)) ?? previous.medianGasPriceWei,
  };
}

/** Samples the last `blocks` L1 blocks for swap gas (IX-3). */
export async function readGasSample(
  rpc: JsonRpc,
  head: number,
  blocks: number,
  previous: GasSample = EMPTY_GAS_SAMPLE,
): Promise<GasSample> {
  const fromBlock = Math.max(0, head - blocks + 1);
  const numbers: number[] = [];
  for (let block = fromBlock; block <= head; block++) numbers.push(block);
  const perBlock = await Promise.all(numbers.map((block) => readBlockReceipts(rpc, block)));
  return sampleSwapGas(perBlock.flat(), fromBlock, head, previous);
}

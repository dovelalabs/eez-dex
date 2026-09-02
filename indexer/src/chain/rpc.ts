/**
 * A JSON-RPC client, and the seam every test drives the gateway through.
 *
 * The gateway is read-only (IX-1): the methods below are all `eth_` reads and
 * there is no signer, no key material and no send path anywhere in this
 * package. Tests substitute a {@link JsonRpc} that answers from a scripted
 * chain, which is how "replay equals live" is asserted without a node.
 */

/** An upstream that answers JSON-RPC calls. */
export interface JsonRpc {
  /** A human name for the endpoint, used in health reporting. */
  readonly name: string;
  call(method: string, params?: readonly unknown[]): Promise<unknown>;
}

/** The upstream answered, and the answer was an error. */
export class RpcError extends Error {
  readonly endpoint: string;
  readonly method: string;

  constructor(endpoint: string, method: string, message: string) {
    super(`${endpoint} ${method}: ${message}`);
    this.endpoint = endpoint;
    this.method = method;
  }
}

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** A JSON-RPC endpoint over HTTP. `fetchImpl` is injectable for tests. */
export function httpRpc(name: string, url: string, fetchImpl: typeof fetch = fetch): JsonRpc {
  let id = 0;
  return {
    name,
    async call(method, params = []) {
      id += 1;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
      } catch (cause) {
        throw new RpcError(name, method, cause instanceof Error ? cause.message : String(cause));
      }
      if (!response.ok) throw new RpcError(name, method, `HTTP ${response.status}`);
      const payload = (await response.json()) as RpcResponse;
      if (payload.error) throw new RpcError(name, method, payload.error.message);
      return payload.result ?? null;
    },
  };
}

/** `eth_call` at a block tag, returning raw data. */
export async function ethCall(rpc: JsonRpc, to: string, data: string, block = "latest"): Promise<string> {
  const result = await rpc.call("eth_call", [{ to, data }, block]);
  if (typeof result !== "string") throw new RpcError(rpc.name, "eth_call", `expected data, got ${typeof result}`);
  return result;
}

/** One log, as `eth_getLogs` returns it. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

/** `eth_getLogs` over a closed block range for one address. */
export async function getLogs(
  rpc: JsonRpc,
  address: string,
  fromBlock: number,
  toBlock: number,
): Promise<readonly RawLog[]> {
  const result = await rpc.call("eth_getLogs", [
    { address, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` },
  ]);
  if (!Array.isArray(result)) throw new RpcError(rpc.name, "eth_getLogs", "expected an array");
  return result as readonly RawLog[];
}

/** A block header, cut down to what the stream's clock needs. */
export interface BlockHead {
  readonly number: number;
  readonly timestamp: number;
}

/**
 * A block by tag. `safe` is the L2 head the escrow invariant is checked at
 * (CT-13); a chain that does not serve the tag falls back to `latest`, and the
 * caller is told which it got.
 */
export async function getBlock(rpc: JsonRpc, tag: string): Promise<BlockHead | null> {
  const result = await rpc.call("eth_getBlockByNumber", [tag, false]);
  if (result === null || typeof result !== "object") return null;
  const block = result as { number?: string; timestamp?: string };
  if (typeof block.number !== "string" || typeof block.timestamp !== "string") return null;
  return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) };
}

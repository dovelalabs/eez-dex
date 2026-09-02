/**
 * The live source: the IX-1 gateway's socket — RD-2 IX-1, FE-10, FE-12.
 *
 * A snapshot first, then frames in sequence — which is the gateway's contract,
 * so a client that connects late starts level with one that has been connected
 * since the first block. Connection state is dispatched, never swallowed: an
 * endpoint that is not answering is a fact this app renders (§7 preamble),
 * because the alternative is a screen that looks like a quiet chain.
 *
 * This is also the *observe* path against a gateway that happens to be
 * replaying a recording. There is deliberately nothing here that could tell
 * the difference (IX-1).
 */

import { parseFrame, UnreadableStream } from "./frames.ts";
import { TICK_INTERVAL_MS, nowUnix, type Dispatch, type Source } from "./source.ts";

/** How long to wait before reconnecting, and the ceiling it backs off to. */
const RECONNECT_MS = 1_000;
const RECONNECT_CEILING_MS = 15_000;

/** What the socket source needs. */
export interface SocketOptions {
  /** The gateway's HTTP origin, e.g. `http://127.0.0.1:8080`. */
  readonly indexerUrl: string;
  readonly dispatch: Dispatch;
  /** Injectable so the source can be driven without a browser. */
  readonly connect?: (url: string) => WebSocket;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** `http(s)://host/` becomes `ws(s)://host/stream`, the gateway's one socket. */
export function streamUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/stream";
  url.search = "";
  return url.toString();
}

/** The gateway's REST snapshot, for the render before the socket is up. */
export function snapshotUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.pathname = "/snapshot";
  url.search = "";
  return url.toString();
}

/** Connects to a gateway and feeds the reducer. */
export class SocketSource implements Source {
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #backoff = RECONNECT_MS;
  #stopped = false;
  /** Set when the stream said something this build will not read (IX-2). */
  #refused = false;

  readonly #options: SocketOptions;

  constructor(options: SocketOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#stopped = false;
    const now = this.#options.now ?? nowUnix;
    this.#options.dispatch({ type: "tick", nowUnix: now() });
    this.#timer = setInterval(() => this.#options.dispatch({ type: "tick", nowUnix: now() }), TICK_INTERVAL_MS);
    void this.#seed();
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#timer = null;
    this.#retry = null;
    this.#socket?.close();
    this.#socket = null;
  }

  /**
   * The REST snapshot, so the first render is the world rather than a spinner.
   *
   * A failure here is not fatal — the socket sends a snapshot of its own — so
   * it is reported and left alone.
   */
  async #seed(): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(snapshotUrl(this.#options.indexerUrl));
      if (!response.ok) throw new Error(`the gateway answered ${response.status}`);
      const snapshot = (await response.json()) as unknown;
      const frame = parseFrame(JSON.stringify({ type: "snapshot", snapshot }));
      if (!this.#stopped) this.#options.dispatch({ type: "frame", frame });
    } catch (error) {
      if (this.#stopped) return;
      this.#options.dispatch({
        type: "connection",
        state: "connecting",
        detail: `no snapshot yet: ${message(error)}`,
      });
    }
  }

  #open(): void {
    if (this.#stopped || this.#refused) return;
    const url = streamUrl(this.#options.indexerUrl);
    this.#options.dispatch({ type: "connection", state: "connecting", detail: url });

    let socket: WebSocket;
    try {
      socket = (this.#options.connect ?? ((target: string) => new WebSocket(target)))(url);
    } catch (error) {
      this.#fail(message(error));
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#backoff = RECONNECT_MS;
      this.#options.dispatch({ type: "connection", state: "open", detail: url });
    };

    socket.onmessage = (message_: MessageEvent) => {
      const data = typeof message_.data === "string" ? message_.data : String(message_.data);
      try {
        this.#options.dispatch({ type: "frame", frame: parseFrame(data) });
      } catch (error) {
        if (error instanceof UnreadableStream) {
          // Refusing is the specified behaviour, and it is terminal: a
          // reconnect would meet the same version (IX-2).
          this.#refused = true;
          this.#options.dispatch({ type: "connection", state: "failed", detail: error.message });
          socket.close();
          return;
        }
        throw error;
      }
    };

    socket.onerror = () => this.#options.dispatch({ type: "connection", state: "connecting", detail: `${url} is not answering` });
    socket.onclose = () => {
      if (this.#stopped || this.#refused) return;
      this.#fail(`${url} closed`);
    };
  }

  #fail(detail: string): void {
    this.#socket = null;
    this.#options.dispatch({ type: "connection", state: "closed", detail });
    this.#retry = setTimeout(() => this.#open(), this.#backoff);
    this.#backoff = Math.min(this.#backoff * 2, RECONNECT_CEILING_MS);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

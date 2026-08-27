/**
 * The read-side gateway — RD-2 WP-5, IX-1.
 *
 * Phase 4b stub — owner implements.
 *
 * One small read-only service that aggregates three upstream views — L2 RPC
 * (`WindowBook` events, the safe head), L1 RPC (batch receipts, live pool
 * state) and the settler's metrics — into a single JSON-over-WebSocket stream
 * of {@link SlotEvent} plus a REST snapshot endpoint.
 *
 * It holds no keys and exposes no write path. Given a recorded run (HX-5) it
 * serves the same stream at real or accelerated clock, and the frontend cannot
 * tell a replay from a live run. The demo-director controls (FE-9) are the one
 * exception, and those endpoints exist on the devnet profile only.
 */

import { SCHEMA_VERSION } from "../schema/index.ts";
import type { SlotEvent } from "../schema/index.ts";

export * from "../schema/index.ts";

/** Where the gateway points and what it exposes. */
export interface IndexerOptions {
  readonly l1Rpc: string;
  readonly l2Rpc: string;
  readonly windowBook: string;
  readonly port: number;
  /** A recorded run to replay instead of reading chains (HX-5, FE-10). */
  readonly fixture?: string;
  /** Replay speed multiplier; 1 is real time. */
  readonly speed?: number;
  /** Devnet only: proxy the HX-3 scenario controls the director drives (FE-9). */
  readonly enableDirector?: boolean;
}

/** The running gateway. */
export interface Indexer {
  /** The IX-2 schema version this instance speaks. */
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** The ordered event stream, live or replayed. */
  stream(): AsyncIterable<SlotEvent>;
  /** The REST snapshot: current windows, orders, settlements and the mirror. */
  snapshot(): Promise<readonly SlotEvent[]>;
  close(): Promise<void>;
}

/** Starts the gateway. */
export function createIndexer(_options: IndexerOptions): Promise<Indexer> {
  throw new Error("not implemented: Phase 4b");
}

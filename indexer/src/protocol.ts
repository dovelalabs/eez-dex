/**
 * The wire the IX-2 events travel on — RD-2 IX-1, FE-10, §7 preamble.
 *
 * `schema/` is frozen and says what an event is; this says what a *connection*
 * is, which is the gateway's own contract: frames, the REST snapshot, and the
 * status that makes empty, loading and error **first-class data**.
 *
 * That distinction is deliberate. "Windows on a live chain are often quiet"
 * and the frontend is forbidden from inventing activity, so a quiet window has
 * to arrive as a fact — `activity: "empty"` with a window object carrying no
 * orders — and an upstream that is not answering has to arrive as a fact too,
 * naming which upstream and why. Neither is expressible as an absent field,
 * and neither belongs inside a frozen event type that WP-4's recorded run also
 * has to satisfy. So they live in the envelope, and the schema stays the
 * arbiter of everything inside it.
 */

import type {
  Amortisation,
  MirrorSnapshot,
  Order,
  Settlement,
  SlotEvent,
  Window,
} from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";

/** Where the stream's events come from. One code path serves both (IX-1). */
export const STREAM_MODES = ["live", "replay"] as const;

/** Live chain, or a recorded run (HX-5). */
export type StreamMode = (typeof STREAM_MODES)[number];

/**
 * The deployment this gateway points at.
 *
 * The director's control proxy exists on `devnet` and **nowhere else** — not
 * disabled elsewhere, absent (IX-1, FE-9).
 */
export const INDEXER_PROFILES = ["devnet", "testnet", "mainnet"] as const;

/** One of them. */
export type IndexerProfile = (typeof INDEXER_PROFILES)[number];

/** The upstream views IX-1 folds into one stream, plus the recorded run. */
export const SOURCE_NAMES = ["l2", "l1", "settler", "fixture"] as const;

/** Which upstream a health report is about. */
export type SourceName = (typeof SOURCE_NAMES)[number];

/**
 * How an upstream is doing.
 *
 * `loading` — asked, no answer yet. `ok` — answering. `degraded` — answering,
 * but not everything the gateway asked for. `unavailable` — configured and not
 * answering. `absent` — not configured at all, which is a legitimate
 * deployment and not an error.
 */
export const SOURCE_STATES = ["loading", "ok", "degraded", "unavailable", "absent"] as const;

/** One of them. */
export type SourceState = (typeof SOURCE_STATES)[number];

/** One upstream's state, with the reason attached when there is one. */
export interface SourceHealth {
  readonly source: SourceName;
  readonly state: SourceState;
  /** Why, in one line, when the state is not `ok`. Null when there is nothing to say. */
  readonly detail: string | null;
  /** When the gateway last heard from it. Null if it never has. */
  readonly observedAtUnix: number | null;
}

/**
 * What the stream is carrying right now.
 *
 * `loading` — nothing observed yet. `empty` — observed, and the open window
 * holds no orders: a quiet chain, stated rather than dressed up. `active` —
 * orders in the open window. `ended` — a replay reached the end of its
 * recording.
 */
export const ACTIVITY_STATES = ["loading", "empty", "active", "ended"] as const;

/** One of them. */
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Where a replay has got to, so FE-10's scrubber has something to scrub. */
export interface ReplayPosition {
  /** Clock multiplier; 1 is real time, 0 is as fast as the socket allows. */
  readonly speed: number;
  /** Events emitted so far. */
  readonly position: number;
  /** Events in the recording. */
  readonly total: number;
  /** The recorded run's own first and last timestamps. */
  readonly startedAtUnix: number | null;
  readonly endsAtUnix: number | null;
}

/** The stream's own state, sent on connect and on every change. */
export interface StreamStatus {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly mode: StreamMode;
  readonly profile: IndexerProfile;
  readonly activity: ActivityState;
  /** The last sequence number issued. */
  readonly seq: number;
  readonly atUnix: number;
  readonly sources: readonly SourceHealth[];
  /** The open window, when one has been observed. */
  readonly openWindowId: string | null;
  /** Orders in the open window — zero is the honest answer to a quiet chain. */
  readonly openOrders: number;
  /** Null in live mode. */
  readonly replay: ReplayPosition | null;
}

/**
 * The amortisation counter's cumulative half (FE-6).
 *
 * Per-settlement figures live on the settlement itself (IX-3); the running
 * totals are derived here, once, for the same reason: two views that add up
 * the same numbers differently is the failure IX-3 exists to prevent.
 */
export interface CumulativeAmortisation {
  readonly settlements: number;
  readonly fills: number;
  readonly l1GasCostWei: string;
  readonly counterfactualGasCostWei: string;
  readonly savingsWei: string;
  /** Total L1 cost over total fills, or null before there are any. */
  readonly gasPerFillWei: string | null;
}

/** The REST snapshot: everything a connecting client needs before the stream. */
export interface Snapshot {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly status: StreamStatus;
  /** The sequence number this snapshot includes up to. */
  readonly seq: number;
  /** Windows in observation order, the open one last. */
  readonly windows: readonly Window[];
  readonly orders: readonly Order[];
  readonly settlements: readonly Settlement[];
  readonly mirror: MirrorSnapshot | null;
  /** The A.5 metrics under their frozen names, or null if the settler is absent. */
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly l1Block: number | null;
  readonly l2Block: number | null;
  /** L2 blocks left before the Sync block, when the book has said. */
  readonly blocksRemaining: number | null;
  readonly amortisation: {
    readonly perSettlement: readonly Amortisation[];
    readonly cumulative: CumulativeAmortisation;
  };
}

/**
 * One frame on the WebSocket.
 *
 * A client gets `snapshot` first — so a late joiner starts level with a client
 * that has been connected since the first block — then `event` frames in
 * sequence, with `status` frames whenever the stream's own state changes.
 */
export type ServerFrame =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "event"; readonly event: SlotEvent }
  | { readonly type: "status"; readonly status: StreamStatus };

/** An upstream that is configured but has not answered yet. */
export function loading(source: SourceName): SourceHealth {
  return { source, state: "loading", detail: null, observedAtUnix: null };
}

/** An upstream that is not configured. Not an error: a deployment choice. */
export function absent(source: SourceName, detail: string): SourceHealth {
  return { source, state: "absent", detail, observedAtUnix: null };
}

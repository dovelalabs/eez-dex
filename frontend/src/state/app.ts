/**
 * The app's one reducer — RD-2 FE-11, FE-10, FE-12.
 *
 * Everything that changes what is on screen arrives here as an action, and the
 * stream's frames are the bulk of them. Live, replay and demo differ only in
 * which module produces the frames; the fold, the derived views and the
 * components below them are one code path, which is the requirement that makes
 * FE-10's three modes and FE-12's honest clock cheap instead of triplicated.
 *
 * The reducer is pure, and the event log it keeps is what makes the scrubber
 * possible: seeking is re-folding a prefix, not a second kind of playback.
 */

import type { SlotEvent } from "@eez-dex/indexer/schema";
import type { ServerFrame, Snapshot, StreamStatus } from "@eez-dex/indexer";

import type { AppConfig } from "../config.ts";
import type { Side } from "@eez-dex/indexer/schema";
import { emptyChain, foldAll, foldChain, seedChain, type ChainState } from "./chain.ts";

/** How the app's connection to the stream is doing. Rendered, never hidden. */
export const CONNECTION_STATES = ["idle", "connecting", "open", "closed", "failed"] as const;

/** One of them. */
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** A wallet session — the only key material this app ever sees (FE-11). */
export const WALLET_STATES = ["absent", "disconnected", "connecting", "connected", "wrong_chain"] as const;

/** One of them. */
export type WalletState = (typeof WALLET_STATES)[number];

/** What the browser's wallet is doing. */
export interface Wallet {
  readonly state: WalletState;
  readonly address: string | null;
  readonly chainIdHex: string | null;
  /** The provider's own name, when it announced one (EIP-6963). */
  readonly providerName: string | null;
  readonly error: string | null;
}

/** The swap panel's inputs. Text, because that is what was typed. */
export interface Form {
  readonly sellText: string;
  readonly side: Side;
  readonly slippageBps: number;
}

/** One write the user asked for, as far as the wallet has taken it. */
export interface Submission {
  readonly kind: "place" | "cancel";
  /**
   * `signing` — with the wallet. `submitted` — the L2 accepted the
   * transaction. Note what is missing: there is no `confirmed`. An order is
   * confirmed when it settles, and until then the order's own status is the
   * truth (FE-2).
   */
  readonly state: "signing" | "submitted" | "failed";
  readonly txHash: string | null;
  /** The order id, once the chain has derived one (CT-7). */
  readonly orderId: string | null;
  readonly detail: string | null;
  readonly atUnix: number;
}

/** Where a replay has got to — mirrors the gateway's own shape (FE-10). */
export interface ReplayState {
  readonly speed: number;
  readonly position: number;
  readonly total: number;
  readonly startedAtUnix: number | null;
  readonly endsAtUnix: number | null;
  readonly ended: boolean;
}

/** Everything on screen. */
export interface AppState {
  readonly config: AppConfig;
  readonly chain: ChainState;
  /** Every event received, in order — the scrubber's tape (FE-10). */
  readonly log: readonly SlotEvent[];
  /** The gateway's envelope, when there is a gateway. Null in local replay. */
  readonly status: StreamStatus | null;
  readonly connection: ConnectionState;
  readonly connectionDetail: string | null;
  /**
   * Now, by the clock of whichever source is running — the wall clock live,
   * the recording's clock in replay. Never a clock the app made up (FE-12).
   */
  readonly nowUnix: number;
  readonly replay: ReplayState | null;
  /**
   * Where the scrubber is parked, or null when following the stream. While
   * parked, arriving events still land in the log and change nothing on
   * screen: the user is looking at a moment, and it stays that moment.
   */
  readonly scrubbedTo: number | null;
  readonly wallet: Wallet;
  readonly form: Form;
  readonly submissions: readonly Submission[];
  /** A control the demo director ran, and what came back (FE-9, devnet only). */
  readonly directive: { readonly control: string; readonly detail: string } | null;
}

/** Everything that can change {@link AppState}. */
export type Action =
  | { readonly type: "frame"; readonly frame: ServerFrame }
  | { readonly type: "connection"; readonly state: ConnectionState; readonly detail?: string }
  | { readonly type: "tick"; readonly nowUnix: number }
  | { readonly type: "replay"; readonly replay: ReplayState }
  | { readonly type: "seek"; readonly position: number | null }
  | { readonly type: "wallet"; readonly wallet: Partial<Wallet> }
  | { readonly type: "form"; readonly form: Partial<Form> }
  | { readonly type: "submission"; readonly submission: Submission }
  | { readonly type: "directive"; readonly control: string; readonly detail: string };

/** The state before anything has been observed. Empty is a first-class state. */
export function initialState(config: AppConfig): AppState {
  return {
    config,
    chain: emptyChain(),
    log: [],
    status: null,
    connection: "idle",
    connectionDetail: null,
    nowUnix: 0,
    replay: null,
    scrubbedTo: null,
    wallet: { state: "absent", address: null, chainIdHex: null, providerName: null, error: null },
    form: { sellText: "", side: "SELL_A_FOR_B", slippageBps: 50 },
    submissions: [],
    directive: null,
  };
}

/** The chain state as seeded by a REST snapshot (IX-1). */
function fromSnapshot(snapshot: Snapshot): ChainState {
  return seedChain({
    windows: snapshot.windows,
    orders: snapshot.orders,
    settlements: snapshot.settlements,
    mirror: snapshot.mirror,
    metrics: snapshot.metrics,
    l1Block: snapshot.l1Block,
    l2Block: snapshot.l2Block,
    blocksRemaining: snapshot.blocksRemaining,
    openWindowId: snapshot.status.openWindowId,
    seq: snapshot.seq,
    atUnix: snapshot.status.atUnix,
  });
}

/** Folds one action. Pure. */
export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "frame": {
      const frame = action.frame;
      if (frame.type === "snapshot") {
        return {
          ...state,
          chain: fromSnapshot(frame.snapshot),
          status: frame.snapshot.status,
          nowUnix: Math.max(state.nowUnix, frame.snapshot.status.atUnix),
          replay: frame.snapshot.status.replay === null ? state.replay : fromPosition(frame.snapshot.status),
        };
      }
      if (frame.type === "status") {
        return {
          ...state,
          status: frame.status,
          nowUnix: Math.max(state.nowUnix, frame.status.atUnix),
          replay: frame.status.replay === null ? state.replay : fromPosition(frame.status),
        };
      }

      const log = [...state.log, frame.event];
      return {
        ...state,
        log,
        // A scrubbed-back view does not jump forward because the chain moved.
        chain: state.scrubbedTo === null ? foldChain(state.chain, frame.event) : state.chain,
        nowUnix: state.scrubbedTo === null ? Math.max(state.nowUnix, frame.event.atUnix) : state.nowUnix,
      };
    }

    case "connection":
      return { ...state, connection: action.state, connectionDetail: action.detail ?? null };

    case "tick":
      return action.nowUnix <= state.nowUnix ? state : { ...state, nowUnix: action.nowUnix };

    case "replay":
      return { ...state, replay: action.replay };

    case "seek": {
      if (action.position === null) {
        // Back to following: re-fold everything received, and carry on.
        return { ...state, scrubbedTo: null, chain: foldAll(state.log), nowUnix: lastAt(state.log, state.nowUnix) };
      }
      const position = Math.max(0, Math.min(action.position, state.log.length));
      const prefix = state.log.slice(0, position);
      return {
        ...state,
        scrubbedTo: position,
        chain: foldAll(prefix),
        nowUnix: lastAt(prefix, state.nowUnix),
      };
    }

    case "wallet":
      return { ...state, wallet: { ...state.wallet, ...action.wallet } };

    case "form":
      return { ...state, form: { ...state.form, ...action.form } };

    case "submission":
      return { ...state, submissions: [action.submission, ...state.submissions].slice(0, 16) };

    case "directive":
      return { ...state, directive: { control: action.control, detail: action.detail } };

    default:
      return state;
  }
}

function lastAt(events: readonly SlotEvent[], fallback: number): number {
  return events[events.length - 1]?.atUnix ?? fallback;
}

function fromPosition(status: StreamStatus): ReplayState | null {
  if (status.replay === null) return null;
  return {
    speed: status.replay.speed,
    position: status.replay.position,
    total: status.replay.total,
    startedAtUnix: status.replay.startedAtUnix,
    endsAtUnix: status.replay.endsAtUnix,
    ended: status.activity === "ended",
  };
}

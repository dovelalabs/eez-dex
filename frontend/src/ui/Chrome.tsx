/**
 * The header and the scrubber — RD-2 FE-10, §7 preamble.
 *
 * The header is where the app says what it is looking at and how well: the
 * mode, the profile, whether the stream is connected, what each upstream is
 * doing, and whether the chain is actually saying anything. All four of
 * `loading`, `empty`, `active` and `ended` are rendered as themselves — a
 * quiet chain is quiet, an unreachable gateway is unreachable, and neither is
 * dressed up as the other.
 *
 * The scrubber exists in replay, where there is a recording to scrub. It parks
 * the reducer on an event index; because the fold is pure, that is the whole
 * implementation.
 */

import { formatClock, shortAddress } from "../domain/format.ts";
import type { Mode } from "../mode.ts";
import { tradingState } from "../mode.ts";
import type { AppState } from "../state/app.ts";
import { activity } from "../state/selectors.ts";
import type { AppApi } from "./api.ts";
import { Chip } from "./parts.tsx";

/** How each mode describes itself, in the words FE-10 uses. */
const MODE_TEXT: Readonly<Record<Mode, string>> = {
  demo: "demo — devnet, with the scripted controls",
  replay: "replay — a recorded run, no infrastructure behind it",
  observe: "observe — a live chain, quiet windows included",
};

/** The activity states, as sentences rather than status codes. */
const ACTIVITY_TEXT: Readonly<Record<string, string>> = {
  loading: "waiting for the first event",
  empty: "no orders in the open window",
  active: "orders in the open window",
  ended: "the recording has ended",
};

export function Header({ state, api }: { readonly state: AppState; readonly api: AppApi }): React.JSX.Element {
  const now = activity(state);
  const trading = tradingState(state.config.mode, state.wallet.state === "connected");

  return (
    <header className="header">
      <h1>eez-dex</h1>
      <Chip title={MODE_TEXT[state.config.mode]}>{state.config.mode}</Chip>
      <Chip>{state.config.profile}</Chip>
      <Chip tone={now === "active" ? "ok" : now === "loading" ? "warn" : ""}>{ACTIVITY_TEXT[now] ?? now}</Chip>
      <Chip
        tone={state.connection === "open" ? "ok" : state.connection === "failed" ? "bad" : "warn"}
        title={state.connectionDetail ?? undefined}
      >
        {state.connection}
      </Chip>
      {(state.status?.sources ?? []).map((source) => (
        <Chip
          key={source.source}
          tone={source.state === "ok" ? "ok" : source.state === "absent" ? "" : source.state === "unavailable" ? "bad" : "warn"}
          title={source.detail ?? undefined}
        >
          {source.source} {source.state}
        </Chip>
      ))}
      <span className="spacer" />
      <span className="small faint num">{state.nowUnix === 0 ? "" : formatClock(state.nowUnix)}</span>
      {trading === "disabled" ? (
        <Chip>trading off in replay</Chip>
      ) : state.wallet.state === "connected" ? (
        <Chip tone="ok" title={state.wallet.providerName ?? undefined}>
          {shortAddress(state.wallet.address ?? "")}
        </Chip>
      ) : state.wallet.state === "wrong_chain" ? (
        <button onClick={() => void api.connectWallet()}>wrong chain — switch</button>
      ) : (
        <button onClick={() => void api.connectWallet()}>connect wallet</button>
      )}
    </header>
  );
}

/** The speeds the scrubber offers. `0` is as fast as the machine allows. */
const SPEEDS = [1, 2, 4, 8, 0] as const;

export function Scrubber({ state, api }: { readonly state: AppState; readonly api: AppApi }): React.JSX.Element | null {
  const replay = state.replay;
  if (replay === null) return null;

  const received = state.log.length;
  const parked = state.scrubbedTo;
  const position = parked ?? received;
  // Only a local recording's clock is this app's to change. When the gateway
  // is the one replaying (IX-1) its speed is a fact to state, not a control to
  // offer — a button that cannot do what it says is the dishonesty the §7
  // preamble is written against.
  const ownsClock = state.config.mode === "replay";

  return (
    <section className="panel">
      <div className="row">
        <h2>Recorded run</h2>
        <span className="small muted num">
          event {position} of {replay.total}
          {replay.ended ? " · ended" : ""}
          {parked === null ? " · following" : " · paused"}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={replay.total}
        value={position}
        aria-label="scrub the recorded run"
        onChange={(event) => api.seek(Number(event.target.value))}
      />
      <div className="row-tight">
        <button onClick={() => api.seek(parked === null ? Math.max(0, received - 1) : null)}>
          {parked === null ? "pause" : "follow"}
        </button>
        {ownsClock ? (
          SPEEDS.map((speed) => (
            <button
              key={speed}
              className={replay.speed === speed ? "primary" : ""}
              onClick={() => api.setSpeed(speed)}
            >
              {speed === 0 ? "max" : `${speed}×`}
            </button>
          ))
        ) : (
          <span className="small muted num">
            {replay.speed === 0 ? "max" : `${replay.speed}×`} — the gateway's clock
          </span>
        )}
        <span className="spacer" />
        <span className="small faint">
          {replay.startedAtUnix === null ? "" : `recorded ${formatClock(replay.startedAtUnix)}`}
        </span>
      </div>
    </section>
  );
}

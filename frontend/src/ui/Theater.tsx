/**
 * The window as a living object — RD-2 FE-5, FE-7, FE-12.
 *
 * L2 blocks tick across the slot, orders arrive as sized bars by side, the
 * cross is drawn at the boundary as the opposing bars cancelling, the residual
 * descends to the L1 lane as **one** transaction, and the fresh mirror comes
 * back. Every one of those is drawn from an event the app received: the
 * progress bar runs on real time but is anchored to the last event, so a chain
 * that stops produces a window that visibly stops (FE-12).
 *
 * The three endings get three treatments (FE-7). A settlement lands. A **free
 * failure** is not an error: no L1 transaction exists, so no gas was spent and
 * every order is still open — the demo's strongest moment, and it has to look
 * like a non-event with a receipt, not a red toast. A **rollback** shows the
 * L2 block un-happening, struck through where it was, because that is what the
 * chain did.
 */

import type { Settlement, Window } from "@eez-dex/indexer/schema";

import { formatDuration, formatPercent, formatPriceX96, formatUnits, formatWeiCost, shortHash } from "../domain/format.ts";
import type { AppState } from "../state/app.ts";
import { laneSettlement, rolledAt, slotClock, theaterWindow, windowSides } from "../state/selectors.ts";
import { Chip, Empty, Fact, Notice, Panel } from "./parts.tsx";

/** A bigint proportion as a percentage, for a bar's width. */
function percent(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const scaled = Number((part * 10_000n) / whole) / 100;
  return Math.max(0, Math.min(100, scaled));
}

export function Theater({ state }: { readonly state: AppState }): React.JSX.Element {
  const window = theaterWindow(state);
  const clock = slotClock(state, window);
  const sides = windowSides(state, window);
  const settlement = laneSettlement(state, window);
  const { assetA, assetB } = state.config;

  if (window === null || clock === null || sides === null) {
    return (
      <Panel title="Window">
        <Empty>No window observed yet. Nothing is drawn until the stream says there is one.</Empty>
      </Panel>
    );
  }

  const scale = sides.sellA > sides.sellBInA ? sides.sellA : sides.sellBInA;
  const rolled = rolledAt(state, settlement?.windowId ?? window.windowId);

  return (
    <Panel
      title={`Window ${window.windowId}`}
      aside={
        <>
          <Chip>
            {window.slots} slot{window.slots === 1 ? "" : "s"}
          </Chip>
          <StateChip window={window} />
          {settlement === null ? null : <OutcomeChip settlement={settlement} />}
        </>
      }
    >
      <div className={`slotbar${clock.stalled ? " stalled" : ""}`}>
        <div className="fill" style={{ width: `${clock.ratio * 100}%` }} />
      </div>
      <div className="row small muted">
        <span>
          {clock.stalled
            ? `stalled — nothing for ${formatDuration(clock.sinceLastEvent)}`
            : window.state === "open"
              ? `Sync block in ${formatDuration(clock.total - clock.elapsed)}`
              : "window closed"}
        </span>
        <span className="num">
          L2 {state.chain.l2Block ?? "—"} · L1 {state.chain.l1Block ?? "—"}
        </span>
      </div>

      <div className="blocks">
        {Array.from({ length: clock.blocksTotal }, (_, index) => {
          const isSync = index === clock.blocksTotal - 1;
          const done = index < clock.blocks;
          const undone = isSync && window.state === "rolled_back";
          return (
            <div
              key={index}
              className={`block${done ? " done" : ""}${isSync ? " sync" : ""}${undone ? " unhappened" : ""}`}
              title={isSync ? "the Sync block: net, settle, deliver" : `L2 block ${index + 1}`}
            >
              {isSync ? "sync" : index + 1}
            </div>
          );
        })}
      </div>

      <div className="stack">
        <div className="row small muted">
          <span>
            sell {assetA.symbol} · {formatUnits(sides.sellA, assetA.decimals, 4)}
          </span>
          <span>
            sell {assetB.symbol} · {formatUnits(sides.sellB, assetB.decimals, 4)}
          </span>
        </div>
        <div className="bars">
          <div className="bar" title={`${assetA.symbol} side`}>
            <span className="a" style={{ width: `${percent(sides.sellA, scale)}%` }} />
          </div>
          <div className="bar" title={`${assetB.symbol} side, valued in ${assetA.symbol} at the mirror`}>
            <span className="b" style={{ width: `${percent(sides.sellBInA, scale)}%` }} />
          </div>
          <div className="bar" title="what crosses inside the window, and what is left for L1">
            <span className="crossed" style={{ width: `${percent(sides.crossedInA, scale)}%` }} />
            <span className="residual" style={{ width: `${percent(sides.residualInA, scale)}%` }} />
          </div>
        </div>
        <div className="row small">
          <span className="muted">
            crossed {formatUnits(sides.crossedInA, assetA.decimals, 4)} {assetA.symbol}
            {sides.settled ? "" : " (indicative, at the mirror)"}
          </span>
          <span className="num">
            {window.nettingRatio === null ? "netting —" : `netting ${formatPercent(window.nettingRatio)}`}
          </span>
        </div>
      </div>

      <div className="orders-strip">
        {sides.orders.length === 0 ? (
          <span className="small faint">no orders in this window</span>
        ) : (
          sides.orders.map((order) => (
            <span
              key={order.id}
              className={`order-chip ${order.side === "SELL_A_FOR_B" ? "a" : "b"}${
                order.state === "rolled" ? " rolled" : order.state === "filled" ? " filled" : ""
              }`}
              title={`${order.id} — ${order.state}`}
            >
              {formatUnits(
                BigInt(order.sellAmount),
                order.side === "SELL_A_FOR_B" ? assetA.decimals : assetB.decimals,
                2,
              )}
            </span>
          ))
        )}
      </div>

      <div className="lane">
        <L1Lane state={state} window={window} settlement={settlement} />
      </div>

      {rolled.length === 0 ? null : (
        <Notice tone="warn">
          {rolled.length} order{rolled.length === 1 ? "" : "s"} fell outside their limit at the boundary and rolled to
          the next window. Nobody was filled worse than their limit (FL-8).
        </Notice>
      )}
    </Panel>
  );
}

function StateChip({ window }: { readonly window: Window }): React.JSX.Element {
  switch (window.state) {
    case "open":
      return <Chip tone="">open</Chip>;
    case "settling":
      return <Chip tone="">settling</Chip>;
    case "settled":
      return <Chip tone="ok">settled</Chip>;
    case "evicted":
      return <Chip tone="free">evicted — free</Chip>;
    case "rolled_back":
      return <Chip tone="repair">rolled back — repairing</Chip>;
    default:
      return <Chip>{window.state}</Chip>;
  }
}

/**
 * How the last settlement ended.
 *
 * It is a chip of its own because an evicted or rolled-back window returns to
 * `open` with its orders intact (A.4): at the moment the outcome matters most,
 * the window's own state has already moved on and only the settlement still
 * says what happened (FE-7).
 */
function OutcomeChip({ settlement }: { readonly settlement: Settlement }): React.JSX.Element {
  const label = `window ${settlement.windowId}`;
  switch (settlement.outcome) {
    case "evicted":
      return <Chip tone="free">{label} evicted — free</Chip>;
    case "rolled_back":
      return <Chip tone="repair">{label} rolled back — repairing</Chip>;
    case "submitted":
      return <Chip>{label} submitted</Chip>;
    default:
      return <Chip tone="ok">{label} settled</Chip>;
  }
}

/**
 * The L1 lane: the one cross-layer transaction, or the honest absence of one.
 *
 * An eviction has no receipt *because there was no transaction* — that is what
 * poison eviction is, and it is why the failure costs nothing (FL-7). The lane
 * says so with the receipt's own null rather than with an adjective.
 */
function L1Lane({
  state,
  window,
  settlement,
}: {
  readonly state: AppState;
  readonly window: Window;
  readonly settlement: Settlement | null;
}): React.JSX.Element {
  const { assetA, assetB } = state.config;

  if (settlement === null) {
    return (
      <p className="small faint">
        {window.state === "open"
          ? "The residual descends to L1 at the Sync block — one transaction for the whole window."
          : "No settlement observed for this window."}
      </p>
    );
  }

  const receipt = settlement.l1Receipt;
  const result = settlement.result;

  return (
    <div className="stack">
      <div className="row">
        <h3>
          L1 leg{settlement.windowId === window.windowId ? "" : ` · window ${settlement.windowId}`}
        </h3>
        <span className="small muted num">
          {settlement.filledOrderIds.length} fill{settlement.filledOrderIds.length === 1 ? "" : "s"} ·{" "}
          {settlement.droppedOrderIds.length} dropped
        </span>
      </div>

      {settlement.outcome === "rolled_back" ? (
        // The Sync block that carried these fills, struck through where it
        // was: the block un-happened, and that is what a rollback is (FE-7).
        <div className="blocks">
          <div className="block sync unhappened" title={`window ${settlement.windowId}'s Sync block, undone`}>
            sync
          </div>
        </div>
      ) : null}

      {settlement.outcome === "evicted" ? (
        <Notice tone="free">
          Poison-evicted at compose time. There is no L1 transaction and no receipt: <strong>no mainnet gas was
          spent</strong>, no order was partly filled, every escrow is untouched and every order stays open for the next
          window (FL-7).
        </Notice>
      ) : settlement.outcome === "rolled_back" ? (
        <Notice tone="repair">
          The Sync block un-happened: {rollbackText(settlement)}. The fills are undone and the orders are open again,
          intact — a repair, not an error.{" "}
          {settlement.l1GasSpent
            ? "L1 gas was spent on this one: the batch landed without the entry (SV-4)."
            : "No L1 gas was spent."}
        </Notice>
      ) : settlement.outcome === "submitted" ? (
        <Notice>Submitted at the Sync block. Nothing is confirmed until the leg returns.</Notice>
      ) : (
        <Notice tone="">One cross-layer transaction settled the whole window.</Notice>
      )}

      <Fact
        label="Residual to L1"
        value={`${formatUnits(BigInt(settlement.leg.residualIn), settlement.leg.residualSide === "SELL_A_FOR_B" ? assetA.decimals : assetB.decimals, 4)} ${settlement.leg.residualSide === "SELL_A_FOR_B" ? assetA.symbol : assetB.symbol}`}
      />
      {result === null ? (
        <p className="small faint">No leg result: the L1 call did not return.</p>
      ) : (
        <>
          <Fact
            label="Reference price P0"
            value={formatPriceX96(BigInt(result.referencePriceX96), assetA.decimals, assetB.decimals)}
            title="Read inside the L1 leg immediately before the swap. Every crossed fill clears here (FL-5)."
          />
          <Fact
            label="Execution price"
            value={formatPriceX96(BigInt(result.executionPriceX96), assetA.decimals, assetB.decimals)}
            title="The residual's realised average. The difference from P0 is the impact, borne by the residual side alone."
          />
          <Fact label="Fresh mirror at L1 block" value={String(result.l1Block)} />
        </>
      )}
      {receipt === null ? null : (
        <Fact
          label="L1 receipt"
          value={
            <a href={`${state.config.l1ExplorerUrl}${receipt.txHash}`} target="_blank" rel="noreferrer">
              {shortHash(receipt.txHash)} · {formatWeiCost(BigInt(receipt.gasCostWei))}
            </a>
          }
        />
      )}
    </div>
  );
}

function rollbackText(settlement: Settlement): string {
  switch (settlement.rollbackCause) {
    case "bundle_missed":
      return "the bundle was missed";
    case "reorg":
      return "L1 reorganised";
    case "postbatch_skip":
      return "the batch was posted without this entry";
    default:
      return "the reconciler has not classified it yet";
  }
}

/**
 * Drift and selection, made visible — RD-2 FE-7, FL-8, EC-2.
 *
 * Two facts, one panel. Mid-window: the gap between the mirror the zone is
 * quoting from and the L1 head the leg will execute against. At the boundary:
 * which orders fell outside their limit and rolled — FL-8 as a picture, with
 * each order's own limit beside the price the window actually cleared at, so
 * "nobody is filled worse than their limit" is something the user can check
 * rather than something the UI asserts.
 *
 * A rolled order is not a failure. It is the mechanism working: the cost of
 * drift is unfilled orders rolling forward, and nothing else (EC-2).
 */

import { formatBps, formatPercent, formatPriceX96, formatUnits, shortHash } from "../domain/format.ts";
import type { AppState } from "../state/app.ts";
import { drift, illegalTransitions, laneSettlement, rolledAt, theaterWindow } from "../state/selectors.ts";
import { Chip, Empty, Fact, Notice, Panel } from "./parts.tsx";

export function Drift({ state }: { readonly state: AppState }): React.JSX.Element {
  const gap = drift(state);
  const window = theaterWindow(state);
  const settlement = laneSettlement(state, window);
  const rolled = rolledAt(state, settlement?.windowId ?? window?.windowId ?? "");
  const illegal = illegalTransitions(state);
  const { assetA, assetB } = state.config;
  const rollRate = state.chain.metrics?.["roll_rate"] ?? null;

  return (
    <Panel
      title="Drift and selection"
      aside={rollRate === null ? <span>roll rate —</span> : <span>roll rate {formatPercent(rollRate)}</span>}
    >
      {gap === null ? (
        <Empty>
          The L1 head is not observable from here — no pool adapter is configured, or this is a recording. The mirror's
          age is still shown in every quote.
        </Empty>
      ) : (
        <div className="stack">
          <Fact
            label="Mirror"
            value={`${formatPriceX96(gap.mirrorPriceX96, assetA.decimals, assetB.decimals)} ${assetB.symbol}/${assetA.symbol}`}
          />
          <Fact
            label={`L1 head (block ${gap.l1Block})`}
            value={`${formatPriceX96(gap.l1PriceX96, assetA.decimals, assetB.decimals)} ${assetB.symbol}/${assetA.symbol}`}
          />
          <div className="row">
            <span className="small muted">Gap</span>
            <Chip tone={Math.abs(gap.bps) > 10 ? "warn" : "ok"}>{formatBps(gap.bps)}</Chip>
          </div>
        </div>
      )}

      {window === null ? null : (
        <div className="row small muted">
          <span>
            {window.orderIds.length} order{window.orderIds.length === 1 ? "" : "s"} in the window
          </span>
          <span className="num">
            {window.selectedOrderIds.length} selected
            {settlement === null ? "" : ` · ${settlement.filledOrderIds.length} filled`}
          </span>
        </div>
      )}

      {rolled.length === 0 ? (
        <p className="small faint">No order has rolled in this window.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Rolled</th>
              <th className="n">Its limit</th>
              <th className="n">Window cleared at</th>
              <th className="n">Rolled</th>
            </tr>
          </thead>
          <tbody>
            {rolled.map((order) => {
              const buy = order.side === "SELL_A_FOR_B" ? assetB : assetA;
              return (
                <tr key={order.id}>
                  <td className="num small">{shortHash(order.id)}</td>
                  <td className="n">
                    ≥ {formatUnits(BigInt(order.minBuyAmount), buy.decimals, 4)} {buy.symbol}
                  </td>
                  <td className="n">
                    {settlement?.result === null || settlement === null
                      ? "—"
                      : formatPriceX96(BigInt(settlement.result.referencePriceX96), assetA.decimals, assetB.decimals)}
                  </td>
                  <td className="n">×{order.rolledCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {illegal.length === 0 ? null : (
        <Notice tone="bad">
          {illegal.length} transition{illegal.length === 1 ? "" : "s"} the A.4 machines do not allow arrived on the
          stream — for example {illegal[0]?.subject} {shortHash(illegal[0]?.id ?? "")} moving{" "}
          {illegal[0]?.from} → {illegal[0]?.to}. That is a defect upstream, not a state to render as though it were
          ordinary.
        </Notice>
      )}
    </Panel>
  );
}

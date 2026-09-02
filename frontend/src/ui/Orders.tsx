/**
 * Order status, open orders and history — RD-2 FE-2, FE-4.
 *
 * FE-2 is a rule about words. An order is **pending in window** until the Sync
 * block, then **filled at price P** or **rolled to next window (limit not
 * met)**. There is no "confirmed" here, at any point, because there is no
 * moment before settlement at which the word would be true — and the price
 * shown is the fill's own `priceX96`, which the chain emitted: the window's
 * reference price for a crossed order, that price less its impact share for a
 * residual-side one (FL-5, CT-12).
 */

import type { Order, OrderState } from "@eez-dex/indexer/schema";

import { formatPriceX96, formatUnits, shortHash } from "../domain/format.ts";
import type { AppState } from "../state/app.ts";
import { historyOwnedBy, openOrdersOwnedBy } from "../state/selectors.ts";
import type { AppApi } from "./api.ts";
import { Chip, Empty, Panel } from "./parts.tsx";

/** FE-2's sentence for each A.4 order state. */
export function statusText(order: Order): string {
  switch (order.state) {
    case "open":
      return `pending in window ${order.windowId}`;
    case "selected":
      return `pending in window ${order.windowId} — selected for this settlement`;
    case "filled":
      return "filled";
    case "rolled":
      return `rolled to next window (limit not met)${order.rolledCount > 1 ? ` — ${order.rolledCount} times` : ""}`;
    case "cancelled":
      return "cancelled — escrow returned";
    case "expired":
      return "expired — escrow released";
    default:
      return order.state;
  }
}

/** The tone each state carries. Rolled is not a failure; it is FL-8 working. */
export function statusTone(state: OrderState): "" | "ok" | "warn" | "bad" {
  switch (state) {
    case "filled":
      return "ok";
    case "rolled":
      return "warn";
    case "cancelled":
    case "expired":
      return "";
    default:
      return "";
  }
}

export function Orders({ state, api }: { readonly state: AppState; readonly api: AppApi }): React.JSX.Element {
  const address = state.wallet.address;
  const open = openOrdersOwnedBy(state, address);
  const history = historyOwnedBy(state, address);
  const { assetA, assetB } = state.config;

  return (
    <>
      <Panel title="Your open orders" aside={<span>{open.length} open</span>}>
        {address === null ? (
          <Empty>Connect a wallet to see your orders. This app never holds a key of its own.</Empty>
        ) : open.length === 0 ? (
          <Empty>No open orders. A window with nothing in it is a quiet window, not an error.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th className="n">Sell</th>
                <th className="n">Limit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.map((order) => {
                const sell = order.side === "SELL_A_FOR_B" ? assetA : assetB;
                const buy = order.side === "SELL_A_FOR_B" ? assetB : assetA;
                return (
                  <tr key={order.id}>
                    <td className="num small">{shortHash(order.id)}</td>
                    <td className="small">
                      <Chip tone={statusTone(order.state)}>{statusText(order)}</Chip>
                    </td>
                    <td className="n">
                      {formatUnits(BigInt(order.sellAmount), sell.decimals, 4)} {sell.symbol}
                    </td>
                    <td className="n">
                      ≥ {formatUnits(BigInt(order.minBuyAmount), buy.decimals, 4)} {buy.symbol}
                    </td>
                    <td className="n">
                      <button
                        onClick={() => void api.cancelOrder(order.id)}
                        disabled={state.config.mode === "replay"}
                      >
                        cancel
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="History" aside={<span>{history.length} filled</span>}>
        {address === null ? (
          <Empty>Connect a wallet to see your fills.</Empty>
        ) : history.length === 0 ? (
          <Empty>No fills yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th className="n">Received</th>
                <th className="n">Clearing price</th>
                <th className="n">Fee</th>
                <th className="n">Impact</th>
                <th>L1 transaction</th>
              </tr>
            </thead>
            <tbody>
              {history.map(({ order, settlement }) => {
                const fill = order.fill;
                if (fill === null) return null;
                const sell = order.side === "SELL_A_FOR_B" ? assetA : assetB;
                const buy = order.side === "SELL_A_FOR_B" ? assetB : assetA;
                const receipt = settlement?.l1Receipt ?? null;
                return (
                  <tr key={order.id}>
                    <td className="num small">
                      {shortHash(order.id)}
                      <span className="faint"> {fill.crossed ? "crossed" : "residual"}</span>
                    </td>
                    <td className="n">
                      {formatUnits(BigInt(fill.amountOut), buy.decimals, 6)} {buy.symbol}
                    </td>
                    <td className="n">
                      {formatPriceX96(BigInt(fill.priceX96), assetA.decimals, assetB.decimals)}
                    </td>
                    <td className="n">
                      {formatUnits(BigInt(fill.feeAmount) + BigInt(fill.routeFeeAmount), sell.decimals, 8)}{" "}
                      {sell.symbol}
                    </td>
                    <td className="n">
                      {fill.crossed ? "—" : `${formatUnits(BigInt(fill.impactAmount), buy.decimals, 8)} ${buy.symbol}`}
                    </td>
                    <td className="small">
                      {receipt === null ? (
                        <span className="faint">no receipt observed</span>
                      ) : (
                        <a href={`${state.config.l1ExplorerUrl}${receipt.txHash}`} target="_blank" rel="noreferrer">
                          {shortHash(receipt.txHash)}
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

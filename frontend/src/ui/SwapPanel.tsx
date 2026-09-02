/**
 * The swap panel and its cost line — RD-2 FE-1, FE-3, FL-2, EC-1.
 *
 * The quote is the mirror's, and the two facts that qualify it — **the
 * mirror's age** and **the window's countdown** — sit beside it at the same
 * rank, not in a footnote (FL-2, FE-1). The limit shown is the one that will
 * be placed on-chain, so what the user reads is what `minBuyAmount` will be.
 *
 * The cost line takes IX-3's counterfactual from the stream and says whose
 * figure it is: "your last L1 swap cost" only when the indexer measured the
 * user's own address, the sampled median otherwise (FE-3, IX-3).
 */

import type { Side } from "@eez-dex/indexer/schema";

import { formatDuration, formatPriceX96, formatUnits, formatWeiCost, parseUnits } from "../domain/format.ts";
import { buildQuote, type QuoteResult } from "../domain/quote.ts";
import { tradingState } from "../mode.ts";
import type { AppState } from "../state/app.ts";
import { counterfactualFor, mirrorAgeSlots, slotClock, theaterWindow } from "../state/selectors.ts";
import type { AppApi } from "./api.ts";
import { Chip, Empty, Fact, Field, Notice, Panel } from "./parts.tsx";

/** The two sides, as the panel labels them. */
const SIDES: readonly Side[] = ["SELL_A_FOR_B", "SELL_B_FOR_A"];

export function SwapPanel({ state, api }: { readonly state: AppState; readonly api: AppApi }): React.JSX.Element {
  const { config, form, chain } = state;
  const side = form.side;
  const sell = side === "SELL_A_FOR_B" ? config.assetA : config.assetB;
  const buy = side === "SELL_A_FOR_B" ? config.assetB : config.assetA;
  const sellAmount = parseUnits(form.sellText, sell.decimals);
  const window = theaterWindow(state);
  const clock = slotClock(state, window);
  const age = mirrorAgeSlots(state);
  const trading = tradingState(config.mode, state.wallet.state === "connected");

  const result: QuoteResult = buildQuote({
    mirror: chain.mirror,
    sellAmount: sellAmount ?? 0n,
    side,
    slippageBps: form.slippageBps,
    fee: config.fee,
    nowUnix: state.nowUnix,
  });

  const counterfactual = counterfactualFor(state, state.wallet.address);

  return (
    <Panel
      title="Swap"
      aside={
        <>
          <Chip tone={age === null ? "warn" : age > 1 ? "warn" : "ok"}>
            mirror {age === null ? "not observed" : `${age} slot${age === 1 ? "" : "s"} old`}
          </Chip>
          <Chip tone={clock?.stalled === true ? "warn" : ""}>
            {clock === null
              ? "no window"
              : clock.stalled
                ? "window stalled"
                : `settles in ${formatDuration(clock.total - clock.elapsed)}`}
          </Chip>
        </>
      }
    >
      <div className="row-tight">
        {SIDES.map((option) => (
          <button
            key={option}
            className={option === side ? "primary" : ""}
            onClick={() => api.dispatch({ type: "form", form: { side: option } })}
          >
            sell {option === "SELL_A_FOR_B" ? config.assetA.symbol : config.assetB.symbol}
          </button>
        ))}
      </div>

      <Field label={`Sell (${sell.symbol})`}>
        <input
          inputMode="decimal"
          className="num"
          placeholder="0.0"
          value={form.sellText}
          onChange={(event) => api.dispatch({ type: "form", form: { sellText: event.target.value } })}
        />
      </Field>

      <Field label="Slippage (basis points)">
        <input
          inputMode="numeric"
          className="num"
          value={String(form.slippageBps)}
          onChange={(event) =>
            api.dispatch({ type: "form", form: { slippageBps: Number(event.target.value) || 0 } })
          }
        />
      </Field>

      {result.ok ? (
        <>
          <div className="stack">
            <Fact
              label={`Indicative ${buy.symbol}`}
              value={formatUnits(result.quote.amountOut, buy.decimals, 6)}
              title="Quoted against the mirror, which is one settlement stale at most. The binding price is the one the L1 leg returns."
            />
            <Fact
              label="Indicative price"
              value={`${formatPriceX96(result.quote.priceX96, config.assetA.decimals, config.assetB.decimals)} ${config.assetB.symbol}/${config.assetA.symbol}`}
            />
            <Fact
              label={`Limit — minimum ${buy.symbol}`}
              value={formatUnits(result.quote.minBuyAmount, buy.decimals, 6)}
              title="Placed on-chain as minBuyAmount. No fill may be below it (CT-10)."
            />
          </div>

          <div className="stack">
            <h3 className="small muted">Cost</h3>
            <Fact
              label={
                config.fee.mode === "bps" ? `Protocol fee (${config.fee.bps.toString()} bp)` : "Protocol fee (fixed)"
              }
              value={`${formatUnits(result.quote.fee, sell.decimals, 8)} ${sell.symbol}`}
            />
            <Fact
              label={
                config.fee.routeFeeModel === "absorb"
                  ? "Route fee — absorbed by the protocol"
                  : "Route fee — your share"
              }
              value={`${formatUnits(result.quote.routeFee, sell.decimals, 8)} ${sell.symbol}`}
              title="The L1 leg's gas and batch-post share. Zero at launch: ROUTE_FEE_MODEL=absorb (EC-1)."
            />
            {counterfactual === null ? (
              <p className="small faint">
                Direct-L1 comparison: not observed yet. The indexer states it from your own last L1 swap, or from the
                sampled retail median — never from an estimate.
              </p>
            ) : (
              <Fact
                label={
                  counterfactual.source === "user_last_l1_swap"
                    ? "Your last L1 swap cost"
                    : "A retail L1 swap costs (sampled median)"
                }
                value={formatWeiCost(counterfactual.gasCostWei)}
                title="IX-3 computes this once, in the indexer, so every view agrees."
              />
            )}
          </div>
        </>
      ) : (
        <Empty>{problemText(result.problem.kind)}</Empty>
      )}

      {trading === "disabled" ? (
        <Notice>Replay is a recording. Placing an order would be a claim about a chain that is not there.</Notice>
      ) : trading === "read_only" ? (
        <div className="stack">
          <Notice>Read-only: connect a wallet on this chain to place an order.</Notice>
          <button onClick={() => void api.connectWallet()}>Connect wallet</button>
          {state.wallet.error === null ? null : <p className="small faint">{state.wallet.error}</p>}
        </div>
      ) : (
        <button
          className="primary"
          disabled={!result.ok}
          onClick={() => {
            if (result.ok) void api.placeOrder(result.quote);
          }}
        >
          Place order
        </button>
      )}

      {state.submissions.length === 0 ? null : (
        <p className="small faint">
          {state.submissions[0]?.state === "failed"
            ? `Last action failed: ${state.submissions[0]?.detail ?? "the wallet declined"}`
            : `Last action ${state.submissions[0]?.state}. An order is not confirmed until its window settles.`}
        </p>
      )}
    </Panel>
  );
}

function problemText(kind: "no_mirror" | "no_amount" | "fee_exceeds_order" | "no_liquidity"): string {
  switch (kind) {
    case "no_mirror":
      return "No mirror observed yet — nothing to quote against.";
    case "no_amount":
      return "Enter an amount to see a quote.";
    case "fee_exceeds_order":
      return "The fee would exceed the order. Sell more than the fee.";
    case "no_liquidity":
      return "The mirror has no liquidity in range at this size.";
    default:
      return "No quote.";
  }
}

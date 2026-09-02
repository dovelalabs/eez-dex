/**
 * The amortisation counter — RD-2 FE-6, IX-3, EC-5.
 *
 * Per settlement and cumulative: fills per L1 transaction, gas per fill against
 * the direct-L1 counterfactual, and the saving. **Every figure here is read
 * from the stream.** IX-3 computes them once in the indexer precisely so this
 * panel and the swap panel's cost line cannot disagree; the only arithmetic
 * done here is the addition across settlements, and it is done once.
 *
 * The counterfactual has two honest sources and no third. Where the indexer
 * observed neither, a settlement carries no amortisation and this panel says
 * so — a saving quoted against a made-up denominator is a made-up saving.
 */

import { formatWeiCost } from "../domain/format.ts";
import type { AppState } from "../state/app.ts";
import { amortisations, cumulativeAmortisation } from "../state/selectors.ts";
import { Empty, Fact, Panel } from "./parts.tsx";

export function Amortisation({ state }: { readonly state: AppState }): React.JSX.Element {
  const perSettlement = amortisations(state);
  const total = cumulativeAmortisation(state);

  return (
    <Panel title="Amortisation" aside={<span>IX-3, from the stream</span>}>
      {perSettlement.length === 0 ? (
        <Empty>
          No settlement has produced an L1 receipt yet. Fills per transaction and the direct-L1 comparison appear when
          one does.
        </Empty>
      ) : (
        <>
          <div className="stack">
            <Fact
              label="Fills per L1 transaction (cumulative)"
              value={total.fillsPerSettlement === null ? "—" : total.fillsPerSettlement.toFixed(2)}
              title="One cross-layer transaction per window, however many fills it settles (FL-5, EC-5)."
            />
            <Fact
              label="Gas per fill"
              value={total.gasPerFillWei === null ? "—" : formatWeiCost(total.gasPerFillWei)}
            />
            <Fact
              label="The same fills as direct L1 swaps"
              value={formatWeiCost(total.counterfactualGasCostWei)}
            />
            <Fact
              label="Saved"
              value={`${total.savingsWei < 0n ? "−" : ""}${formatWeiCost(
                total.savingsWei < 0n ? -total.savingsWei : total.savingsWei,
              )}`}
              title="Counterfactual less what the settlements actually cost. Negative is a real answer."
            />
          </div>

          <table>
            <thead>
              <tr>
                <th>Window</th>
                <th className="n">Fills</th>
                <th className="n">L1 gas</th>
                <th className="n">Per fill</th>
                <th className="n">Direct L1</th>
                <th className="n">Saved</th>
              </tr>
            </thead>
            <tbody>
              {[...perSettlement].reverse().map((entry) => {
                const savings = BigInt(entry.savingsWei);
                return (
                  <tr key={entry.settlementId}>
                    <td className="num">{entry.windowId}</td>
                    <td className="n">{entry.fills}</td>
                    <td className="n">{formatWeiCost(BigInt(entry.l1GasCostWei))}</td>
                    <td className="n">
                      {entry.gasPerFillWei === null ? "—" : formatWeiCost(BigInt(entry.gasPerFillWei))}
                    </td>
                    <td className="n">{formatWeiCost(BigInt(entry.counterfactualGasCostWei))}</td>
                    <td className="n">
                      {savings < 0n ? "−" : ""}
                      {formatWeiCost(savings < 0n ? -savings : savings)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small faint">
            Counterfactuals come from each user's own last L1 swap where the indexer observed one, and from the sampled
            retail median otherwise (IX-3).
          </p>
        </>
      )}
    </Panel>
  );
}

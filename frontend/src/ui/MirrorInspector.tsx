/**
 * The mirror inspector — RD-2 FE-8, FL-1, CT-14.
 *
 * The mirror is a working copy of a real pool, refreshed from the return data
 * of every settlement, and never more than one settlement stale (FL-1). This
 * panel states it against the L1 pool's live state where that is observable,
 * gives its age in slots as the chain computes it — `(now − mirrorTimestamp) /
 * 12`, because the L1 head is not visible from L2 (CT-8) — and lists the
 * refreshes behind it, each with the reason it happened.
 */

import { formatBps, formatClock, formatPriceX96, groupThousands, shortHash } from "../domain/format.ts";
import { differenceBps, spotPriceX96 } from "../domain/q96.ts";
import type { AppState } from "../state/app.ts";
import { drift, mirrorAgeSlots } from "../state/selectors.ts";
import { Chip, Empty, Fact, Panel } from "./parts.tsx";

/** What each mirror source means, in one line (schema/mirror.ts). */
const SOURCE_TEXT: Readonly<Record<string, string>> = {
  settlement: "adopted from a settlement's result",
  refresh: "an empty settlement taken because the mirror aged",
  genesis: "the state the book was deployed with",
};

export function MirrorInspector({ state }: { readonly state: AppState }): React.JSX.Element {
  const mirror = state.chain.mirror;
  const age = mirrorAgeSlots(state);
  const gap = drift(state);
  const pool = state.status?.l1Pool ?? null;
  const { assetA, assetB } = state.config;

  if (mirror === null) {
    return (
      <Panel title="Mirror">
        <Empty>No mirror snapshot has arrived. Quotes are unavailable until one does.</Empty>
      </Panel>
    );
  }

  const mirrorPrice = spotPriceX96(mirror.state);

  return (
    <Panel
      title="Mirror"
      aside={
        <Chip tone={age !== null && age > 1 ? "warn" : "ok"}>
          {age === null ? "age unknown" : `${age} slot${age === 1 ? "" : "s"} old`}
        </Chip>
      }
    >
      <div className="stack">
        <Fact
          label="Spot (mirror)"
          value={`${formatPriceX96(mirrorPrice, assetA.decimals, assetB.decimals)} ${assetB.symbol}/${assetA.symbol}`}
        />
        <Fact
          label="Reference price P0 (latestPrice)"
          value={formatPriceX96(BigInt(mirror.referencePriceX96), assetA.decimals, assetB.decimals)}
          title="What latestPrice() returns: the last settlement's P0 (CT-14)."
        />
        <Fact label="Liquidity in range" value={groupThousands(mirror.state.liquidity)} />
        <Fact label="Tick" value={String(mirror.state.tick)} />
        <Fact label="Read at L1 block" value={String(mirror.l1Block)} />
        <Fact label="Stamped at" value={formatClock(mirror.mirrorTimestamp)} />
        <Fact label="Source" value={SOURCE_TEXT[mirror.source] ?? mirror.source} />
      </div>

      <div className="stack">
        <h3 className="small muted">Against the L1 pool</h3>
        {pool === null ? (
          <p className="small faint">
            The live pool is not observable from here: no adapter configured, or this is a recording. Absence is stated,
            not filled in with a guess.
          </p>
        ) : (
          <>
            <Fact
              label={`Live spot (L1 block ${pool.l1Block})`}
              value={`${formatPriceX96(spotPriceX96(pool.state), assetA.decimals, assetB.decimals)} ${assetB.symbol}/${assetA.symbol}`}
            />
            <Fact
              label="Difference"
              value={formatBps(gap?.bps ?? differenceBps(mirrorPrice, spotPriceX96(pool.state)) ?? 0)}
            />
            <Fact label="Read at" value={formatClock(pool.observedAtUnix)} />
          </>
        )}
      </div>

      <div className="stack">
        <h3 className="small muted">Refresh history</h3>
        <table>
          <thead>
            <tr>
              <th>Window</th>
              <th>Why</th>
              <th className="n">L1 block</th>
              <th className="n">P0</th>
            </tr>
          </thead>
          <tbody>
            {state.chain.mirrorHistory.map((snapshot, index) => (
              <tr key={`${snapshot.windowId}-${snapshot.l1Block}-${index}`}>
                <td className="num">{snapshot.windowId}</td>
                <td className="small muted">{snapshot.source}</td>
                <td className="n">{snapshot.l1Block}</td>
                <td className="n">
                  {formatPriceX96(BigInt(snapshot.referencePriceX96), assetA.decimals, assetB.decimals)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {state.chain.mirrorHistory.length <= 1 ? (
          <p className="small faint">
            One snapshot so far{state.chain.mirror === null ? "" : ` (${shortHash(state.chain.mirror.state.sqrtPriceX96)})`}.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

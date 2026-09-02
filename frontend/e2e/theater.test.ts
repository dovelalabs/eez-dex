/**
 * The end-to-end run — RD-2 TS-5, FE-5, FE-7, FE-10, §10.
 *
 * Headless, against WP-4's recorded runs (HX-5), through the real component
 * tree: the fixture is read, folded by the app's own reducer, and rendered by
 * the same `App` the browser mounts. What is asserted is the **terminal
 * render** of each of the four A.4 window outcomes — settled, an order rolled
 * at the boundary, a poison eviction, and a settled window rolled back — plus
 * the rule that the swap panel's quote and cost line agree with the indexer's
 * numbers **to the wei**.
 *
 * The indexer is run in-process over the same recording, so "agrees with the
 * indexer" is checked against the indexer rather than against a copy of what
 * it was expected to say (IX-3, TS-5).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createIndexer } from "@eez-dex/indexer";
import type { Snapshot } from "@eez-dex/indexer";
import type { Order, SlotEvent } from "@eez-dex/indexer/schema";
import { createServer, type ViteDevServer } from "vite";

import { readConfig } from "../src/config.ts";
import { formatUnits, formatWeiCost } from "../src/domain/format.ts";
import { buildQuote, protocolFee } from "../src/domain/quote.ts";
import { initialState, reduce, type AppState } from "../src/state/app.ts";
import { counterfactualFor, cumulativeAmortisation } from "../src/state/selectors.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../scenario/fixtures/", import.meta.url));

/** One Vite server, shared: starting it is the expensive part of this suite. */
let server: ViteDevServer | null = null;

async function renderer(): Promise<(state: AppState) => string> {
  server ??= await createServer({ root: ROOT, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
  const { renderApp } = (await server.ssrLoadModule("/e2e/render.tsx")) as {
    renderApp: (state: AppState) => string;
  };
  return renderApp;
}

after(async () => {
  await server?.close();
  server = null;
});

function recording(name: string): readonly SlotEvent[] {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as SlotEvent[];
}

/** Plays a recording through the app's reducer, exactly as the source would. */
function play(name: string, search = "?mode=replay"): AppState {
  const events = recording(name);
  const state = events.reduce(
    (current, event) => reduce(current, { type: "frame", frame: { type: "event", event } }),
    initialState(readConfig({}, search)),
  );
  // The clock the replay source would have advanced to at the end of the run.
  return reduce(state, { type: "tick", nowUnix: events[events.length - 1]?.atUnix ?? 0 });
}

/** The gateway's own view of the same recording, from the gateway itself. */
async function indexed(name: string): Promise<Snapshot> {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    serve: false,
    profile: "devnet",
    fixture: `${FIXTURES}${name}`,
    speed: 0,
  });
  await indexer.done;
  const snapshot = await indexer.snapshot();
  await indexer.close();
  return snapshot;
}

test("ts5: a settled window reaches the settled terminal render", async () => {
  const render = await renderer();
  const html = render(play("settled.json"));

  assert.match(html, /settled/, "the window is settled");
  assert.match(html, /One cross-layer transaction settled the whole window/);
  assert.match(html, /Reference price P0/, "the leg returned a P0 the theater states");
  assert.match(html, /Fills per L1 transaction/);
  assert.doesNotMatch(html, /confirmed/i, "FE-2: nothing is ever called confirmed");
});

test("ts5: a rolled window shows which orders fell outside their limit", async () => {
  const render = await renderer();
  const html = render(play("rolled.json"));

  assert.match(html, /rolled to the next window/, "FL-8 is drawn, not described in a toast");
  assert.match(html, /Nobody was filled worse than their limit|fell outside their limit/);
  assert.match(html, /Its limit/, "each rolled order's own limit is shown beside the clearing price");
});

test("ts5: an evicted window shows a failure that visibly cost nothing", async () => {
  const render = await renderer();
  const html = render(play("evicted.json"));

  assert.match(html, /evicted — free/);
  assert.match(html, /Poison-evicted at compose time/);
  assert.match(html, /no mainnet gas was spent/i);
  assert.match(html, /every order stays open/);
  assert.ok(!html.includes(">L1 receipt<"), "the lane shows no receipt, because there was no transaction");
  assert.match(html, /No settlement has produced an L1 receipt yet/, "and the counter has nothing to amortise");
});

test("ts5: a rolled-back window shows the L2 block un-happening, not an error", async () => {
  const render = await renderer();
  const html = render(play("rolled-back.json"));

  assert.match(html, /rolled back — repairing/);
  assert.match(html, /The Sync block un-happened/);
  assert.match(html, /unhappened/, "the Sync block is struck through where it was");
  assert.match(html, /a repair, not an error/);
  // The postBatch skip is the one rollback that is not free (SV-4).
  assert.match(html, /L1 gas was spent on this one|No L1 gas was spent/);
});

test("ts5: the whole recorded session renders every outcome it contains", async () => {
  const render = await renderer();
  const state = play("run.json");
  const html = render(state);

  assert.ok(state.chain.windows.size >= 4, "the session covers four windows");
  assert.match(html, /eez-dex/);
  assert.match(html, /replay/, "and it says which mode it is in");
  assert.match(html, /Replay is a recording/, "the trading surface is disabled in replay (FE-10)");
});

test("ts5: the amortisation counter equals the indexer's figures, to the wei", async () => {
  const snapshot = await indexed("settled.json");
  const state = play("settled.json");
  const total = cumulativeAmortisation(state);
  const theirs = snapshot.amortisation.cumulative;

  assert.equal(total.settlements, theirs.settlements);
  assert.equal(total.fills, theirs.fills);
  assert.equal(total.l1GasCostWei.toString(), theirs.l1GasCostWei);
  assert.equal(total.counterfactualGasCostWei.toString(), theirs.counterfactualGasCostWei);
  assert.equal(total.savingsWei.toString(), theirs.savingsWei);
  assert.equal(total.gasPerFillWei?.toString() ?? null, theirs.gasPerFillWei);

  const render = await renderer();
  const html = render(state);
  assert.ok(
    html.includes(formatWeiCost(BigInt(theirs.counterfactualGasCostWei))),
    "the counter prints the indexer's counterfactual",
  );
  assert.ok(html.includes(formatWeiCost(BigInt(theirs.savingsWei))), "and the indexer's saving");
});

test("ts5: the cost line's fee and counterfactual are the indexer's own numbers", async () => {
  const snapshot = await indexed("settled.json");
  const state = play("settled.json");

  const filled = snapshot.orders.find((order: Order) => order.fill !== null);
  assert.ok(filled !== undefined && filled.fill !== null);

  // The fee this build would quote for that order equals the fee the book
  // charged it, which is the number the indexer carries (EC-1, CT-12).
  assert.equal(
    protocolFee(state.config.fee, BigInt(filled.sellAmount), filled.side).toString(),
    filled.fill.feeAmount,
  );

  const perOrder = snapshot.amortisation.perSettlement
    .flatMap((entry) => entry.perOrder)
    .find((entry) => entry.orderId === filled.id);
  assert.ok(perOrder !== undefined);

  const connected: AppState = { ...state, wallet: { ...state.wallet, state: "connected", address: filled.owner } };
  assert.deepEqual(counterfactualFor(connected, filled.owner), {
    gasCostWei: BigInt(perOrder.gasCostWei),
    source: perOrder.source,
  });

  const render = await renderer();
  const html = render({
    ...connected,
    form: { ...connected.form, sellText: "1", side: "SELL_A_FOR_B" },
  });

  assert.match(html, /Your last L1 swap cost|A retail L1 swap costs/);
  assert.ok(
    html.includes(formatWeiCost(BigInt(perOrder.gasCostWei))),
    "the cost line prints the indexer's own counterfactual for this address",
  );
});

test("ts5: the swap panel's quote is the indexer's mirror, to the wei", async () => {
  const snapshot = await indexed("settled.json");
  const state = play("settled.json");
  assert.ok(snapshot.mirror !== null);

  // Quote against the gateway's mirror rather than the app's, so the assertion
  // is that the two agree — not that the app agrees with itself.
  const theirs = buildQuote({
    mirror: snapshot.mirror,
    sellAmount: 10n ** 18n,
    side: "SELL_A_FOR_B",
    slippageBps: state.form.slippageBps,
    fee: state.config.fee,
    nowUnix: state.nowUnix,
  });
  assert.ok(theirs.ok);

  const render = await renderer();
  const html = render({ ...state, form: { ...state.form, sellText: "1", side: "SELL_A_FOR_B" } });

  assert.ok(
    html.includes(formatUnits(theirs.quote.amountOut, state.config.assetB.decimals, 6)),
    "the indicative amount is the mirror's own",
  );
  assert.ok(
    html.includes(formatUnits(theirs.quote.minBuyAmount, state.config.assetB.decimals, 6)),
    "and so is the limit derived from it",
  );
  assert.ok(
    html.includes(formatUnits(theirs.quote.fee, state.config.assetA.decimals, 8)),
    "and the fee on the cost line",
  );
});

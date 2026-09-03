/**
 * The frontend against a live gateway — RD-2 IX-1, FE-3, FE-10, TS-5, §10.
 *
 * Phase 6, part A item 4. The suite beside this one folds a recording read
 * from disk; this one reads nothing. It starts the **real** gateway on a real
 * port, connects the app's **real** socket source to it over a real
 * WebSocket, and folds the frames that arrive with the app's own reducer.
 *
 * Two things are asserted that no fixture-fed test can assert. First, that the
 * wire is wired: the snapshot and the event frames the gateway sends are the
 * frames this app parses, and the state they build is the state the file
 * builds. Second, that the swap panel's quote and its cost line equal the
 * numbers **the gateway is serving right now**, to the wei — not a copy of
 * what it was expected to serve.
 *
 * The gateway is replaying an HX-5 recording, and nothing here can tell:
 * that is IX-1, checked by not having a branch for it.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createIndexer, type Indexer, type Snapshot } from "@eez-dex/indexer";

import { readConfig } from "../src/config.ts";
import { formatUnits, formatWeiCost } from "../src/domain/format.ts";
import { buildQuote } from "../src/domain/quote.ts";
import { cumulativeAmortisation } from "../src/state/selectors.ts";
import { initialState, reduce, type Action, type AppState } from "../src/state/app.ts";
import { SocketSource } from "../src/stream/socket.ts";
import { createServer, type ViteDevServer } from "vite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../scenario/fixtures/", import.meta.url));

/** The recording the gateway serves, accelerated so the suite is seconds. */
const RECORDING = "settled.json";
const SPEED = 40;

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

/** What one connected session saw. */
interface Session {
  readonly state: AppState;
  readonly snapshotFrames: number;
  readonly eventFrames: number;
  readonly connection: string;
}

/**
 * Runs the app's socket source against a gateway until the replay ends,
 * folding every frame with the app's own reducer.
 */
async function connect(indexer: Indexer, search: string): Promise<Session> {
  let state = initialState(readConfig({}, `${search}&indexer=http://127.0.0.1:${indexer.port}`));
  let snapshotFrames = 0;
  let eventFrames = 0;
  let connection = "";

  const dispatch = (action: Action): void => {
    if (action.type === "frame" && action.frame.type === "snapshot") snapshotFrames += 1;
    if (action.type === "frame" && action.frame.type === "event") eventFrames += 1;
    if (action.type === "connection") connection = action.state;
    state = reduce(state, action);
  };

  const source = new SocketSource({ indexerUrl: `http://127.0.0.1:${indexer.port}`, dispatch });
  source.start();
  try {
    await indexer.done;
    // The last frames are in flight when the replay resolves; let the socket
    // drain rather than asserting against a partially delivered stream.
    await settle(() => eventFrames > 0 && state.chain.settlementIds.length > 0);
  } finally {
    source.stop();
  }
  return { state, snapshotFrames, eventFrames, connection };
}

/** Waits, briefly, for a condition the socket will satisfy or fail loudly. */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(done(), "the gateway's stream never arrived");
}

async function gateway(): Promise<Indexer> {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    profile: "devnet",
    fixture: `${FIXTURES}${RECORDING}`,
    speed: SPEED,
  });
  after(() => indexer.close());
  return indexer;
}

test("ix1: the app folds the gateway's own frames off a real socket", async () => {
  const indexer = await gateway();
  const session = await connect(indexer, "?mode=observe");
  const served: Snapshot = await indexer.snapshot();

  assert.equal(session.connection, "open", "the socket connected and stayed open");
  assert.ok(session.snapshotFrames > 0, "a client is levelled before it is streamed to");
  assert.ok(session.eventFrames > 0, "and then streamed to: these frames arrived live");

  // The state the wire built is the state the gateway holds.
  assert.deepEqual(
    [...session.state.chain.windows.values()].map((window) => [window.windowId, window.state]),
    served.windows.map((window) => [window.windowId, window.state]),
    "every window, in the gateway's own order and state",
  );
  assert.deepEqual(
    [...session.state.chain.orders.values()].map((order) => [order.id, order.state]).sort(),
    served.orders.map((order) => [order.id, order.state]).sort(),
    "every order, in the gateway's own state",
  );
  assert.deepEqual(session.state.chain.settlementIds, served.settlements.map((settlement) => settlement.id));
});

test("§10: the amortisation counter equals the live gateway's, to the wei", async () => {
  const indexer = await gateway();
  const session = await connect(indexer, "?mode=observe");
  const served = (await indexer.snapshot()).amortisation.cumulative;
  const ours = cumulativeAmortisation(session.state);

  assert.equal(ours.settlements, served.settlements);
  assert.equal(ours.fills, served.fills);
  assert.equal(ours.l1GasCostWei.toString(), served.l1GasCostWei);
  assert.equal(ours.counterfactualGasCostWei.toString(), served.counterfactualGasCostWei);
  assert.equal(ours.savingsWei.toString(), served.savingsWei);
  assert.equal(ours.gasPerFillWei?.toString() ?? null, served.gasPerFillWei);
  assert.ok(ours.fills > 0, "this recording settles fills, or the equality above is vacuous");
});

test("fe1, fe3: the quote and the cost line are the live gateway's numbers", async () => {
  const indexer = await gateway();
  const session = await connect(indexer, "?mode=observe");
  const served = await indexer.snapshot();
  assert.ok(served.mirror !== null, "the gateway is serving a mirror");

  // Quote against the gateway's mirror, not the app's, so what is asserted is
  // that the two agree rather than that the app agrees with itself.
  const theirs = buildQuote({
    mirror: served.mirror,
    sellAmount: 10n ** 18n,
    side: "SELL_A_FOR_B",
    slippageBps: session.state.form.slippageBps,
    fee: session.state.config.fee,
    nowUnix: session.state.nowUnix,
  });
  assert.ok(theirs.ok);

  const render = await renderer();
  const html = render({ ...session.state, form: { ...session.state.form, sellText: "1", side: "SELL_A_FOR_B" } });

  const { assetA, assetB } = session.state.config;
  assert.ok(
    html.includes(formatUnits(theirs.quote.amountOut, assetB.decimals, 6)),
    "the indicative amount is the gateway's mirror's own",
  );
  assert.ok(
    html.includes(formatUnits(theirs.quote.minBuyAmount, assetB.decimals, 6)),
    "and so is the limit derived from it",
  );
  assert.ok(html.includes(formatUnits(theirs.quote.fee, assetA.decimals, 8)), "and the fee on the cost line");
  assert.ok(
    html.includes(formatWeiCost(BigInt((await indexer.snapshot()).amortisation.cumulative.counterfactualGasCostWei))),
    "and the counter prints the gateway's counterfactual",
  );
});

test("ix1: nothing in the app can tell the gateway is replaying a recording", async () => {
  const indexer = await gateway();
  const session = await connect(indexer, "?mode=observe");
  const render = await renderer();
  const html = render(session.state);

  // Observe mode, pointed at a gateway that happens to be replaying: the
  // trading surface is read-only and there is not one demo affordance.
  assert.match(html, /observe/, "the app says which mode it is in");
  assert.doesNotMatch(html, /Replay is a recording/, "this app is not replaying: the gateway is");
  assert.doesNotMatch(html, /Generate a burst|Move the pool|Stall the builder/, "FE-9: no director outside demo");
});

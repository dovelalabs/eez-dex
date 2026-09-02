/**
 * The window soak — RD-2 HX-4.
 *
 * 200 slots of randomised order flow from many accounts against a random-walk
 * pool price, settler unattended. It passes on three things: zero
 * escrow-invariant drift, every order in a terminal state, and the
 * amortisation metrics and `roll_rate` reported.
 *
 * The flow is *planned* rather than improvised, and the plan is a pure
 * function of the seed. That is what makes a soak that fails at slot 173
 * something you can run again: `--soak --slots 200 --seed 1` is the whole
 * reproduction. The plan is JSON, so the shell drives the enclave from the
 * same document the hermetic run drives the simulation from.
 */

import { Q96, fromBig, mulDiv, spotPriceX96, toBig } from "./math.ts";
import type { BookParams } from "./book.ts";
import { sqrtPriceForPrice } from "./pool.ts";
import type { Pool } from "./pool.ts";
import { Rng } from "./rng.ts";
import { Simulation } from "./simulate.ts";
import type { GasModel } from "./simulate.ts";
import { TRADERS } from "./accounts.ts";
import type { Side } from "../../indexer/schema/index.ts";

/** Prices are carried as parts per million of one B per A, so the plan is JSON. */
export const PRICE_SCALE = 1_000_000n;

/** How the soak is generated. */
export interface SoakOptions {
  readonly seed: bigint;
  readonly slots: number;
  /** The pool's starting price, B per A, scaled by {@link PRICE_SCALE}. */
  readonly startPrice: bigint;
  /** The random walk's step, in basis points, each slot. */
  readonly driftBps: number;
  /** Orders placed per slot, inclusive. */
  readonly ordersPerSlot: readonly [number, number];
  /** One in this many open orders is cancelled each slot. */
  readonly cancelOneIn: number;
  /** How many windows an order lives for (A.4's `expired`). */
  readonly expiresAfter: number;
}

/** The default soak: `--soak --slots 200 --seed 1`. */
export const DEFAULT_SOAK: SoakOptions = {
  seed: 1n,
  slots: 200,
  startPrice: 3000n * PRICE_SCALE,
  driftBps: 25,
  ordersPerSlot: [0, 3],
  cancelOneIn: 12,
  expiresAfter: 2,
};

/** One thing the soak does. */
export type SoakAction =
  | {
      readonly kind: "place";
      readonly trader: string;
      readonly side: Side;
      readonly sellAmount: string;
      readonly minBuyAmount: string;
      readonly expiresAfter: number;
    }
  | { readonly kind: "cancel"; readonly openIndex: number }
  | { readonly kind: "drift"; readonly price: string };

/** One slot of the soak. */
export interface SoakSlot {
  readonly slot: number;
  readonly actions: readonly SoakAction[];
}

/** The whole plan, reproducible from its seed. */
export interface SoakPlan {
  readonly seed: string;
  readonly slots: readonly SoakSlot[];
  readonly options: {
    readonly slots: number;
    readonly startPrice: string;
    readonly driftBps: number;
    readonly expiresAfter: number;
  };
}

const ONE = 10n ** 18n;

/** Reads the CLI's JSON into options, filling in the defaults. */
export function soakOptions(input: unknown): SoakOptions {
  const raw = (input ?? {}) as Record<string, unknown>;
  const number = (key: string, fallback: number): number =>
    raw[key] === undefined ? fallback : Number(raw[key]);
  return {
    seed: raw["seed"] === undefined ? DEFAULT_SOAK.seed : BigInt(String(raw["seed"])),
    slots: number("slots", DEFAULT_SOAK.slots),
    startPrice:
      raw["startPrice"] === undefined ? DEFAULT_SOAK.startPrice : BigInt(String(raw["startPrice"])),
    driftBps: number("driftBps", DEFAULT_SOAK.driftBps),
    ordersPerSlot: DEFAULT_SOAK.ordersPerSlot,
    cancelOneIn: number("cancelOneIn", DEFAULT_SOAK.cancelOneIn),
    expiresAfter: number("expiresAfter", DEFAULT_SOAK.expiresAfter),
  };
}

/**
 * The plan. Limits are set against the price as the walk stands when the order
 * is placed, at a tolerance drawn per order — which is what makes some orders
 * roll when the price moves and others not, and so what makes `roll_rate` a
 * measurement rather than a constant.
 */
export function soakPlan(input: unknown): SoakPlan {
  const options = soakOptions(input);
  const rng = new Rng(options.seed);
  const slots: SoakSlot[] = [];

  let price = options.startPrice;
  let open = 0;

  for (let slot = 0; slot < options.slots; slot += 1) {
    const actions: SoakAction[] = [];

    // The random walk: one step per slot, up or down by up to `driftBps`.
    const step = BigInt(rng.intInRange(-options.driftBps, options.driftBps));
    price = (price * (10_000n + step)) / 10_000n;
    if (price < PRICE_SCALE) price = PRICE_SCALE;
    actions.push({ kind: "drift", price: fromBig(price) });

    const [low, high] = options.ordersPerSlot;
    const count = rng.intInRange(low, high);
    const priceX96 = spotPriceX96(sqrtPriceForPrice(price, PRICE_SCALE));

    for (let i = 0; i < count; i += 1) {
      const trader = rng.pick(TRADERS);
      const side: Side = rng.chance(1, 2) ? "SELL_A_FOR_B" : "SELL_B_FOR_A";
      const toleranceBps = BigInt(rng.intInRange(5, 60));
      const sellAmount =
        side === "SELL_A_FOR_B"
          ? rng.inRange(ONE / 4n, 6n * ONE)
          : rng.inRange(500n * ONE, 18_000n * ONE);
      // The limit is net of the 1 bp fee, as the band is (CT-10).
      const netIn = sellAmount - sellAmount / 10_000n;
      const atPrice =
        side === "SELL_A_FOR_B" ? mulDiv(netIn, priceX96, Q96) : mulDiv(netIn, Q96, priceX96);
      const minBuyAmount = mulDiv(atPrice, 10_000n - toleranceBps, 10_000n);
      actions.push({
        kind: "place",
        trader,
        side,
        sellAmount: fromBig(sellAmount),
        minBuyAmount: fromBig(minBuyAmount),
        expiresAfter: options.expiresAfter,
      });
      open += 1;
    }

    if (open > 0 && rng.chance(1, options.cancelOneIn)) {
      actions.push({ kind: "cancel", openIndex: rng.intInRange(0, open - 1) });
      open -= 1;
    }

    slots.push({ slot, actions });
  }

  return {
    seed: fromBig(options.seed),
    slots,
    options: {
      slots: options.slots,
      startPrice: fromBig(options.startPrice),
      driftBps: options.driftBps,
      expiresAfter: options.expiresAfter,
    },
  };
}

/** What the soak needs to run against a simulation rather than an enclave. */
export interface SoakRunOptions {
  readonly params: BookParams;
  readonly gas: GasModel;
  readonly liquidity: bigint;
  readonly poolFee: bigint;
  readonly startUnix: number;
}

/**
 * The plan, run against the simulation — the hermetic half of HX-4.
 *
 * The enclave run drives the same plan through the `place`, `cancel` and
 * `drift` ops instead. Both produce an observation log, both are recorded by
 * the same recorder, and both are asserted by the same checks, which is what
 * makes the offline run a real rehearsal of the nightly one.
 */
export function runSoak(plan: SoakPlan, options: SoakRunOptions): Simulation {
  const startPrice = toBig(plan.options.startPrice);
  const pool: Pool = {
    sqrtPriceX96: sqrtPriceForPrice(startPrice, PRICE_SCALE),
    liquidity: options.liquidity,
    fee: options.poolFee,
  };

  const simulation = new Simulation({
    profile: "full",
    params: options.params,
    pool,
    startUnix: options.startUnix,
    startL1Block: 1,
    startL2Block: 1,
    windowSlots: 1,
    gas: options.gas,
  });

  for (const slot of plan.slots) {
    for (const action of slot.actions) {
      switch (action.kind) {
        case "drift":
          simulation.drift({
            ...simulation.currentPool(),
            sqrtPriceX96: sqrtPriceForPrice(toBig(action.price), PRICE_SCALE),
          });
          break;
        case "place":
          simulation.place(
            action.trader,
            action.side,
            toBig(action.sellAmount),
            toBig(action.minBuyAmount),
            action.expiresAfter,
          );
          break;
        case "cancel": {
          const open = simulation.openOrders();
          const target = open[action.openIndex % Math.max(1, open.length)];
          if (target !== undefined) simulation.cancel(target.id);
          break;
        }
      }
    }
    // Five L2 blocks of placement, then the Sync block settles the window.
    simulation.blocks(5);
    simulation.settle();
  }

  return simulation;
}

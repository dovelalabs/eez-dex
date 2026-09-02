/**
 * The scenario's node entry point — the one seam between the shell that drives
 * the enclave and the TypeScript that computes and asserts.
 *
 * `dex-scenario.sh` orchestrates: it brings the enclave up, deploys, runs the
 * ops, and induces failures. Everything that needs arithmetic wider than a
 * shell can hold — the settlement oracle, the recorded run, the A.6 assertions
 * — is a subcommand here. Each one reads JSON on argv or stdin and writes JSON
 * or a human line to stdout, so a failing assertion is legible in a CI log
 * without a debugger.
 *
 * Usage:
 *   node lib/cli.ts swap-oracle '<json>'      what MockPool's curve should do
 *   node lib/cli.ts settle-oracle '<json>'    what a window should settle at
 *   node lib/cli.ts record <observations.jsonl> <run.json>
 *   node lib/cli.ts validate <run.json>
 *   node lib/cli.ts assert <run.json> <readings.json>
 *   node lib/cli.ts soak-plan '<json>'        HX-4's seeded order flow
 *   node lib/cli.ts soak-run '<json>'         that plan against the oracle
 *   node lib/cli.ts acceptance '<json>'       RD-2 §10's evidence, as JSON
 *   node lib/cli.ts fixtures <directory>      regenerate the HX-5 fixtures
 *   node lib/cli.ts observe <config.json> <outdir>   watch a run, live
 */

import { readFileSync, writeFileSync } from "node:fs";

import { expectSettlement } from "./book.ts";
import type { BookOrder, BookParams } from "./book.ts";
import { fromBig, toBig } from "./math.ts";
import { formatObservationLog, parseObservationLog } from "./observation.ts";
import { swap, tickAtSqrtRatio } from "./pool.ts";
import type { Pool } from "./pool.ts";
import { record } from "./record.ts";
import { describeRun, validate } from "./validate.ts";
import { assertRun } from "./assert.ts";
import type { Readings } from "./assert.ts";
import { soakPlan } from "./soak.ts";
import { runSimulatedSoak } from "./simulated-soak.ts";
import { acceptance } from "./acceptance.ts";
import { fixtureObservations, writeFixtures } from "./fixture.ts";
import { observerFor, writeObserved } from "./observe.ts";
import type { ObserveConfig } from "./observe.ts";

function readJson(argument: string | undefined): unknown {
  if (argument === undefined) throw new Error("expected a JSON argument");
  const text = argument.startsWith("@") ? readFileSync(argument.slice(1), "utf8") : argument;
  return JSON.parse(text);
}

function asPool(value: unknown): Pool {
  const pool = value as Record<string, string>;
  return {
    sqrtPriceX96: toBig(pool["sqrtPriceX96"] ?? "0"),
    liquidity: toBig(pool["liquidity"] ?? "0"),
    fee: toBig(pool["fee"] ?? "3000"),
  };
}

function asParams(value: unknown): BookParams {
  const params = value as Record<string, string>;
  return {
    feeMode: params["feeMode"] === "fixed" ? "fixed" : "bps",
    feeBps: toBig(params["feeBps"] ?? "0"),
    feeFixedA: toBig(params["feeFixedA"] ?? "0"),
    feeFixedB: toBig(params["feeFixedB"] ?? "0"),
    routeFeeModel: params["routeFeeModel"] === "recover" ? "recover" : "absorb",
    routeFeeWei: toBig(params["routeFeeWei"] ?? "0"),
    assetAIsNative: params["assetAIsNative"] !== "false",
  };
}

function asOrders(value: unknown): BookOrder[] {
  return (value as Record<string, string>[]).map((order) => ({
    id: order["id"] ?? "",
    side: order["side"] === "SELL_B_FOR_A" ? "SELL_B_FOR_A" : "SELL_A_FOR_B",
    sellAmount: toBig(order["sellAmount"] ?? "0"),
    minBuyAmount: toBig(order["minBuyAmount"] ?? "0"),
  }));
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;

  switch (command) {
    case "swap-oracle": {
      const input = readJson(rest[0]) as Record<string, unknown>;
      const pool = asPool(input["pool"]);
      const result = swap(pool, input["zeroForOne"] === true, toBig(String(input["amountIn"])));
      process.stdout.write(
        `${JSON.stringify({
          amountIn: fromBig(result.amountIn),
          amountOut: fromBig(result.amountOut),
          sqrtPriceX96: fromBig(result.pool.sqrtPriceX96),
          tick: tickAtSqrtRatio(result.pool.sqrtPriceX96),
        })}\n`,
      );
      return 0;
    }

    case "settle-oracle": {
      const input = readJson(rest[0]) as Record<string, unknown>;
      const settlement = expectSettlement(
        asOrders(input["orders"]),
        asParams(input["params"]),
        asPool(input["mirror"]),
        asPool(input["pool"]),
      );
      process.stdout.write(
        `${JSON.stringify({
          residualSide: settlement.leg.residualSide,
          residualIn: fromBig(settlement.leg.residualIn),
          crossPot: fromBig(settlement.leg.crossPot),
          minPriceX96: fromBig(settlement.leg.minPriceX96),
          maxPriceX96: fromBig(settlement.leg.maxPriceX96),
          referencePriceX96: fromBig(settlement.result.referencePriceX96),
          executionPriceX96: fromBig(settlement.result.executionPriceX96),
          amountOut: fromBig(settlement.result.amountOut),
          fills: settlement.fills.map((fill) => ({
            id: fill.id,
            amountOut: fromBig(fill.amountOut),
            feeAmount: fromBig(fill.feeAmount),
            routeFeeAmount: fromBig(fill.routeFeeAmount),
            impactAmount: fromBig(fill.impactAmount),
            crossed: fill.crossed,
          })),
        })}\n`,
      );
      return 0;
    }

    case "record": {
      const [source, target] = rest;
      if (source === undefined || target === undefined) throw new Error("record: <observations> <run.json>");
      const observations = parseObservationLog(readFileSync(source, "utf8"));
      const run = record(observations);
      const events = validate(run.events);
      writeFileSync(target, `${JSON.stringify(events, null, 2)}\n`);
      const summary = describeRun(events);
      process.stdout.write(
        `recorded ${events.length} events: ${summary.orders} orders, ${summary.settlements} settlements, ` +
          `windows ${JSON.stringify(summary.windowOutcomes)}\n`,
      );
      return 0;
    }

    case "validate": {
      const target = rest[0];
      if (target === undefined) throw new Error("validate: <run.json>");
      const events = validate(JSON.parse(readFileSync(target, "utf8")));
      const summary = describeRun(events);
      process.stdout.write(
        `${target}: ${events.length} events conform to the IX-2 schema; ` +
          `windows ${JSON.stringify(summary.windowOutcomes)}\n`,
      );
      return 0;
    }

    case "assert": {
      const [runPath, readingsPath] = rest;
      if (runPath === undefined || readingsPath === undefined) throw new Error("assert: <run.json> <readings.json>");
      const events = validate(JSON.parse(readFileSync(runPath, "utf8")));
      const readings = JSON.parse(readFileSync(readingsPath, "utf8")) as Readings;
      const report = assertRun(events, readings);
      for (const line of report.lines) process.stdout.write(`${line}\n`);
      return report.failures === 0 ? 0 : 1;
    }

    case "soak-plan": {
      const input = readJson(rest[0]) as Record<string, unknown>;
      process.stdout.write(`${JSON.stringify(soakPlan(input), null, 2)}\n`);
      return 0;
    }

    case "soak-run": {
      const input = (rest[0] === undefined ? {} : readJson(rest[0])) as Record<string, unknown>;
      const seed = input["seed"] === undefined ? undefined : String(input["seed"]);
      const slots = input["slots"] === undefined ? undefined : Number(input["slots"]);
      const report = runSimulatedSoak(seed, slots);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.failures === 0 ? 0 : 1;
    }

    case "acceptance": {
      const input = (rest[0] === undefined ? {} : readJson(rest[0])) as Record<string, unknown>;
      const seed = input["seed"] === undefined ? undefined : String(input["seed"]);
      const slots = input["slots"] === undefined ? undefined : Number(input["slots"]);
      process.stdout.write(`${JSON.stringify(acceptance(seed, slots), null, 2)}\n`);
      return 0;
    }

    case "fixtures": {
      const directory = rest[0] ?? "fixtures";
      const observations = fixtureObservations();
      writeFileSync(`${directory}/observations.jsonl`, formatObservationLog(observations));
      const written = writeFixtures(directory, observations);
      for (const line of written) process.stdout.write(`${line}\n`);
      return 0;
    }

    case "observe": {
      const [configPath, directory] = rest;
      if (configPath === undefined || directory === undefined) throw new Error("observe: <config.json> <outdir>");
      void watch(configPath, directory);
      return 0;
    }

    default:
      process.stderr.write(`unknown command '${String(command)}'; see the header of lib/cli.ts\n`);
      return 2;
  }
}

/**
 * Watches a run until the harness stops it, then writes the observation log
 * and the readings.
 *
 * The loop is here rather than in the observer so the observer stays a pure
 * `step()` a test can drive block by block. SIGTERM is the normal end: the
 * shell starts this alongside the enclave and stops it when the scenario is
 * done, and everything seen so far is written on the way out.
 */
async function watch(configPath: string, directory: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ObserveConfig & {
    expect?: Record<string, unknown>;
    pollMs?: number;
  };
  const observer = observerFor(config);
  const expect = config.expect ?? { mode: "matrix" };
  let running = true;

  const finish = async (): Promise<void> => {
    running = false;
    try {
      await writeObserved(directory, observer, expect);
      process.stdout.write(`observed ${observer.observations.length} facts into ${directory}\n`);
    } catch (error) {
      process.stderr.write(`observe: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  };
  process.on("SIGTERM", () => void finish().then(() => process.exit(process.exitCode ?? 0)));
  process.on("SIGINT", () => void finish().then(() => process.exit(process.exitCode ?? 0)));

  await observer.start();
  while (running) {
    try {
      await observer.step();
    } catch (error) {
      // A devnet that hiccuped is not a failed scenario; a devnet that stays
      // down shows up as an empty observation log, which the assertions fail
      // on loudly.
      process.stderr.write(`observe: ${(error as Error).message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollMs ?? 1000));
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}

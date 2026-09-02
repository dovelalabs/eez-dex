/**
 * The demo director's control proxy — RD-2 IX-1, FE-9. **Devnet only.**
 *
 * This module is the single exception to "no write path", and the exception is
 * structural: nothing imports it except `http.ts`, and `http.ts` imports it
 * only behind `profile === "devnet"` — a dynamic import that never runs
 * elsewhere. On any other profile these routes are not registered, not
 * disabled: a request for one meets the same 404 as a route that was never
 * written (`test/director.test.ts` holds that).
 *
 * What it proxies is HX-3's external ops, run in the enclave by WP-4's script.
 * The gateway holds no keys and signs nothing; it spawns the harness the
 * operator already has, with an argv it built itself:
 *
 * * three controls and no others, by name;
 * * every parameter an integer inside a stated range;
 * * `argv`, never a shell string, so nothing a caller sends can become syntax.
 */

import { spawn } from "node:child_process";

/** The three controls FE-9 names, and nothing else. */
export const DIRECTOR_CONTROLS = ["burst", "drift", "stall"] as const;

/** One of them. */
export type DirectorControl = (typeof DIRECTOR_CONTROLS)[number];

/** A control's one parameter: what it is called and what it may be. */
interface ControlSpec {
  /** The HX-3 external op this control maps to. */
  readonly op: string;
  readonly parameter: string;
  readonly flag: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/**
 * The mapping to HX-3's ops.
 *
 * `scenario/**` is WP-4's and is not touched from this branch; the argv below
 * is the convention the two agree on and integration validates, exactly as the
 * fixture format is (WP-4/WP-5 soft contract).
 */
const CONTROLS: Readonly<Record<DirectorControl, ControlSpec>> = {
  // A burst of orders from the scripted accounts (HX-2's eight, or more).
  burst: { op: "place", parameter: "orders", flag: "--count", min: 1, max: 64, fallback: 8 },
  // Move the L1 pool price mid-window, in basis points, either way (HX-3).
  drift: { op: "drift", parameter: "bps", flag: "--bps", min: -10_000, max: 10_000, fallback: 50 },
  // Stall the builder for a number of L1 slots (HX-3's "bundle not included").
  stall: { op: "stall", parameter: "slots", flag: "--slots", min: 1, max: 12, fallback: 2 },
};

/** How the director reaches the harness. */
export interface DirectorOptions {
  /** WP-4's scenario script. */
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Injectable so the argv can be asserted without an enclave. */
  readonly run?: (command: string, argv: readonly string[], cwd: string | undefined) => Promise<DirectorRun>;
}

/** What running a control produced. */
export interface DirectorRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A control was asked for in a way this proxy will not run. */
export class DirectorError extends Error {}

/** Builds the argv for one control. Throws rather than pass anything through. */
export function directorArgv(control: string, body: unknown): readonly string[] {
  if (!(DIRECTOR_CONTROLS as readonly string[]).includes(control)) {
    throw new DirectorError(`unknown control: ${control}`);
  }
  const spec = CONTROLS[control as DirectorControl];
  const source = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw = source[spec.parameter];
  const value = raw === undefined ? spec.fallback : raw;

  if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new DirectorError(
      `${spec.parameter} must be an integer in [${spec.min}, ${spec.max}], got ${JSON.stringify(raw)}`,
    );
  }
  return ["--op", spec.op, spec.flag, String(value)];
}

function runProcess(command: string, argv: readonly string[], cwd: string | undefined, timeoutMs: number): Promise<DirectorRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], { cwd, shell: false, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** Runs one control through the harness. */
export async function runControl(
  control: string,
  body: unknown,
  options: DirectorOptions,
): Promise<DirectorRun & { readonly control: string; readonly argv: readonly string[] }> {
  const argv = directorArgv(control, body);
  const run = options.run ?? ((command, args, cwd) => runProcess(command, args, cwd, options.timeoutMs ?? 120_000));
  const result = await run(options.command, argv, options.cwd);
  return { control, argv, ...result };
}

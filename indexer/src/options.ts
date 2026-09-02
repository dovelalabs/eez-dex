/**
 * Configuration — RD-2 IX-1.
 *
 * "Points at any environment by configuration" is a requirement, so there is
 * one place where an environment becomes options: environment variables under
 * the same names A.5 gives the settler, overridden by command-line flags.
 *
 * It is a system boundary, so it is parsed once and loudly: a profile that is
 * not a profile, or a speed that is not a number, fails here rather than at
 * the first tick (`CLAUDE.md`).
 */

import { fileURLToPath } from "node:url";

import { INDEXER_PROFILES, type IndexerProfile } from "./protocol.ts";

/** Where the gateway points and what it exposes. */
export interface IndexerOptions {
  /** The L1 endpoint. Empty means no L1 is configured — a legitimate setup. */
  readonly l1Rpc: string;
  readonly l2Rpc: string;
  readonly windowBook: string;
  readonly port: number;
  /** A recorded run to replay instead of reading chains (HX-5, FE-10). */
  readonly fixture?: string;
  /** Replay speed multiplier; 1 is real time, 0 is as fast as possible. */
  readonly speed?: number;
  /**
   * The deployment. The director's controls exist on `devnet` and nowhere
   * else — absent, not disabled (IX-1, FE-9).
   */
  readonly profile?: IndexerProfile;
  /** Devnet only: turn the director's proxy off within devnet. Default on. */
  readonly enableDirector?: boolean;
  /** WP-4's scenario script, which the director's controls drive (HX-3). */
  readonly directorCommand?: string;
  readonly directorCwd?: string;
  /** The settler's projection, served over HTTP (A.5, SV-4). */
  readonly settlerUrl?: string;
  /** The router's pool adapter, for the live pool state behind FE-8. */
  readonly poolAdapter?: string;
  /** How often the live source reads its upstreams. One L2 block by default. */
  readonly pollIntervalMs?: number;
  readonly host?: string;
  /** The L2 block to start scanning `WindowBook` logs from. */
  readonly fromBlock?: number;
  readonly historyBlocks?: number;
  readonly logRange?: number;
  /** How many L1 blocks IX-3's swap-gas sample covers. */
  readonly gasSampleBlocks?: number;
  /** Set false to build the stream without binding a socket (library use). */
  readonly serve?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** One L2 block: the cadence the zone produces at (RD-2 §1). */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * The scenario script the director proxies to (HX-3).
 *
 * Resolved from this package rather than from the working directory, so the
 * gateway finds the harness whichever directory it was started from.
 */
export const DEFAULT_DIRECTOR_COMMAND = fileURLToPath(
  new URL("../../scenario/dex-scenario.sh", import.meta.url),
);

function profileOf(value: string | undefined): IndexerProfile {
  if (value === undefined || value === "") return "devnet";
  if ((INDEXER_PROFILES as readonly string[]).includes(value)) return value as IndexerProfile;
  throw new Error(`PROFILE must be one of ${INDEXER_PROFILES.join(" | ")}, got ${value}`);
}

function numberOf(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${value}`);
  return parsed;
}

/** Parses `--flag value` and `--flag=value` pairs; bare flags become "true". */
export function parseArgv(argv: readonly string[]): Readonly<Record<string, string>> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=", 2);
    if (name === undefined || name === "") continue;
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "true";
      continue;
    }
    flags[name] = next;
    i += 1;
  }
  return flags;
}

/** Environment variables, then flags, into one set of options. */
export function resolveOptions(
  argv: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
): IndexerOptions {
  const flags = parseArgv(argv);
  const pick = (flag: string, variable: string): string | undefined => flags[flag] ?? env[variable];

  const fixture = pick("replay", "FIXTURE");
  const settlerUrl = pick("settler", "SETTLER_URL");
  const poolAdapter = pick("pool", "POOL_ADAPTER");
  const fromBlock = pick("from-block", "FROM_BLOCK");

  return {
    l1Rpc: pick("l1", "L1_RPC") ?? "",
    l2Rpc: pick("l2", "L2_RPC") ?? "http://127.0.0.1:8545",
    windowBook: pick("book", "WINDOW_BOOK") ?? "",
    port: numberOf("PORT", pick("port", "PORT"), 8080),
    host: pick("host", "HOST") ?? "127.0.0.1",
    profile: profileOf(pick("profile", "PROFILE")),
    ...(fixture === undefined ? {} : { fixture }),
    speed: numberOf("SPEED", pick("speed", "SPEED"), 1),
    enableDirector: (pick("director", "ENABLE_DIRECTOR") ?? "true") !== "false",
    directorCommand: pick("director-command", "DIRECTOR_COMMAND") ?? DEFAULT_DIRECTOR_COMMAND,
    ...(settlerUrl === undefined ? {} : { settlerUrl }),
    ...(poolAdapter === undefined ? {} : { poolAdapter }),
    pollIntervalMs: numberOf("POLL_MS", pick("poll", "POLL_MS"), DEFAULT_POLL_INTERVAL_MS),
    ...(fromBlock === undefined ? {} : { fromBlock: numberOf("FROM_BLOCK", fromBlock, 0) }),
    historyBlocks: numberOf("HISTORY_BLOCKS", pick("history", "HISTORY_BLOCKS"), 2_000),
    gasSampleBlocks: numberOf("GAS_SAMPLE_BLOCKS", pick("gas-sample", "GAS_SAMPLE_BLOCKS"), 50),
  };
}

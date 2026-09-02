/**
 * What this build points at — RD-2 FE-9, FE-10, FE-11, EC-1.
 *
 * Configuration is read once, from three places in decreasing generality: the
 * build's profile (a `define`, so a profile is a compile-time fact and not a
 * runtime flag), the environment `VITE_*` variables baked in at build, and the
 * URL's query string, which the operator of a demo uses to point one bundle at
 * another endpoint.
 *
 * It is a pure function of those inputs so it can be tested without a browser
 * or a bundler: everything in `src/` that Node's test runner can execute is
 * kept that way deliberately (FE-11).
 */

import { modeFromLocation, type Mode } from "./mode.ts";

/** The deployments this app is built for. Mirrors the gateway's own list. */
export const PROFILES = ["devnet", "testnet", "mainnet"] as const;

/** One of them. */
export type Profile = (typeof PROFILES)[number];

/** EC-1's two fee shapes. The launch parameter is `bps`, capped at 1 bp. */
export type FeeMode = "bps" | "fixed";

/** EC-1's route-fee models. `absorb` is the launch setting: the share is zero. */
export type RouteFeeModel = "absorb" | "recover";

/** The EC-1 parameters the book was deployed with, as the cost line states them. */
export interface FeeParams {
  readonly mode: FeeMode;
  /** `FEE_BPS`, hundredths of a per cent of notional. */
  readonly bps: bigint;
  /** `FEE_FIXED` in A's units, when the shape is fixed. */
  readonly fixedA: bigint;
  /** `FEE_FIXED` in B's units. */
  readonly fixedB: bigint;
  /**
   * Whether the window's route fee is recovered from fills or absorbed by the
   * protocol. At launch it is absorbed, and the cost line says so rather than
   * hiding a line that is zero (FE-3).
   */
  readonly routeFeeModel: RouteFeeModel;
}

/** How one side of the pair is displayed. Decimals are display-only. */
export interface AssetConfig {
  readonly symbol: string;
  readonly decimals: number;
  /** The L2 address the book escrows; `0x0…0` is native zone ETH (CT-11). */
  readonly address: string;
}

/** Everything the app needs to know that the stream does not carry. */
export interface AppConfig {
  readonly profile: Profile;
  readonly mode: Mode;
  /** The IX-1 gateway's HTTP origin. The WebSocket is derived from it. */
  readonly indexerUrl: string;
  /** An HX-5 recording, for the replay that has no infrastructure behind it. */
  readonly fixtureUrl: string;
  /** Replay clock multiplier; 1 is real time (FE-10). */
  readonly speed: number;
  readonly fee: FeeParams;
  /** `WindowBook` on L2 — the one contract this app ever writes to. */
  readonly windowBook: string;
  /** The L2 chain id a wallet must be on to trade, as `eth_chainId` returns it. */
  readonly chainIdHex: string | null;
  /** Base URL for the settlement's L1 transaction link (FE-4). */
  readonly l1ExplorerUrl: string;
  readonly assetA: AssetConfig;
  readonly assetB: AssetConfig;
}

/** How this build was compiled. Replaced at build time by Vite's `define`. */
declare const __PROFILE__: string;

/** The profile this bundle was built for; `devnet` when nothing said. */
export function buildProfile(): Profile {
  const value = typeof __PROFILE__ === "string" ? __PROFILE__ : "devnet";
  return PROFILES.find((profile) => profile === value) ?? "devnet";
}

/** The subset of `import.meta.env` this app reads. */
export type Env = Readonly<Record<string, string | undefined>>;

function text(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === "" ? fallback : value;
}

function big(env: Env, key: string, fallback: bigint): bigint {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function digits(env: Env, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isInteger(value) && value >= 0 && value <= 36 ? value : fallback;
}

/**
 * The replay speed, from the query string first and the environment second.
 *
 * `0` is a legitimate answer — as fast as the machine allows, which is what a
 * test wants — so this cannot fall back on falsiness.
 */
function readSpeed(env: Env, params: URLSearchParams): number {
  const raw = params.get("speed") ?? env["VITE_SPEED"];
  const value = Number(raw);
  return raw !== null && raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : 1;
}

function asset(env: Env, key: string, fallback: AssetConfig): AssetConfig {
  return {
    symbol: text(env, `VITE_ASSET_${key}_SYMBOL`, fallback.symbol),
    decimals: digits(env, `VITE_ASSET_${key}_DECIMALS`, fallback.decimals),
    address: text(env, `VITE_ASSET_${key}_ADDRESS`, fallback.address),
  };
}

/** The pair the fixtures and the devnet run: 18-decimal A against 18-decimal B. */
const DEFAULT_ASSET_A: AssetConfig = { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" };
const DEFAULT_ASSET_B: AssetConfig = { symbol: "USD", decimals: 18, address: "0x0000000000000000000000000000000000000001" };

/**
 * Reads the configuration.
 *
 * Query parameters win over the environment so one built bundle can be pointed
 * at a second gateway, a second recording or a second clock without a rebuild —
 * which is how `observe` gets used against a testnet the build did not know
 * about. None of them can turn on the demo controls: that is the profile's
 * business, and the profile is compiled in (FE-9).
 */
export function readConfig(env: Env, search: string, profile: Profile = buildProfile()): AppConfig {
  const params = new URLSearchParams(search);
  const feeMode: FeeMode = text(env, "VITE_FEE_MODE", "bps") === "fixed" ? "fixed" : "bps";
  const routeFeeModel: RouteFeeModel =
    text(env, "VITE_ROUTE_FEE_MODEL", "absorb") === "recover" ? "recover" : "absorb";

  return {
    profile,
    mode: modeFromLocation(search),
    indexerUrl: params.get("indexer") ?? text(env, "VITE_INDEXER_URL", "http://127.0.0.1:8080"),
    fixtureUrl: params.get("fixture") ?? text(env, "VITE_FIXTURE_URL", "/fixtures/run.json"),
    speed: readSpeed(env, params),
    fee: {
      mode: feeMode,
      // EC-1's ceiling at 2026 gas, and what the recorded runs were priced at.
      bps: big(env, "VITE_FEE_BPS", 1n),
      fixedA: big(env, "VITE_FEE_FIXED_A", 0n),
      fixedB: big(env, "VITE_FEE_FIXED_B", 0n),
      routeFeeModel,
    },
    windowBook: text(env, "VITE_WINDOW_BOOK", ""),
    chainIdHex: env["VITE_L2_CHAIN_ID"] === undefined || env["VITE_L2_CHAIN_ID"] === "" ? null : env["VITE_L2_CHAIN_ID"],
    l1ExplorerUrl: text(env, "VITE_L1_EXPLORER_URL", "https://etherscan.io/tx/"),
    assetA: asset(env, "A", DEFAULT_ASSET_A),
    assetB: asset(env, "B", DEFAULT_ASSET_B),
  };
}

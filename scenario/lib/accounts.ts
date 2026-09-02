/**
 * The scenario's identities, read from `scenario/accounts.env`.
 *
 * One file is the source: the ops sign with the keys in it, the fixtures and
 * assertions expect the addresses in it. Parsing the same file rather than
 * transcribing the list is what stops the recorded run describing orders from
 * accounts the enclave never used.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), "accounts.env");

function parse(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    values.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return values;
}

const VALUES = parse(readFileSync(ENV_PATH, "utf8"));

function required(key: string): string {
  const value = VALUES.get(key);
  if (value === undefined) throw new Error(`accounts.env: ${key} is not set`);
  return value;
}

/** How many trader accounts the scenario places from — A.6's eight. */
export const TRADER_COUNT = Number(required("DEX_TRADER_COUNT"));

/** The trader addresses, lower case, in the order the scenario places from. */
export const TRADERS: readonly string[] = Array.from({ length: TRADER_COUNT }, (_, index) =>
  required(`DEX_TRADER_${index}_ADDRESS`),
);

/** The account that deploys the DEX on both chains (HX-1). */
export const DEPLOYER = required("DEX_DEPLOYER_ADDRESS");

/** The settler's address (A.5 `SETTLER_KEY`). */
export const SETTLER = required("DEX_SETTLER_ADDRESS");

/** Bridge governance and guardian (EC-4). */
export const GOVERNANCE = required("DEX_GOVERNANCE_ADDRESS");

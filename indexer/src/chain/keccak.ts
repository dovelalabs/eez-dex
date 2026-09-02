/**
 * `keccak256` — the hash Ethereum names its events and functions with.
 *
 * The package has no runtime dependencies and Node's `crypto` ships NIST
 * SHA3-256, which pads differently and is a different hash. Rather than
 * hard-code topic constants nothing in the repository can check, the topics
 * and selectors this indexer decodes with are derived from their signature
 * strings at load time, and `test/keccak.test.ts` pins this implementation
 * against published vectors and against two topics anyone can look up.
 */

const MASK64 = (1n << 64n) - 1n;

/** Keccak-f[1600]'s 24 round constants. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** `RHO_OFFSETS[x * 5 + y]` is lane (x, y)'s rotation in the rho step. */
const RHO_OFFSETS: readonly bigint[] = [
  0n, 36n, 3n, 41n, 18n,
  1n, 44n, 10n, 45n, 2n,
  62n, 6n, 43n, 15n, 61n,
  28n, 55n, 25n, 21n, 56n,
  27n, 20n, 39n, 8n, 14n,
];

/** Keccak-256 absorbs 136 bytes at a time. */
const RATE = 136;

function rotl(lane: bigint, by: bigint): bigint {
  return ((lane << by) | (lane >> (64n - by))) & MASK64;
}

/** Lane index for (x, y) in the 5x5 state, stored row-major by y. */
function at(x: number, y: number): number {
  return x + 5 * y;
}

function permute(state: bigint[]): void {
  const c = new Array<bigint>(5).fill(0n);
  const d = new Array<bigint>(5).fill(0n);
  const b = new Array<bigint>(25).fill(0n);

  for (const rc of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) {
      c[x] = state[at(x, 0)]! ^ state[at(x, 1)]! ^ state[at(x, 2)]! ^ state[at(x, 3)]! ^ state[at(x, 4)]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1n);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[at(x, y)] = state[at(x, y)]! ^ d[x]!;
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[at(y, (2 * x + 3 * y) % 5)] = rotl(state[at(x, y)]!, RHO_OFFSETS[x * 5 + y]!);
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[at(x, y)] = b[at(x, y)]! ^ (~b[at((x + 1) % 5, y)]! & b[at((x + 2) % 5, y)]!) & MASK64;
      }
    }

    state[0] = state[0]! ^ rc;
  }
}

/** The 32-byte Keccak-256 digest of `input`. */
export function keccak256(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ value;
    }
    permute(state);
  }

  const digest = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      digest[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return digest;
}

/** `keccak256` of a UTF-8 string, as a 0x-prefixed lower-case hex hash. */
export function keccak256Hex(input: string): string {
  return `0x${Buffer.from(keccak256(Buffer.from(input, "utf8"))).toString("hex")}`;
}

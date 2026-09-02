/**
 * keccak256 — the hash Ethereum uses, which Node does not ship.
 *
 * `crypto.createHash("sha3-256")` is FIPS SHA-3: same permutation, different
 * padding byte, different digest. The scenario needs the real one to derive
 * event topics and to check that an order id is `keccak256(owner, nonce)` as
 * CT-7 requires, and it has no dependencies by design — a harness that pulls a
 * package tree in is a harness that stops running when the registry does.
 *
 * The implementation is the standard 24-round Keccak-f[1600] over a 136-byte
 * rate. `keccak.test.ts` pins it to the published vectors and to the event
 * signatures the recorder reads.
 */

const ROUNDS = 24;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed as `x + 5 * y`. */
const ROTATIONS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const MASK64 = (1n << 64n) - 1n;

function rotl(value: bigint, by: number): bigint {
  if (by === 0) return value;
  const shift = BigInt(by);
  return ((value << shift) | (value >> (64n - shift))) & MASK64;
}

function permute(lanes: bigint[]): void {
  for (let round = 0; round < ROUNDS; round += 1) {
    // theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      c[x] = lanes[x]! ^ lanes[x + 5]! ^ lanes[x + 10]! ^ lanes[x + 15]! ^ lanes[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y += 1) lanes[x + 5 * y] = lanes[x + 5 * y]! ^ d;
    }

    // rho and pi
    const b: bigint[] = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(lanes[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        lanes[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK64 & b[((x + 2) % 5) + 5 * y]!);
      }
    }

    // iota
    lanes[0] = lanes[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** keccak256 of raw bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1]! | 0x80) & 0xff;

  const lanes: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      lanes[lane] = lanes[lane]! ^ value;
    }
    permute(lanes);
  }

  const digest = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    let value = lanes[lane]!;
    for (let byte = 0; byte < 8; byte += 1) {
      digest[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return digest;
}

/** `0x`-prefixed hex of some bytes, lower case. */
export function toHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Bytes of a `0x`-prefixed hex string. */
export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`fromHex: odd-length input '${hex}'`);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** keccak256 of an ASCII string, hex-encoded — an event topic, for instance. */
export function keccak256Utf8(text: string): string {
  return toHex(keccak256(new TextEncoder().encode(text)));
}

/** A `uint256` as its 32-byte big-endian word. */
export function word(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

/**
 * CT-7's order id: `keccak256(abi.encodePacked(owner, nonce))` — derived
 * on-chain, never user-supplied. Packed, so the address is its own 20 bytes
 * and the nonce a full word: 52 bytes, not 64.
 *
 * The scenario re-derives it so a recorded run can be checked against the rule
 * rather than against itself.
 */
export function orderId(owner: string, nonce: bigint): string {
  const packed = new Uint8Array(52);
  packed.set(word(BigInt(owner)).slice(12), 0);
  packed.set(word(nonce), 20);
  return toHex(keccak256(packed));
}

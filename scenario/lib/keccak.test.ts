/**
 * The hash, pinned to published vectors — everything the recorder decodes
 * depends on it being keccak256 and not SHA-3.
 *
 * The expected digests below were produced with `cast keccak`, which is the
 * hash the chain under test actually uses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256, keccak256Utf8, orderId, toHex } from "./keccak.ts";

test("keccak256 matches the published vectors", () => {
  assert.equal(
    toHex(keccak256(new Uint8Array(0))),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(
    keccak256Utf8("abc"),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  // The FIPS SHA3-256 of "abc" — a different digest, which is the whole point
  // of not reaching for node:crypto here.
  assert.notEqual(
    keccak256Utf8("abc"),
    "0x3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532",
  );
});

test("keccak256 spans the sponge's rate boundary", () => {
  // 135, 136 and 137 zero bytes: one short of the 136-byte rate, exactly it,
  // and one over — the three lengths a padding bug hides between.
  assert.equal(
    toHex(keccak256(new Uint8Array(135))),
    "0x29e3704feeca7fb9ba229f0fa04d9b36449cf3ad6e1d85d9cfff3a10df9abc3e",
  );
  assert.equal(
    toHex(keccak256(new Uint8Array(136))),
    "0x3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9",
  );
  assert.equal(
    toHex(keccak256(new Uint8Array(137))),
    "0xbee7fbb405cb0d91a8775e338c4a5e4b5d6b2d051f687fa942043cffdc73bd28",
  );
});

test("ct7: the order id is keccak256(abi.encodePacked(owner, nonce))", () => {
  const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  assert.equal(
    orderId(owner, 0n),
    "0x8d7516f92f86ff2bff7638117eeefe54f86ce065a68c3b0f6c4b3d9bfb491ad6",
  );
  assert.equal(
    orderId(owner, 1n),
    "0x67c6a2e151d4352a55021b5d0028c18121cfc24c7d73b179d22b17daff069c6e",
  );
  // The address contributes its own 20 bytes, so a nonce can never be read as
  // part of it: distinct owners and distinct nonces stay distinct.
  const ids = new Set([
    orderId(owner, 0n),
    orderId(owner, 1n),
    orderId("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 0n),
  ]);
  assert.equal(ids.size, 3);
});

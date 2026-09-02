/**
 * What a user actually signs — RD-2 FE-11, CT-7.
 *
 * The two selectors are constants in the source so nothing has to hash in the
 * browser; here they are derived from the signatures beside them, using the
 * indexer's keccak — the same one its topics are pinned with. A signature that
 * drifts from `contracts/src/l2/WindowBook.sol` fails this test rather than
 * producing a call that reverts in a user's wallet.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// The gateway's ABI helpers are Node-side and not part of this bundle; the
// test may reach for them, the app may not.
import { selector } from "../../indexer/src/chain/abi.ts";
import {
  CANCEL_SELECTOR,
  CANCEL_SIGNATURE,
  encodeCancel,
  encodePlace,
  PLACE_SELECTOR,
  PLACE_SIGNATURE,
  quantity,
  sideOrdinal,
} from "../src/wallet/calldata.ts";

const ORDER_ID = "0x337a8ef3e2258ed07f04a1466930ed970b394337054bb426509b313d5dddbdd4";

test("ct7: the selectors are the ones the book's signatures hash to", () => {
  assert.equal(PLACE_SELECTOR, selector(PLACE_SIGNATURE));
  assert.equal(CANCEL_SELECTOR, selector(CANCEL_SIGNATURE));
});

test("a1: Side travels by its ordinal", () => {
  assert.equal(sideOrdinal("SELL_A_FOR_B"), 0);
  assert.equal(sideOrdinal("SELL_B_FOR_A"), 1);
});

test("ct7: place sends a zero id and a zero owner — both are derived on-chain", () => {
  const data = encodePlace({
    side: "SELL_B_FOR_A",
    sellAmount: 6_000_000_000_000_000_000_000n,
    minBuyAmount: 1_990_800_900_000_000_000n,
    recipient: "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
    expiresAfter: 2,
  });

  const words = (data.slice(10).match(/.{64}/g) ?? []).map((word) => word);
  assert.equal(data.slice(0, 10), PLACE_SELECTOR);
  assert.equal(words.length, 7, "A.1's Order is seven static words");
  assert.equal(BigInt(`0x${words[0]}`), 0n, "the id is keccak256(owner, nonce), derived on-chain (CT-7)");
  assert.equal(BigInt(`0x${words[1]}`), 0n, "the owner is msg.sender");
  assert.equal(BigInt(`0x${words[2]}`), 1n, "SELL_B_FOR_A");
  assert.equal(BigInt(`0x${words[3]}`), 6_000_000_000_000_000_000_000n);
  assert.equal(BigInt(`0x${words[4]}`), 1_990_800_900_000_000_000n);
  assert.equal(`0x${words[5]?.slice(24)}`, "0x14dc79964da2c08b23698b3d3cc7ca32193d9955");
  assert.equal(BigInt(`0x${words[6]}`), 2n);
});

test("ct7: cancel carries the order id and nothing else", () => {
  const data = encodeCancel(ORDER_ID);
  assert.equal(data, CANCEL_SELECTOR + ORDER_ID.slice(2));
  assert.equal(data.length, 10 + 64);
});

test("a malformed address or id is refused before it reaches a wallet", () => {
  assert.throws(() =>
    encodePlace({ side: "SELL_A_FOR_B", sellAmount: 1n, minBuyAmount: 0n, recipient: "0xnope", expiresAfter: 1 }),
  );
  assert.throws(() => encodeCancel("0x1234"));
});

test("amounts travel as minimal hex quantities", () => {
  assert.equal(quantity(0n), "0x0");
  assert.equal(quantity(10n ** 18n), "0xde0b6b3a7640000");
});

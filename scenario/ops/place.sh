#!/usr/bin/env bash
# `place` — the UP-2 external op that puts an order in the open window (CT-7).
#
#   EEZ_WAVE_OPS="ext:scenario/ops/place.sh 0,ext:scenario/ops/place.sh 1" \
#       bash testing/kurtosis/scripts/cross-chain-wave.sh
#
# One op instance per order per wave: the slot argument selects which line of
# `$DEX_PLAN_DIR/wave-<n>.place` this instance emits, so several orders can be
# placed in one wave while each op still prints exactly one transaction.
#
# Plan line: <trader> <side> <sellAmount> <minBuyAmount> <expiresAfter>
#   trader        index into accounts.env's trader list
#   side          0 = SELL_A_FOR_B, 1 = SELL_B_FOR_A (A.1's ordinals)
#   sellAmount    escrowed by `place`: `msg.value` when the sell asset is zone
#                 ETH, a `transferFrom` otherwise (the scenario grants the book
#                 its allowance during setup, so the op never needs two txs)
#   minBuyAmount  the limit; never filled below this (CT-10)
#   expiresAfter  lifetime in windows
#
# The id and owner fields of the struct are placeholders: the id is derived
# on-chain as `keccak256(owner, nonce)` and never user-supplied (CT-7).
set -euo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SLOT="${1:-0}"
LINE="$(dex_plan_line place "$SLOT")"
# Nothing planned for this slot this wave: decline, and the harness skips it
# without counting it.
[[ -n "$LINE" ]] || exit 0

read -r TRADER SIDE SELL_AMOUNT MIN_BUY EXPIRES_AFTER <<<"$LINE"
[[ -n "${EXPIRES_AFTER:-}" ]] || dex_die "malformed place line '$LINE'"

BOOK="$(dex_need DEX_WINDOW_BOOK)"
KEY="$(dex_trader_key "$TRADER")"
RECIPIENT="$(dex_trader_address "$TRADER")"

# The sell asset is zone ETH on exactly one side of the pair, and that side
# escrows as `msg.value`; the other transfers from the allowance set up before
# the run (CT-7, FL-3).
NATIVE_SIDE="${DEX_NATIVE_SIDE:-0}"
VALUE=0
[[ "$SIDE" == "$NATIVE_SIDE" ]] && VALUE="$SELL_AMOUNT"

DATA="$(cast calldata \
    "place((bytes32,address,uint8,uint256,uint256,address,uint32))" \
    "(0x0000000000000000000000000000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,$SIDE,$SELL_AMOUNT,$MIN_BUY,$RECIPIENT,$EXPIRES_AFTER)")"

RAW="$(dex_sign_l2 "$KEY" "$BOOK" "$DATA" "$VALUE" "${DEX_PLACE_GAS:-600000}")"

# An ordinary L2 transaction: placing is not a cross-layer call. Only
# `settleWindow` goes to the L2->L1 front (A.2, SV-3).
dex_emit "$RAW" l2 place "$TRADER/$SIDE/$SELL_AMOUNT"

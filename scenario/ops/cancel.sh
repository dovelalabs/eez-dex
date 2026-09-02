#!/usr/bin/env bash
# `cancel` — the UP-2 external op that releases an open order's escrow (CT-7).
#
# The failure matrix's "cancel in the Sync block" row is this op fired in the
# wave that carries `settleWindow`: a cancel ordered before the settlement must
# shrink the selection and can never revert it (CT-7, CT-9). That is why it is
# an op rather than a setup step — it has to land in the same block, through
# the same harness, as the settlement it races.
#
# Plan line: <trader> <orderId>
set -euo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SLOT="${1:-0}"
LINE="$(dex_plan_line cancel "$SLOT")"
[[ -n "$LINE" ]] || exit 0

read -r TRADER ORDER_ID <<<"$LINE"
[[ -n "${ORDER_ID:-}" ]] || dex_die "malformed cancel line '$LINE'"

BOOK="$(dex_need DEX_WINDOW_BOOK)"
KEY="$(dex_trader_key "$TRADER")"
DATA="$(cast calldata "cancel(bytes32)" "$ORDER_ID")"
RAW="$(dex_sign_l2 "$KEY" "$BOOK" "$DATA" 0 "${DEX_CANCEL_GAS:-200000}")"

dex_emit "$RAW" l2 cancel "$TRADER/$ORDER_ID"

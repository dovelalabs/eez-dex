#!/usr/bin/env bash
# `drift` — the UP-2 external op that moves `MockPool` on L1 (HX-1, HX-3).
#
# Half the failure matrix is a price that moved: mid-window drift beyond some
# limits, all orders outside limit, the favourable move that breaks a crossed
# order's limit, and the raced pool move. All four are this op with different
# arguments and different timing.
#
# Plan line: <sqrtPriceX96> [priorityBoost]
#   sqrtPriceX96   the price to set, as `MockPool.setSqrtPriceX96` takes it
#   priorityBoost  multiplier on the harness's priority fee. The raced-pool row
#                  needs the move ordered *ahead* of the bundle in the same L1
#                  block, which is what a boost buys; every other row leaves it
#                  at 1.
#
# It goes to the ordinary L1 mempool (`side=l1`), not a front: moving a pool is
# not a cross-layer call, and the point of the row is that it is somebody
# else's transaction.
set -euo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SLOT="${1:-0}"
LINE="$(dex_plan_line drift "$SLOT")"
[[ -n "$LINE" ]] || exit 0

read -r SQRT_PRICE BOOST <<<"$LINE"
[[ -n "${SQRT_PRICE:-}" ]] || dex_die "malformed drift line '$LINE'"
BOOST="${BOOST:-1}"

POOL="$(dex_need DEX_POOL)"
KEY="${DEX_DRIFTER_KEY:-$DEX_GOVERNANCE_KEY}"
DATA="$(cast calldata "setSqrtPriceX96(uint160)" "$SQRT_PRICE")"
RAW="$(dex_sign_l1 "$KEY" "$POOL" "$DATA" "$BOOST")"

dex_emit "$RAW" l1 drift "$SQRT_PRICE/$BOOST"

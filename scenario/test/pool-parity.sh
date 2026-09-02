#!/usr/bin/env bash
# `MockPool`'s curve, against `MockPool` — RD-2 HX-1.
#
# `scenario/lib/pool.ts` reimplements the mock's swap so the harness can say
# what a residual *should* have returned before it looks at what it did. A
# reimplementation nobody checks is a second opinion from the same person, so
# this deploys the real contract to a local anvil, swaps through the real
# `UniswapV3Adapter`, and compares — output, price and tick — to the wei.
#
# Local only: anvil, the compiled artifacts, and nothing else. It runs inside
# `--self-test`, which is what CI runs on every pull request.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SCENARIO/.." && pwd)"
OUT="$ROOT/contracts/out"

PORT="${DEX_PARITY_PORT:-8899}"
RPC="http://127.0.0.1:$PORT"
# anvil account 0 — a local, throwaway chain and a published test key.
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

say()  { echo "  parity: $*"; }
die()  { echo "  parity: $*" >&2; exit 1; }

for tool in anvil cast jq node forge; do command -v "$tool" >/dev/null || die "$tool is not in PATH"; done

if [[ ! -d "$OUT" ]]; then
    say "compiling contracts"
    (cd "$ROOT/contracts" && forge build) >/dev/null || die "forge build failed"
fi

bytecode() {
    local file
    file="$(find "$OUT" -name "$1.json" -path "*/$1.sol/*" | head -1)"
    [[ -n "$file" ]] || die "no compiled artifact for $1"
    jq -er '.bytecode.object' "$file"
}

ANVIL_LOG="$(mktemp -t anvil-parity)"
ANVIL_PID=""
# Invoked by the trap below, which shellcheck cannot see.
# shellcheck disable=SC2329
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null; rm -f "$ANVIL_LOG"; true; }
trap cleanup EXIT

say "starting anvil on $PORT"
anvil --port "$PORT" --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 1
done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { cat "$ANVIL_LOG" >&2; die "anvil did not start on $PORT"; }

deploy() {
    local name="$1"; shift
    cast send --rpc-url "$RPC" --private-key "$KEY" --json --create "$(bytecode "$name")" "$@" \
        | jq -er '.contractAddress' | tr '[:upper:]' '[:lower:]'
}
send() { cast send --rpc-url "$RPC" --private-key "$KEY" "$@" >/dev/null; }

# A is the pool's token0, which is the orientation every price in this
# repository is quoted in (A.1). Deploy B until it sorts above A.
TOKEN_A="$(deploy MockWETH)"
TOKEN_B=""
for _ in 1 2 3 4 5 6 7 8; do
    candidate="$(deploy MockERC20 "constructor(string,string,uint8)" "parity USD" PUSD 18)"
    [[ "$candidate" > "$TOKEN_A" ]] && { TOKEN_B="$candidate"; break; }
done
[[ -n "$TOKEN_B" ]] || die "could not place B above A in address order"

SQRT_PRICE="$(cd "$SCENARIO" && node --input-type=module -e "
  import {sqrtPriceForPrice} from './lib/pool.ts';
  process.stdout.write(sqrtPriceForPrice(3000n, 1n).toString());
")"
LIQUIDITY=2000000000000000000000000
FEE=500

POOL="$(deploy MockPool "constructor(address,address,uint24,uint160,uint128)" \
    "$TOKEN_A" "$TOKEN_B" "$FEE" "$SQRT_PRICE" "$LIQUIDITY")"
ADAPTER="$(deploy UniswapV3Adapter "constructor(address,address)" "$POOL" "$TOKEN_A")"
say "pool $POOL, adapter $ADAPTER"

send "$TOKEN_A" "mint(address,uint256)" "$POOL" 1000000000000000000000000
send "$TOKEN_B" "mint(address,uint256)" "$POOL" 10000000000000000000000000000

failures=0

# One swap: give the adapter the input, ask what it would return, then do it
# and read the pool back. `eth_call` first because `cast send` does not return
# a value, and the call is at the same state the send executes against.
swap_case() {
    local side="$1" amount_in="$2" token
    token="$([[ "$side" == "0" ]] && echo "$TOKEN_A" || echo "$TOKEN_B")"

    local sqrt_before liquidity_before
    sqrt_before="$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" | head -1 | awk '{print $1}')"
    liquidity_before="$(cast call "$POOL" "liquidity()(uint128)" --rpc-url "$RPC" | awk '{print $1}')"

    send "$token" "mint(address,uint256)" "$ADAPTER" "$amount_in"
    local actual_out
    actual_out="$(cast call "$ADAPTER" "swap(uint8,uint256,uint256)(uint256)" "$side" "$amount_in" 0 \
        --rpc-url "$RPC" | awk '{print $1}')"
    send "$ADAPTER" "swap(uint8,uint256,uint256)" "$side" "$amount_in" 0

    local sqrt_after tick_after
    sqrt_after="$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" | head -1 | awk '{print $1}')"
    tick_after="$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" | sed -n 2p | awk '{print $1}')"

    local expected
    expected="$(cd "$SCENARIO" && node lib/cli.ts swap-oracle "$(cat <<JSON
{"pool":{"sqrtPriceX96":"$sqrt_before","liquidity":"$liquidity_before","fee":"$FEE"},
 "zeroForOne":$([[ "$side" == "0" ]] && echo true || echo false),"amountIn":"$amount_in"}
JSON
)")"

    local want_out want_sqrt want_tick
    want_out="$(jq -r '.amountOut' <<<"$expected")"
    want_sqrt="$(jq -r '.sqrtPriceX96' <<<"$expected")"
    want_tick="$(jq -r '.tick' <<<"$expected")"

    if [[ "$actual_out" == "$want_out" ]]; then
        say "side $side, in $amount_in: out $actual_out matches"
    else
        say "side $side, in $amount_in: out $actual_out, the oracle says $want_out"
        failures=$((failures + 1))
    fi
    if [[ "$sqrt_after" == "$want_sqrt" ]]; then
        say "side $side: the price landed where the oracle said ($sqrt_after)"
    else
        say "side $side: price $sqrt_after, the oracle says $want_sqrt"
        failures=$((failures + 1))
    fi
    if [[ "$tick_after" == "$want_tick" ]]; then
        say "side $side: tick $tick_after matches"
    else
        say "side $side: tick $tick_after, the oracle says $want_tick"
        failures=$((failures + 1))
    fi
}

# Both directions, and sizes spanning four orders of magnitude: a rounding
# mistake that hides at one size shows at another.
swap_case 0 1000000000000000000
swap_case 1 3000000000000000000000
swap_case 0 250000000000000000000
swap_case 1 900000000000000000000000
swap_case 0 1000000000000

if (( failures == 0 )); then
    say "the curve matches MockPool in every case"
    exit 0
fi
say "$failures comparisons disagreed"
exit 1

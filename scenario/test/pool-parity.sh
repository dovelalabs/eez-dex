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

artifact() { find "$OUT" -name "$1.json" -path "*/$1.sol/*" 2>/dev/null | head -1; }

# A restored build cache can be partial, so the check is for the artifacts this
# script actually deploys rather than for the directory holding them.
for contract in MockWETH MockERC20 MockPool UniswapV3Adapter; do
    [[ -n "$(artifact "$contract")" ]] && continue
    say "compiling contracts ($contract is not built)"
    (cd "$ROOT/contracts" && forge build) >/dev/null || die "forge build failed"
    break
done

bytecode() {
    local file
    file="$(artifact "$1")"
    [[ -n "$file" ]] || die "no compiled artifact for $1"
    jq -er '.bytecode.object' "$file"
}

# `mktemp -t <name>` appends the random suffix on BSD and demands it in the
# template on GNU, so the template carries it explicitly and the directory is
# named rather than implied.
ANVIL_LOG="$(mktemp "${TMPDIR:-/tmp}/anvil-parity.XXXXXX")"
ANVIL_PID=""
# Invoked by the trap below, which shellcheck cannot see. The code for that
# moved between shellcheck releases — 0.9 calls it SC2317, 0.11 SC2329 — and
# CI is not always on the same one as a developer, so both are named.
# shellcheck disable=SC2317,SC2329
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

# Numeric order over two lowercase 0x addresses, which a string comparison is
# only in the C locale.
address_below() {
    local LC_ALL=C
    [[ "$1" < "$2" ]]
}

# A is the pool's token0, which is the orientation every price in this
# repository is quoted in (A.1). Deploy B until it sorts above A.
# Both sides each round: redeploying only B leaves the outcome hostage to where
# A landed, and the retries run out instead of converging (see the bundle).
TOKEN_A=""
TOKEN_B=""
for _ in $(seq 1 16); do
    TOKEN_A="$(deploy MockWETH)"
    TOKEN_B="$(deploy MockERC20 "constructor(string,string,uint8)" "parity USD" PUSD 18)"
    address_below "$TOKEN_A" "$TOKEN_B" && break
    TOKEN_A=""
    TOKEN_B=""
done
[[ -n "$TOKEN_A" && -n "$TOKEN_B" ]] || die "could not place A below B in address order"

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

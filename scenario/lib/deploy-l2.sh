#!/usr/bin/env bash
# The L2 half of the deployment, and the setup a run needs — RD-2 HX-1, HX-2.
#
# The UP-1 bundle runs before the node starts, so there is no L2 to deploy on:
# what it does instead is predict `DexBridgeL2` and `WindowBook`'s addresses
# from the DEX deployer's L2 nonce and construct `SettlementRouter` against
# them. This file makes the prediction true, and stops the run if it does not.
#
# Order matters, and it is the deployer's nonce that makes it matter:
#
#   nonce 0   DexBridgeL2 implementation
#   nonce 1   its ERC-1967 proxy        <- DEX_BRIDGE_L2
#   nonce 2   WindowBook                <- DEX_WINDOW_BOOK
#
# `registerToken` sits between 1 and 2 but is sent by governance, so it does
# not move the deployer's nonce. Nothing else may ever sign from that account.
#
# Sourced, never executed.

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"

# A.1's enum ordinals, as WindowBook declares them.
DEX_PROFILE_FULL=0
DEX_PROFILE_GENESIS=1
DEX_FEE_MODE_BPS=0
DEX_ROUTE_FEE_ABSORB=0

# The EEZL2 predeploy: the L2 cross-chain manager the zone proxy is derived
# from, never hard-coded in the book (RD-2 §3).
DEX_EEZL2="${EEZL2_ADDRESS:-0x4200000000000000000000000000000000000007}"

# dex_l2_deploy_contract <Artifact> [sig] [args...] — deploy from the DEX
# deployer and echo the address, lower case.
dex_l2_deploy_contract() {
    local name="$1"; shift
    local code out address
    code="$(jq -er '.bytecode.object' "$DEX_ARTIFACTS/$name.json")" \
        || die "no artifact for $name; run scenario/bundle/build.sh --artifacts"
    out="$(cast send --rpc-url "$DEX_L2_RPC" --private-key "$DEX_DEPLOYER_KEY" --json --create "$code" "$@")" \
        || die "deploying $name on L2 failed"
    address="$(jq -er '.contractAddress' <<<"$out" | tr '[:upper:]' '[:lower:]')"
    say "  $name = $address"
    printf '%s' "$address"
}

dex_l2_send() { cast send --rpc-url "$DEX_L2_RPC" --private-key "$1" "${@:2}" >/dev/null; }
dex_l1_send() { cast send --rpc-url "$DEX_L1_RPC" --private-key "$1" "${@:2}" >/dev/null; }

# dex_deploy_l2 — the bridge, the L2 representation of B, and the book.
dex_deploy_l2() {
    step "deploying the L2 half"

    local nonce
    nonce="$(cast nonce "$DEX_DEPLOYER_ADDRESS" --rpc-url "$DEX_L2_RPC")"
    [[ "$nonce" == "0" ]] || die \
"the DEX deployer's L2 nonce is $nonce, not 0. The bundle predicted
     DexBridgeL2 and WindowBook from nonce 0; something else has signed from
     that account and the prediction is void. Start from a fresh enclave."

    local impl init proxy
    impl="$(dex_l2_deploy_contract DexBridgeL2)"
    init="$(cast calldata "initialize(address,uint64,address,address,address)" \
        "$DEX_EEZL2" 0 "$DEX_BRIDGE_L1" "$DEX_GOVERNANCE_ADDRESS" "$DEX_GOVERNANCE_ADDRESS")"
    proxy="$(dex_l2_deploy_contract ERC1967Proxy "constructor(address,bytes)" "$impl" "$init")"
    check_eq "HX-1" "DexBridgeL2 landed where the bundle predicted" "$proxy" "$DEX_BRIDGE_L2"

    # The L2 representation of B, created by the bridge and so not on the
    # deployer's nonce. It has to exist before the book, whose `assetB` is
    # immutable.
    dex_l2_send "$DEX_GOVERNANCE_KEY" "$proxy" \
        "registerToken(address,string,string,uint8)" "$DEX_ASSET_B" "eez-dex USD" DUSD 18
    DEX_ASSET_B_L2="$(cast call "$proxy" "l2TokenFor(address)(address)" "$DEX_ASSET_B" \
        --rpc-url "$DEX_L2_RPC" | tr '[:upper:]' '[:lower:]')"
    say "  L2 representation of B = $DEX_ASSET_B_L2"

    # The genesis mirror: the book opens with the pool's real state, so quotes
    # work before the first settlement refreshes it (FL-1).
    local sqrt_price liquidity tick
    sqrt_price="$(cast call "$DEX_POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" \
        --rpc-url "$DEX_L1_RPC" | head -1 | awk '{print $1}')"
    tick="$(cast call "$DEX_POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" \
        --rpc-url "$DEX_L1_RPC" | sed -n 2p | awk '{print $1}')"
    liquidity="$(cast call "$DEX_POOL" "liquidity()(uint128)" --rpc-url "$DEX_L1_RPC" | awk '{print $1}')"

    local profile="$DEX_PROFILE_FULL" asset_a="0x0000000000000000000000000000000000000000"
    [[ "${DEX_PROFILE:-full}" == "genesis" ]] && profile="$DEX_PROFILE_GENESIS"

    DEX_WINDOW_BOOK_ACTUAL="$(dex_l2_deploy_contract WindowBook \
        "constructor((uint8,address,address,address,address,address,address,address,uint8,uint16,uint256,uint256,uint8,uint256,uint8,uint64,address),address,(uint160,uint128,int24))" \
        "($profile,$DEX_EEZL2,$DEX_ROUTER,$proxy,$asset_a,$DEX_ASSET_B_L2,$DEX_ASSET_A,$DEX_ASSET_B,$DEX_FEE_MODE_BPS,${DEX_FEE_BPS:-1},0,0,$DEX_ROUTE_FEE_ABSORB,0,${DEX_WINDOW_SLOTS:-1},${DEX_L1_CALL_GAS:-2000000},$DEX_SETTLER_ADDRESS)" \
        "$DEX_GOVERNANCE_ADDRESS" \
        "($sqrt_price,$liquidity,$tick)")"
    check_eq "HX-1" "WindowBook landed where the bundle predicted" "$DEX_WINDOW_BOOK_ACTUAL" "$DEX_WINDOW_BOOK"

    export DEX_ASSET_B_L2
}

# dex_setup_balances — the allowances and the L2 balances a two-sided book
# needs before anybody can place on the B side.
#
# The deposit is a real inbound cross-chain call: `DexBridge.deposit` locks the
# L1 reserve and credits the L2 balances in the same frame (CT-5, CT-11), so
# one transaction both funds the traders and creates the reserve the residual
# sell side is released from. It goes to the L1 front, like every inbound call.
dex_setup_balances() {
    step "seeding L2 balances through the bridge"

    local per_trader="${DEX_TRADER_B_BALANCE:-60000000000000000000000}"   # 60k B each
    local credits="[" i address total raw nonce
    for (( i = 0; i < DEX_TRADER_COUNT; i++ )); do
        address="$(dex_trader_address "$i")"
        credits+="($address,$per_trader),"
    done
    credits="${credits%,}]"
    total="$(dex_mul "$per_trader" "$DEX_TRADER_COUNT")"

    say "minting $total of B to governance and approving the bridge"
    dex_l1_send "$DEX_GOVERNANCE_KEY" "$DEX_ASSET_B" "mint(address,uint256)" "$DEX_GOVERNANCE_ADDRESS" "$total"
    dex_l1_send "$DEX_GOVERNANCE_KEY" "$DEX_ASSET_B" "approve(address,uint256)" "$DEX_BRIDGE_L1" "$total"

    say "depositing through the L1 front so the credit lands on L2 in-frame"
    nonce="$(cast nonce "$DEX_GOVERNANCE_ADDRESS" --rpc-url "$DEX_L1_RPC" --block pending)"
    raw="$(cast mktx --rpc-url "$DEX_L1_RPC" --private-key "$DEX_GOVERNANCE_KEY" --nonce "$nonce" \
        --gas-limit "${DEX_DEPOSIT_GAS:-3000000}" \
        "$DEX_BRIDGE_L1" "deposit(address,uint256,(address,uint256)[])" "$DEX_ASSET_B" "$total" "$credits")"
    cast publish --rpc-url "$DEX_L1_FRONT" "$raw" >/dev/null \
        || die "the bridge deposit was not accepted by the L1 front"

    dex_wait_for_balance "$DEX_ASSET_B_L2" "$(dex_trader_address 0)" "$per_trader"

    say "approving the book to escrow B on every trader's behalf"
    for (( i = 0; i < DEX_TRADER_COUNT; i++ )); do
        dex_l2_send "$(dex_trader_key "$i")" "$DEX_ASSET_B_L2" \
            "approve(address,uint256)" "$DEX_WINDOW_BOOK" \
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    done
}

# dex_mul <a> <b> — 256-bit multiplication, which bash cannot do.
dex_mul() { python3 -c "print(int('$1') * int('$2'))"; }

# dex_ge <a> <b> — 256-bit comparison, for the same reason.
dex_ge() { python3 -c "import sys; sys.exit(0 if int('${1:-0}') >= int('${2:-0}') else 1)"; }

# dex_wait_for_balance <token> <owner> <want> — the inbound frame is not
# instant; wait for the credit rather than guessing at a sleep.
dex_wait_for_balance() {
    local token="$1" owner="$2" want="$3" deadline=$((SECONDS + ${DEX_WAIT_SECONDS:-300})) have
    while (( SECONDS < deadline )); do
        have="$(cast call "$token" "balanceOf(address)(uint256)" "$owner" --rpc-url "$DEX_L2_RPC" 2>/dev/null | awk '{print $1}')"
        if dex_ge "${have:-0}" "$want"; then
            say "the bridge credit landed: $owner holds $have"
            return 0
        fi
        sleep 2
    done
    die "the bridge credit never landed on L2; is the composer running?"
}

# The trader table, from accounts.env.
dex_trader_address() {
    local name="DEX_TRADER_${1}_ADDRESS"
    [[ -n "${!name:-}" ]] || die "no trader $1 in accounts.env"
    printf '%s' "${!name}"
}
dex_trader_key() {
    local name="DEX_TRADER_${1}_KEY"
    [[ -n "${!name:-}" ]] || die "no trader $1 in accounts.env"
    printf '%s' "${!name}"
}

#!/usr/bin/env bash
# Shared plumbing for the UP-2 external ops — RD-2 HX-3.
#
# `cross-chain-wave.sh` runs each `ext:` op with the wave number as its last
# argument and the enclave in its environment: the EEZ_WAVE_* endpoints and
# chain ids, plus everything in the enclave's `deployments.env`, which is where
# the DEX's own addresses ride in. The op prints a `key=value` block naming the
# raw signed transaction and where to submit it, or prints nothing to decline
# the wave.
#
# What an op is NOT allowed to do: decide anything. The scenario writes a plan
# — one file per wave per op kind — and the op emits the line for its slot.
# Order flow that a script improvised would not be reproducible, and HX-4's
# soak has to be re-runnable from a seed.
#
# Sourced, never executed.

set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

DEX_OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEX_SCENARIO_DIR="$(cd "$DEX_OPS_DIR/.." && pwd)"

# The identities. One file for the ops and the fixtures both (HX-2).
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/accounts.env"

# Where the scenario writes the plan. Every op reads from here and nowhere else.
DEX_PLAN_DIR="${DEX_PLAN_DIR:-$DEX_SCENARIO_DIR/.plan}"

# dex_die <message...> — an op that cannot do its job stops the run rather than
# printing something the harness would read as "nothing to send".
dex_die() {
    echo "dex op: $*" >&2
    exit 1
}

# dex_need <var> — a required deployment binding, named when it is missing.
dex_need() {
    local name="$1"
    local value="${!name:-}"
    [[ -n "$value" ]] || dex_die "$name is not set; is this running under cross-chain-wave.sh with the enclave's deployments.env?"
    printf '%s' "$value"
}

# dex_wave — the wave number the harness passed, defaulting to its environment.
dex_wave() {
    printf '%s' "${EEZ_WAVE_NUMBER:-1}"
}

# dex_plan_line <kind> <slot> — the plan entry for this wave and slot, or
# nothing. A missing file is a wave with nothing planned, which is normal; a
# missing *line* is the same. Neither is an error.
dex_plan_line() {
    local kind="$1" slot="${2:-0}" file
    file="$DEX_PLAN_DIR/wave-$(dex_wave).$kind"
    [[ -f "$file" ]] || return 0
    awk -v want="$slot" 'BEGIN{n=0} /^[[:space:]]*($|#)/{next} {if (n==want) {print; exit} n++}' "$file"
}

# dex_trader_key <index> / dex_trader_address <index>
dex_trader_key() {
    local name="DEX_TRADER_${1}_KEY"
    [[ -n "${!name:-}" ]] || dex_die "no trader $1 in accounts.env"
    printf '%s' "${!name}"
}
dex_trader_address() {
    local name="DEX_TRADER_${1}_ADDRESS"
    [[ -n "${!name:-}" ]] || dex_die "no trader $1 in accounts.env"
    printf '%s' "${!name}"
}

# dex_nonce <rpc> <address> — the next nonce, counting what is already pending.
dex_nonce() {
    cast nonce "$2" --rpc-url "$1" --block pending
}

# dex_sign_l2 <key> <to> <calldata> <value> <gas> — a raw signed L2 transaction.
dex_sign_l2() {
    local key="$1" to="$2" data="$3" value="${4:-0}" gas="${5:-500000}" from nonce
    from="$(cast wallet address --private-key "$key")"
    nonce="$(dex_nonce "$EEZ_WAVE_L2_RPC" "$from")"
    cast mktx \
        --chain-id "$EEZ_WAVE_L2_CHAIN_ID" \
        --private-key "$key" \
        --nonce "$nonce" \
        --gas-limit "$gas" \
        --gas-price "$EEZ_WAVE_L2_GAS_PRICE" \
        --priority-gas-price "$EEZ_WAVE_PRIORITY_GAS_PRICE" \
        --value "$value" \
        "$to" "$data"
}

# dex_sign_l1 <key> <to> <calldata> <priority-multiplier> — a raw signed L1
# transaction. The multiplier is what the raced-pool row needs: the same block
# as the bundle, ordered ahead of it.
dex_sign_l1() {
    local key="$1" to="$2" data="$3" boost="${4:-1}" from nonce priority
    from="$(cast wallet address --private-key "$key")"
    nonce="$(dex_nonce "$EEZ_WAVE_L1_RPC" "$from")"
    priority=$((EEZ_WAVE_PRIORITY_GAS_PRICE * boost))
    cast mktx \
        --chain-id "$EEZ_WAVE_L1_CHAIN_ID" \
        --private-key "$key" \
        --nonce "$nonce" \
        --gas-limit 200000 \
        --gas-price $((EEZ_WAVE_L1_GAS_PRICE + priority)) \
        --priority-gas-price "$priority" \
        "$to" "$data"
}

# dex_emit <raw> <side> <kind> <arg> — the harness's output contract. `kind`
# lands in TX_META and the per-kind tally, which is how the scenario counts
# what actually confirmed.
dex_emit() {
    cat <<OP
raw=$1
side=$2
kind=$3
arg=$4
OP
}

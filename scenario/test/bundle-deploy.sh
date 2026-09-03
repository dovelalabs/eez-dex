#!/usr/bin/env bash
# The UP-1 bundle, actually run — RD-2 HX-1, UP-1.
#
# The self-test used to check the bundle by reading it: the image it names, the
# environment it reads, the contracts it deploys. None of that catches a bundle
# that runs and produces nothing usable, and one did — `say` wrote to stdout,
# `deploy` is read through command substitution, and so every address it
# exported was a log line with an address stuck to the end of it. The enclave
# was the only thing that could see it, and the enclave rows run nightly at
# best.
#
# So this runs the real bundle against a local anvil, standing in for the
# framework's deploy step with the two bindings it writes that the DEX reads,
# and asserts the seam's output contract: `deployments.env` gains DEX bindings,
# every one of them is an address, and the pair is oriented with A below B.
#
# Local only: anvil, the compiled artifacts, and nothing else.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO="$(cd "$HERE/.." && pwd)"

PORT="${DEX_BUNDLE_PORT:-8898}"
RPC="http://127.0.0.1:$PORT"
# anvil account 0 — a local, throwaway chain and a published test key.
POSTER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

say() { echo "  bundle: $*"; }
die() { echo "  bundle: $*" >&2; exit 1; }

for tool in anvil cast jq forge; do command -v "$tool" >/dev/null || die "$tool is not in PATH"; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dex-bundle.XXXXXX")"
ANVIL_LOG="$WORK/anvil.log"
ANVIL_PID=""
# Invoked by the trap, which shellcheck cannot see; the code for that moved
# between releases (SC2317 in 0.9, SC2329 in 0.11), so both are named.
# shellcheck disable=SC2317,SC2329
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null; rm -rf "$WORK"; true; }
trap cleanup EXIT

# The artifacts the bundle deploys are exported by build.sh, not read from
# forge's output directory: the image ships artifacts and no sources.
if [[ ! -f "$SCENARIO/bundle/artifacts/WindowBook.json" ]]; then
    say "exporting the bundle's artifacts"
    "$SCENARIO/bundle/build.sh" --artifacts >/dev/null || die "the artifact export failed"
fi

say "starting anvil on $PORT"
anvil --port "$PORT" --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 1
done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { cat "$ANVIL_LOG" >&2; die "anvil did not start on $PORT"; }

# The framework's half of the seam: the deploy step writes these two bindings
# before the DEX's script runs, and they are all of it that the DEX reads.
DEPLOYMENTS="$WORK/deployments.env"
cat >"$DEPLOYMENTS" <<ENV
EEZ_REGISTRY_ADDRESS=0x5fbdb2315678afecb367f032d93f642f64180aa3
EEZ_ROLLUP_ID=1
ENV
touch "$WORK/l2-genesis.json"

say "running the bundle against $RPC"
EEZ_L1_RPC_URL="$RPC" \
EEZ_L1_POSTER_KEY="$POSTER_KEY" \
EEZ_DEPLOYMENTS_FILE="$DEPLOYMENTS" \
EEZ_GENESIS_OUT="$WORK/l2-genesis.json" \
    "$SCENARIO/bundle/deploy-dex.sh" >"$WORK/bundle.log" 2>&1 \
    || { tail -20 "$WORK/bundle.log" >&2; die "the bundle did not deploy"; }

set -a
# shellcheck source=/dev/null
. "$DEPLOYMENTS"
set +a

FAILURES=0
check() {
    if [[ "$2" == "0" ]]; then say "ok   $1"; else say "FAIL $1"; FAILURES=$((FAILURES + 1)); fi
}

for binding in DEX_ASSET_A DEX_ASSET_B DEX_POOL DEX_ADAPTER DEX_ROUTER DEX_BRIDGE_L1 DEX_BRIDGE_L2 DEX_WINDOW_BOOK; do
    value="${!binding:-}"
    if [[ "$value" =~ ^0x[0-9a-f]{40}$ ]]; then
        check "$binding is an address ($value)" 0
    else
        check "$binding is an address, not '${value:0:60}'" 1
    fi
done

# A must be the pool's token0: the orientation every price is quoted in (A.1).
address_below() {
    local LC_ALL=C
    [[ "$1" < "$2" ]]
}
if address_below "$DEX_ASSET_A" "$DEX_ASSET_B"; then
    check "A sorts below B, so A is the pool's token0" 0
else
    check "A sorts below B, so A is the pool's token0" 1
fi

# The contracts are really there, and wired to each other.
code_at() { cast code "$1" --rpc-url "$RPC" | wc -c | tr -d ' '; }
for binding in DEX_ASSET_A DEX_ASSET_B DEX_POOL DEX_ADAPTER DEX_ROUTER DEX_BRIDGE_L1; do
    if [[ "$(code_at "${!binding}")" -gt 4 ]]; then
        check "$binding has code on chain" 0
    else
        check "$binding has code on chain" 1
    fi
done

ROUTER_ADAPTER="$(cast call "$DEX_ROUTER" "adapter()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')"
check "the router names the adapter the bundle deployed" \
    "$([[ "$ROUTER_ADAPTER" == "$DEX_ADAPTER" ]] && echo 0 || echo 1)"

ROUTER_BOOK="$(cast call "$DEX_ROUTER" "windowBook()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')"
check "the router names the predicted WindowBook (CT-5's circular dependency)" \
    "$([[ "$ROUTER_BOOK" == "$DEX_WINDOW_BOOK" ]] && echo 0 || echo 1)"

POOL_TOKEN0="$(cast call "$DEX_POOL" "token0()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')"
check "the pool's token0 is A" "$([[ "$POOL_TOKEN0" == "$DEX_ASSET_A" ]] && echo 0 || echo 1)"

(( FAILURES == 0 )) || die "$FAILURES bundle checks failed; see $WORK/bundle.log"
say "the bundle deployed and its bindings are usable"

#!/usr/bin/env bash
# The UP-1 external deployment bundle — RD-2 HX-1.
#
# The framework's `eez-deployments` step is a seam with a fixed contract:
#
#   in    exactly six environment variables — EEZ_L1_RPC_URL,
#         EEZ_L1_POSTER_KEY, EEZ_PROOF_SIGNER_KEY, EEZ_L2_SYSTEM_KEY,
#         EEZ_DEPLOYMENTS_FILE, EEZ_GENESIS_OUT
#   out   exactly one files artifact, `deployments.env` + `l2-genesis.json`
#
# This script is the consumer's half of it. It runs the framework's own deploy
# first — the node and the proof signer source the bindings it writes, so they
# must still be there — and then deploys the DEX's L1 contracts alongside them
# and appends its own bindings to the same file. The framework never learns
# what they are; every workload script gets them for free.
#
# **The L2 half is not deployed here**, because there is no L2 yet: this step
# runs before the node starts. What the bundle does instead is *predict*
# `DexBridgeL2` and `WindowBook`'s addresses from the DEX deployer's L2 nonce,
# so `SettlementRouter` can be constructed against a book that does not exist
# yet. `dex-scenario.sh` deploys them once the enclave is up and fails loudly
# if an address does not match the prediction — which is why nothing else may
# ever sign from the deployer account.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

DEX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACTS="${DEX_ARTIFACTS:-$DEX_DIR/artifacts}"

say() { echo "dex-deploy: $*"; }
die() { echo "dex-deploy: $*" >&2; exit 1; }

for tool in cast jq; do command -v "$tool" >/dev/null || die "$tool is not in PATH"; done

: "${EEZ_L1_RPC_URL:?the UP-1 contract sets this}"
: "${EEZ_L1_POSTER_KEY:?the UP-1 contract sets this}"
: "${EEZ_DEPLOYMENTS_FILE:?the UP-1 contract sets this}"
RPC="$EEZ_L1_RPC_URL"

# The DEX's own identities, committed beside the ops that sign with them.
# shellcheck source=/dev/null
. "$DEX_DIR/accounts.env"

# The framework's bindings — the registry the zone proxy is derived from, and
# the rollup id the L2 lives on (RD-2 §3).
[[ -f "$EEZ_DEPLOYMENTS_FILE" ]] || die "$EEZ_DEPLOYMENTS_FILE not found; the framework's deploy must run first"
set -a
# shellcheck source=/dev/null
. "$EEZ_DEPLOYMENTS_FILE"
set +a
: "${EEZ_REGISTRY_ADDRESS:?the framework deploy writes this}"
: "${EEZ_ROLLUP_ID:?the framework deploy writes this}"

# The pair, as the scenario configures it. A is the pool's token0 and the
# rail's native asset (zone ETH on L2, WETH on L1); B is an ERC-20 that reaches
# L2 through the DEX's own bridge (CT-5, CT-11).
POOL_SQRT_PRICE_X96="${DEX_POOL_SQRT_PRICE_X96:-4339505179874779489431521786241}"   # 3000 B per A
POOL_LIQUIDITY="${DEX_POOL_LIQUIDITY:-2000000000000000000000000}"
POOL_FEE="${DEX_POOL_FEE:-500}"                                                     # the deepest tier
POOL_SEED_A="${DEX_POOL_SEED_A:-1000000000000000000000000}"                         # 1e6 A
POOL_SEED_B="${DEX_POOL_SEED_B:-10000000000000000000000000000}"                     # 1e10 B
BRIDGE_RESERVE="${DEX_BRIDGE_RESERVE:-1000000000000000000000000}"                   # 1e6 B, seeded on L2
BRIDGE_RATE_LIMIT_WINDOW="${DEX_BRIDGE_RATE_LIMIT_WINDOW:-3600}"

# --- helpers ------------------------------------------------------------------

# bytecode <Contract> — the creation code of a compiled artifact.
bytecode() {
    local file="$ARTIFACTS/$1.json"
    [[ -f "$file" ]] || die "no artifact for $1; run scenario/bundle/build.sh"
    jq -er '.bytecode.object' "$file"
}

# deploy <Contract> [constructor-sig] [args...] — deploys and echoes the address.
deploy() {
    local name="$1"; shift
    local code out address
    code="$(bytecode "$name")"
    out="$(cast send --rpc-url "$RPC" --private-key "$DEX_DEPLOYER_KEY" --json --create "$code" "$@")" \
        || die "deploying $name failed"
    address="$(jq -er '.contractAddress' <<<"$out" | tr '[:upper:]' '[:lower:]')"
    [[ "$address" =~ ^0x[0-9a-f]{40}$ ]] || die "deploying $name returned no address"
    say "  $name = $address"
    printf '%s' "$address"
}

send() { cast send --rpc-url "$RPC" --private-key "$1" "${@:2}" >/dev/null; }

# --- fund the DEX's L1 identities ---------------------------------------------
# The ethereum-package prefunds its own accounts, not ours. The poster is the
# only key this step is given, so it is what funds the deployer and the account
# the `drift` op moves the pool from.

say "funding the DEX deployer and the pool driver from the poster"
for account in "$DEX_DEPLOYER_ADDRESS" "$DEX_GOVERNANCE_ADDRESS" "$DEX_SETTLER_ADDRESS"; do
    send "$EEZ_L1_POSTER_KEY" "$account" --value 100ether
done

# --- the pair -----------------------------------------------------------------
# A must sort below B so that A is the pool's `token0`, which is the
# orientation `sqrtPriceX96` is quoted in and the one every price in this
# repository is stated against (A.1). The mock's address is a function of the
# deployer's nonce, so the ordering is arranged by deploying B again until it
# sorts above A — deterministic on a fresh chain, and cheap.

say "deploying the pair"
ASSET_A="$(deploy MockWETH)"
ASSET_B=""
for _ in 1 2 3 4 5 6 7 8; do
    ASSET_B="$(deploy MockERC20 "constructor(string,string,uint8)" "eez-dex USD" DUSD 18)"
    [[ "$ASSET_B" > "$ASSET_A" ]] && break
    say "  B sorts below A; deploying it again so A stays token0"
    ASSET_B=""
done
[[ -n "$ASSET_B" ]] || die "could not place B above A in address order after eight attempts"

# --- the venue ----------------------------------------------------------------

say "deploying MockPool and the adapter"
POOL="$(deploy MockPool "constructor(address,address,uint24,uint160,uint128)" \
    "$ASSET_A" "$ASSET_B" "$POOL_FEE" "$POOL_SQRT_PRICE_X96" "$POOL_LIQUIDITY")"
ADAPTER="$(deploy UniswapV3Adapter "constructor(address,address)" "$POOL" "$ASSET_A")"

say "seeding the pool's reserves"
send "$DEX_DEPLOYER_KEY" "$ASSET_A" "mint(address,uint256)" "$POOL" "$POOL_SEED_A"
send "$DEX_DEPLOYER_KEY" "$ASSET_B" "mint(address,uint256)" "$POOL" "$POOL_SEED_B"

# --- the bridge, and the two addresses the L2 half will take -------------------
# `DexBridgeL2` is the deployer's L2 nonce 1 (implementation at 0, proxy at 1)
# and `WindowBook` is nonce 2. Predicting them is what breaks the circular
# dependency between a router that names the book and a book that names the
# router (CT-5, CT-11).

BRIDGE_L2="$(cast compute-address "$DEX_DEPLOYER_ADDRESS" --nonce 1 | awk '{print tolower($NF)}')"
WINDOW_BOOK="$(cast compute-address "$DEX_DEPLOYER_ADDRESS" --nonce 2 | awk '{print tolower($NF)}')"
say "the L2 half will deploy to: DexBridgeL2 = $BRIDGE_L2, WindowBook = $WINDOW_BOOK"

say "deploying DexBridge behind its proxy"
BRIDGE_IMPL="$(deploy DexBridge)"
BRIDGE_INIT="$(cast calldata "initialize(address,uint64,address,address,address,uint256)" \
    "$EEZ_REGISTRY_ADDRESS" "$EEZ_ROLLUP_ID" "$BRIDGE_L2" \
    "$DEX_GOVERNANCE_ADDRESS" "$DEX_GOVERNANCE_ADDRESS" "$BRIDGE_RATE_LIMIT_WINDOW")"
BRIDGE="$(deploy ERC1967Proxy "constructor(address,bytes)" "$BRIDGE_IMPL" "$BRIDGE_INIT")"

say "supporting B on the bridge"
send "$DEX_GOVERNANCE_KEY" "$BRIDGE" "setTokenSupport(address,bool,uint256)" \
    "$ASSET_B" true "$BRIDGE_RESERVE"

# The reserve itself is created by a `deposit`, which is a cross-chain call and
# so cannot happen until the L2 exists; `dex-scenario.sh` makes it during setup
# and that same deposit is what gives the traders their L2 balance of B.

# --- the router ---------------------------------------------------------------

say "deploying SettlementRouter"
ROUTER="$(deploy SettlementRouter "constructor(address,uint64,address,address,address,address,address,address)" \
    "$EEZ_REGISTRY_ADDRESS" "$EEZ_ROLLUP_ID" "$WINDOW_BOOK" "$ADAPTER" \
    "$ASSET_A" "$ASSET_B" "$ASSET_A" "$BRIDGE")"

# --- the bindings -------------------------------------------------------------
# Appended to the framework's own file, which the node and the proof signer
# source. Everything here reaches every workload script and every `ext:` op.

say "appending the DEX bindings to $EEZ_DEPLOYMENTS_FILE"
cat >>"$EEZ_DEPLOYMENTS_FILE" <<EOF

# --- eez-dex (HX-1 external deployment bundle) --------------------------------
# A is the pool's token0 and the rail's native asset; prices are B per A in Q96.
DEX_ASSET_A=$ASSET_A
DEX_ASSET_B=$ASSET_B
DEX_A_IS_TOKEN0=true
DEX_POOL=$POOL
DEX_POOL_FEE=$POOL_FEE
DEX_POOL_SQRT_PRICE_X96=$POOL_SQRT_PRICE_X96
DEX_POOL_LIQUIDITY=$POOL_LIQUIDITY
DEX_ADAPTER=$ADAPTER
DEX_ROUTER=$ROUTER
DEX_BRIDGE_L1=$BRIDGE
DEX_BRIDGE_L1_IMPL=$BRIDGE_IMPL
DEX_BRIDGE_RESERVE=$BRIDGE_RESERVE
# Predicted from the deployer's L2 nonce; dex-scenario.sh asserts the match.
DEX_BRIDGE_L2=$BRIDGE_L2
DEX_WINDOW_BOOK=$WINDOW_BOOK
DEX_DEPLOYER=$DEX_DEPLOYER_ADDRESS
DEX_SETTLER=$DEX_SETTLER_ADDRESS
DEX_GOVERNANCE=$DEX_GOVERNANCE_ADDRESS
DEX_ZONE_ROLLUP_ID=$EEZ_ROLLUP_ID
EOF

# The output contract: one artifact, two files, both already at /out.
[[ -f "${EEZ_GENESIS_OUT:-/out/l2-genesis.json}" ]] \
    || die "the framework's deploy did not leave ${EEZ_GENESIS_OUT:-/out/l2-genesis.json}"

say "done"

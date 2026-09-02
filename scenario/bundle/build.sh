#!/usr/bin/env bash
# Build the UP-1 external deployment bundle — RD-2 HX-1.
#
#   scenario/bundle/build.sh              compile and build the image
#   scenario/bundle/build.sh --artifacts  compile and export artifacts only
#
# Two steps. Compile the contracts with the pinned solc settings, and export
# exactly the artifacts the bundle deploys — no sources, so the image cannot
# drift from what `make check` compiled. Then layer them onto the framework's
# deploy image, whose own `scripts/deploy.sh` still writes the protocol
# bindings the node and the proof signer source.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ARTIFACTS="$HERE/artifacts"

IMAGE="${DEX_DEPLOY_IMAGE:-eez-dex-deploy:dev}"
BASE_IMAGE="${DEX_DEPLOY_BASE_IMAGE:-eez-deploy:ci}"

# Everything the bundle deploys, by artifact name. `MockPool` and `MockERC20`
# are frozen test mocks (RD-2 §5) — packaged, not forked.
CONTRACTS=(
    MockWETH
    MockERC20
    MockPool
    UniswapV3Adapter
    SettlementRouter
    DexBridge
    DexBridgeL2
    WindowBook
    ERC1967Proxy
)

say() { echo "bundle: $*"; }
die() { echo "bundle: $*" >&2; exit 1; }

command -v forge >/dev/null || die "forge is not in PATH"
command -v jq >/dev/null || die "jq is not in PATH"

say "compiling contracts"
make -C "$ROOT" deps >/dev/null
(cd "$ROOT/contracts" && forge build) >/dev/null

say "exporting artifacts to $ARTIFACTS"
rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"
for name in "${CONTRACTS[@]}"; do
    src="$(find "$ROOT/contracts/out" -name "$name.json" -path "*/$name.sol/*" | head -1)"
    [[ -n "$src" ]] || die "no compiled artifact for $name; did forge build succeed?"
    # Creation code and ABI are all the deploy script reads; dropping the rest
    # keeps the image small and the diff on a rebuild readable.
    jq '{abi, bytecode: {object: .bytecode.object}}' "$src" >"$ARTIFACTS/$name.json"
    say "  $name"
done

# The identities the deploy script signs with travel with it.
cp "$ROOT/scenario/accounts.env" "$HERE/accounts.env"

[[ "${1:-}" == "--artifacts" ]] && { say "artifacts only; skipping the image"; exit 0; }

command -v docker >/dev/null || die "docker is not in PATH"
docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || die \
    "the base image $BASE_IMAGE does not exist. The framework builds it:
       cd <eez-rollup0> && bash testing/kurtosis/start.sh testing/kurtosis/ci-args.yaml
     or set DEX_DEPLOY_BASE_IMAGE to one that is already published."

say "building $IMAGE from $BASE_IMAGE"
docker build --build-arg "EEZ_DEPLOY_IMAGE=$BASE_IMAGE" -t "$IMAGE" "$HERE"
say "built $IMAGE"

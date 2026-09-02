#!/usr/bin/env bash
# Bringing the enclave up and reading it — RD-2 HX-2, UP-3.
#
# The framework's Kurtosis package is a supported dependency: `run(plan, args)`
# and the frozen `eez` key set. This file consumes it by name at the revision
# `FRAMEWORK_COMMIT` pins, resolves the published endpoints, and pulls the one
# `eez-deployments` artifact the DEX's own bindings ride in.
#
# A remote run evaluates `main.star` directly and never runs the framework's
# `start.sh`, so it builds no images. That is a feature — the scenario does not
# want a framework checkout — but it means every image the args file names must
# already exist. `dex_preflight` says so before Kurtosis spends five minutes
# discovering it.
#
# Sourced, never executed.

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"

DEX_ENCLAVE="${KURTOSIS_ENCLAVE:-eez-dex}"
DEX_ARGS_FILE="${DEX_ARGS_FILE:-$DEX_SCENARIO_DIR/args/dex-args.yaml}"

# The Kurtosis package reference is generated from FRAMEWORK_COMMIT (RL-1).
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/framework-pin.env"

# dex_preflight — every tool and image the run needs, named before it is spent.
dex_preflight() {
    local missing=0 tool
    for tool in kurtosis docker cast jq node; do
        command -v "$tool" >/dev/null || { say_bad "$tool is not in PATH"; missing=1; }
    done
    (( missing == 0 )) || die "install the missing tools and try again"

    docker info >/dev/null 2>&1 || die "the Docker daemon is not running"

    # UP-3: a remote run builds nothing.
    local image
    for image in $(dex_args_images); do
        docker image inspect "$image" >/dev/null 2>&1 || die \
"the image '$image' does not exist locally and a remote Kurtosis run builds nothing (UP-3).
     Build the framework's images once:
       cd <eez-rollup0> && bash testing/kurtosis/start.sh testing/kurtosis/ci-args.yaml && bash testing/kurtosis/stop.sh
     and this repository's deployment bundle:
       scenario/bundle/build.sh"
    done
}

# dex_args_images — the images named in the args file's `eez` block.
dex_args_images() {
    sed -nE 's/^[[:space:]]+[a-z_]*image:[[:space:]]*(.+)$/\1/p' "$DEX_ARGS_FILE" | tr -d '"' | sort -u
}

# dex_enclave_up — bring the network up, or adopt one that is already running.
dex_enclave_up() {
    if kurtosis enclave inspect "$DEX_ENCLAVE" >/dev/null 2>&1; then
        say "adopting the running enclave '$DEX_ENCLAVE'"
        return 0
    fi
    step "bringing up the enclave '$DEX_ENCLAVE' from $EEZ_KURTOSIS_LOCATOR"
    kurtosis run "$EEZ_KURTOSIS_LOCATOR" \
        --enclave "$DEX_ENCLAVE" \
        --args-file "$DEX_ARGS_FILE" \
        || die "the enclave did not come up"
}

# dex_enclave_down — force-remove the enclave and its ephemeral chain state.
dex_enclave_down() {
    [[ "${DEX_KEEP:-0}" == "1" ]] && { say "keeping the enclave '$DEX_ENCLAVE'"; return 0; }
    say "removing the enclave '$DEX_ENCLAVE'"
    kurtosis enclave rm -f "$DEX_ENCLAVE" >/dev/null 2>&1 || true
}

# dex_port <service> <port> — the published http endpoint, or empty.
dex_port() {
    local raw
    raw="$(kurtosis port print "$DEX_ENCLAVE" "$1" "$2" 2>/dev/null || true)"
    case "$raw" in
        http*) printf '%s' "$raw" ;;
        "")    printf '' ;;
        *)     printf 'http://%s' "$raw" ;;
    esac
}

# dex_endpoints — export the four RPCs the run drives. Named exactly as the
# framework's own ports.sh does, so a reader moving between the two repositories
# is looking at the same variables.
dex_endpoints() {
    DEX_L1_RPC="$(dex_port el-1-reth-lighthouse rpc)"
    DEX_L2_RPC="$(dex_port eez-node l2-rpc)"
    DEX_L1_FRONT="$(dex_port eez-node l1-xchain)"
    DEX_L2_FRONT="$(dex_port eez-node l2-xchain)"
    export DEX_L1_RPC DEX_L2_RPC DEX_L1_FRONT DEX_L2_FRONT
    [[ -n "$DEX_L1_RPC" && -n "$DEX_L2_RPC" && -n "$DEX_L1_FRONT" && -n "$DEX_L2_FRONT" ]] \
        || die "the enclave published no endpoints; is '$DEX_ENCLAVE' healthy?"
    say "L1 $DEX_L1_RPC · L2 $DEX_L2_RPC · fronts $DEX_L1_FRONT / $DEX_L2_FRONT"
}

# dex_deployments — download the one `eez-deployments` artifact and source it.
# The DEX's own bindings were appended to it by the bundle (HX-1), so this is
# where DEX_WINDOW_BOOK and friends come from.
dex_deployments() {
    local target="$DEX_RUN_DIR/deployments"
    rm -rf "$target"
    mkdir -p "$target"
    kurtosis files download "$DEX_ENCLAVE" eez-deployments "$target" >/dev/null \
        || die "could not download the eez-deployments artifact"
    [[ -f "$target/deployments.env" ]] || die "the artifact has no deployments.env"

    set -a
    # shellcheck source=/dev/null
    . "$target/deployments.env"
    set +a

    [[ -n "${DEX_ROUTER:-}" ]] || die \
"deployments.env carries no DEX bindings. The enclave was deployed with the
     framework's own bundle rather than this repository's: check that
     scenario/args/dex-args.yaml is the args file in use and that
     eez.deploy_image names the image scenario/bundle/build.sh built."
    say "router $DEX_ROUTER · pool $DEX_POOL · book (predicted) $DEX_WINDOW_BOOK"
}

# dex_wait_for_l2 <blocks> — wait until the L2 has produced `blocks` blocks.
dex_wait_for_l2() {
    local want="${1:-1}" deadline=$((SECONDS + ${DEX_WAIT_SECONDS:-300})) height
    while (( SECONDS < deadline )); do
        height="$(cast block-number --rpc-url "$DEX_L2_RPC" 2>/dev/null || echo 0)"
        (( height >= want )) && { say "L2 is at block $height"; return 0; }
        sleep 2
    done
    die "the L2 did not reach block $want within ${DEX_WAIT_SECONDS:-300}s"
}

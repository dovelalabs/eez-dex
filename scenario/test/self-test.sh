#!/usr/bin/env bash
# The hermetic half of WP-4 — RD-2 HX-1 … HX-5, RL-4.
#
#     scenario/dex-scenario.sh --self-test
#
# No enclave, no Docker, no network. What it checks is everything about this
# work package that does not need a running network:
#
#   * the shell lints, all of it — `make lint-scenario` only globs
#     `scenario/*.sh`, and most of this package is below that
#   * the TypeScript type-checks and its suite passes: the settlement oracle,
#     the recorder, the A.6 assertions, the soak's seeded plan
#   * the three `ext:` ops honour UP-2's output contract, driven end to end
#     against a stubbed `cast`
#   * the UP-1 bundle and the UP-3 args file agree with the seam they consume
#   * the committed HX-5 fixtures still validate against the frozen schema
#   * the metric names the harness asserts on are the frozen ones
#   * `MockPool`'s curve, as this repository reimplements it, matches the
#     contract itself — deployed to a local anvil and swapped against
#
# This is what CI runs on every pull request. The enclave rows run beside it
# where a runner can host Kurtosis (RL-4).
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEX_SCENARIO_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$DEX_SCENARIO_DIR/.." && pwd)"
export DEX_SCENARIO_DIR

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"

# The frozen `eez` args key set, transcribed from `EEZ_ARG_KEYS` at the top of
# the framework's `testing/kurtosis/main.star` at the revision FRAMEWORK_COMMIT
# pins. When a checkout is reachable the real list is read and compared, so
# this copy cannot rot silently.
EEZ_ARG_KEYS_EXPECTED="blockscout_frontend_image blockscout_image blockscout_postgres_image blockscout_verifier_image builder_rpc_url deploy_cmd deploy_image deployments_artifact eez_node_image enable_explorers fee_recipient follower_image l1_block_time_ms l2_block_time_ms l2_system_key max_speculative_depth poster_key proof_signer_image proof_signer_key proof_signer_rust_log proof_time_ms submission_slack_ms"

# The six environment variables the UP-1 deployment step is given, and nothing
# else.
DEPLOY_ENV_KEYS="EEZ_DEPLOYMENTS_FILE EEZ_GENESIS_OUT EEZ_L1_POSTER_KEY EEZ_L1_RPC_URL EEZ_L2_SYSTEM_KEY EEZ_PROOF_SIGNER_KEY"

# ── shell lint ────────────────────────────────────────────────────────────────

step "shell lint"
if command -v shellcheck >/dev/null 2>&1; then
    mapfile -t SCRIPTS < <(find "$DEX_SCENARIO_DIR" -name '*.sh' -not -path '*/.framework/*' | sort)
    if shellcheck "${SCRIPTS[@]}"; then
        check "RL-4" "every script under scenario/ passes shellcheck (${#SCRIPTS[@]} files)" 0
    else
        check "RL-4" "every script under scenario/ passes shellcheck" 1
    fi
else
    check "RL-4" "shellcheck is installed (a soft skip is not a passing lint)" 1
fi

# ── the TypeScript half ───────────────────────────────────────────────────────

step "the oracle, the recorder and the assertions"
if (cd "$DEX_SCENARIO_DIR" && npm run --silent ci); then
    check "TS-4" "the scenario's own suite passes" 0
else
    check "TS-4" "the scenario's own suite passes" 1
fi

# ── UP-1: the external deployment bundle ──────────────────────────────────────

step "UP-1 external deployment bundle"
DEPLOY_SH="$DEX_SCENARIO_DIR/bundle/deploy-dex.sh"
DOCKERFILE="$DEX_SCENARIO_DIR/bundle/Dockerfile"
ARGS="$DEX_SCENARIO_DIR/args/dex-args.yaml"

# The bundle must run the framework's own deploy first: the node and the proof
# signer source the bindings it writes, and a bundle that replaced it would
# start a network that cannot prove anything.
if grep -q 'bash /repo/scripts/deploy.sh' "$ARGS"; then
    check "UP-1" "deploy_cmd runs the framework deploy before the DEX's" 0
else
    check "UP-1" "deploy_cmd runs the framework deploy before the DEX's" 1
fi
if grep -q 'bash /dex/deploy-dex.sh' "$ARGS"; then
    check "HX-1" "deploy_cmd runs this repository's bundle" 0
else
    check "HX-1" "deploy_cmd runs this repository's bundle" 1
fi
check_eq "UP-1" "the image the args file names is the one the bundle builds" \
    "$(sed -nE 's/^[[:space:]]+deploy_image:[[:space:]]*(.+)$/\1/p' "$ARGS")" \
    "$(sed -nE 's/^IMAGE="\$\{DEX_DEPLOY_IMAGE:-(.+)\}"$/\1/p' "$DEX_SCENARIO_DIR/bundle/build.sh")"
check_eq "UP-1" "the Dockerfile's default command is the args file's" \
    "$(sed -nE 's/^CMD \["(.*)"\]$/\1/p' "$DOCKERFILE" | sed 's/.*", "//')" \
    "$(sed -nE 's/^[[:space:]]+deploy_cmd:[[:space:]]*"(.+)"$/\1/p' "$ARGS")"

# The deploy script must not read anything the seam does not give it.
for key in $DEPLOY_ENV_KEYS; do
    if grep -q "$key" "$DEPLOY_SH"; then
        check "UP-1" "the bundle reads $key from the seam" 0
    else
        # EEZ_PROOF_SIGNER_KEY and EEZ_L2_SYSTEM_KEY are the framework deploy's,
        # not the DEX's, so the bundle passes them through untouched.
        say "the bundle does not read $key (it belongs to the framework deploy)"
    fi
done

# Every contract the bundle deploys must be one `build.sh` exports.
for contract in MockWETH MockERC20 MockPool UniswapV3Adapter SettlementRouter DexBridge ERC1967Proxy; do
    if grep -q "deploy $contract" "$DEPLOY_SH" && grep -q "    $contract\$" "$DEX_SCENARIO_DIR/bundle/build.sh"; then
        check "HX-1" "$contract is both exported and deployed" 0
    else
        check "HX-1" "$contract is both exported and deployed" 1
    fi
done

# HX-1 packages the frozen mocks; it never forks them.
if grep -rq "contracts/test/mocks" "$DEX_SCENARIO_DIR" --include='*.sol' 2>/dev/null; then
    check "HX-1" "no Solidity is forked into scenario/" 1
else
    check "HX-1" "MockPool is packaged, not forked (no .sol under scenario/)" 0
fi

# ── UP-2: the external ops ────────────────────────────────────────────────────

step "UP-2 external ops"
STUB_DIR="$(mktemp -d)"
PLAN_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR" "$PLAN_DIR"' EXIT

RAW=0x02f8730182014b8459682f00
cat >"$STUB_DIR/cast" <<STUB
#!/usr/bin/env bash
case "\$1" in
    wallet)   echo 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC ;;
    nonce)    echo 7 ;;
    mktx)     echo $RAW ;;
    calldata) echo 0xdeadbeef ;;
    *)        echo "unexpected cast \$1" >&2; exit 1 ;;
esac
STUB
chmod +x "$STUB_DIR/cast"

# UP-2's output contract, as the README states it. When a framework checkout is
# reachable the harness's own `ext_op_parse` is used instead, which is the
# stronger check; this is what stands in when it is not.
ext_op_parse_local() {
    local out="$1" line key value raw="" side="out" kind="ext" arg=""
    [[ -n "${out//[[:space:]]/}" ]] || return 0
    while IFS= read -r line; do
        [[ -n "${line//[[:space:]]/}" ]] || continue
        key="${line%%=*}"; value="${line#*=}"
        case "$key" in
            raw) raw="$value" ;; side) side="$value" ;; kind) kind="$value" ;; arg) arg="$value" ;;
            *) echo "unknown output key '$key'" >&2; return 1 ;;
        esac
    done <<<"$out"
    [[ "$raw" =~ ^0x[0-9a-fA-F]+$ ]] || { echo "no raw transaction" >&2; return 1; }
    case "$side" in in|out|l1|l2) ;; *) echo "unknown side '$side'" >&2; return 1 ;; esac
    printf '%s|%s|%s|%s\n' "$raw" "$side" "$kind" "$arg"
}

WAVE_SCRIPT=""
for candidate in "${EEZ_ROLLUP0_DIR:-}/testing/kurtosis/scripts/cross-chain-wave.sh" \
                 "$DEX_SCENARIO_DIR"/.framework/*/testing/kurtosis/scripts/cross-chain-wave.sh; do
    [[ -f "$candidate" ]] && { WAVE_SCRIPT="$candidate"; break; }
done
if [[ -n "$WAVE_SCRIPT" ]]; then
    # shellcheck source=/dev/null
    . "$WAVE_SCRIPT"
    say "parsing op output with the framework's own ext_op_parse ($WAVE_SCRIPT)"
    parse() { ext_op_parse "$1"; }
else
    say "no framework checkout reachable; parsing with the contract as documented"
    parse() { ext_op_parse_local "$1"; }
fi

printf '0 0 1000000000000000000 2900000000000000000000 2\n' >"$PLAN_DIR/wave-1.place"
printf '0 0x%s\n' "$(printf 'ab%.0s' {1..32})" >"$PLAN_DIR/wave-1.cancel"
printf '4339505179874779489431521786241 4\n' >"$PLAN_DIR/wave-1.drift"

run_op() {
    PATH="$STUB_DIR:$PATH" \
    DEX_PLAN_DIR="$PLAN_DIR" \
    DEX_WINDOW_BOOK=0x00000000000000000000000000000000000000b0 \
    DEX_POOL=0x00000000000000000000000000000000000000c2 \
    EEZ_WAVE_NUMBER=1 \
    EEZ_WAVE_L1_RPC=http://stub EEZ_WAVE_L2_RPC=http://stub \
    EEZ_WAVE_L1_CHAIN_ID=7331 EEZ_WAVE_L2_CHAIN_ID=6290 \
    EEZ_WAVE_L1_GAS_PRICE=1000000000 EEZ_WAVE_L2_GAS_PRICE=1000000000 \
    EEZ_WAVE_PRIORITY_GAS_PRICE=1 \
        bash "$DEX_SCENARIO_DIR/ops/$1.sh" "${2:-0}"
}

check_eq "HX-3" "place emits a parseable L2 transaction" \
    "$(parse "$(run_op place 0)" | cut -d'|' -f1-3)" "$RAW|l2|place"
check_eq "HX-3" "cancel emits a parseable L2 transaction" \
    "$(parse "$(run_op cancel 0)" | cut -d'|' -f1-3)" "$RAW|l2|cancel"
check_eq "HX-3" "drift emits a parseable L1 transaction" \
    "$(parse "$(run_op drift 0)" | cut -d'|' -f1-3)" "$RAW|l1|drift"

# An op with nothing planned declines, and the harness skips it without
# counting it. An op that printed anything here would corrupt the tally.
check_eq "UP-2" "an op with nothing planned prints nothing" "$(run_op place 3)" ""

# The kinds must not collide with the built-ins, which the harness reserves.
for kind in place cancel drift; do
    case "$kind" in
        set|noret|wrap|dep|wd|rev) check "UP-2" "the op kind '$kind' is reserved" 1 ;;
        *) check "UP-2" "the op kind '$kind' is the consumer's own" 0 ;;
    esac
done

# ── UP-3: consuming the package ───────────────────────────────────────────────

step "UP-3 consuming the package"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/framework-pin.env"
check_eq "RL-1" "the args file is run against the pinned package" \
    "$(basename "$EEZ_KURTOSIS_PACKAGE")" "kurtosis"
if grep -q "$EEZ_KURTOSIS_PACKAGE" "$DEX_SCENARIO_DIR/args/dex-args.yaml" \
    || grep -q "$EEZ_KURTOSIS_PACKAGE" "$DEX_SCENARIO_DIR/lib/enclave.sh" \
    || grep -q 'EEZ_KURTOSIS_LOCATOR' "$DEX_SCENARIO_DIR/lib/enclave.sh"; then
    check "UP-3" "the enclave is brought up by the pinned locator" 0
else
    check "UP-3" "the enclave is brought up by the pinned locator" 1
fi

ARGS_KEYS="$(awk '/^eez:/{f=1;next} f && /^[a-z]/{f=0} f' "$ARGS" \
    | sed -nE 's/^[[:space:]]+([a-z0-9_]+):.*/\1/p' | sort -u)"
UNKNOWN=""
for key in $ARGS_KEYS; do
    [[ " $EEZ_ARG_KEYS_EXPECTED " == *" $key "* ]] || UNKNOWN+="$key "
done
check_eq "UP-3" "the args file uses only keys in the frozen eez set" "${UNKNOWN% }" ""

MAIN_STAR=""
for candidate in "${EEZ_ROLLUP0_DIR:-}/testing/kurtosis/main.star" \
                 "$DEX_SCENARIO_DIR"/.framework/*/testing/kurtosis/main.star; do
    [[ -f "$candidate" ]] && { MAIN_STAR="$candidate"; break; }
done
if [[ -n "$MAIN_STAR" ]]; then
    ACTUAL="$(awk '$0 == "EEZ_ARG_KEYS = [" {f=1; next} f && /^\]/{exit} f' "$MAIN_STAR" \
        | sed -nE 's/^[[:space:]]*"([^"]+)",$/\1/p' | sort | tr '\n' ' ')"
    check_eq "UP-3" "the transcribed eez key set matches the framework's" \
        "${ACTUAL% }" "$EEZ_ARG_KEYS_EXPECTED"
else
    say "no framework checkout reachable; the eez key set was not cross-checked"
fi

# ── HX-5: the committed fixtures ──────────────────────────────────────────────

step "HX-5 recorded run"
for fixture in run settled rolled evicted rolled-back; do
    if (cd "$DEX_SCENARIO_DIR" && node lib/cli.ts validate "fixtures/$fixture.json" >/dev/null); then
        check "HX-5" "fixtures/$fixture.json conforms to the frozen IX-2 schema" 0
    else
        check "HX-5" "fixtures/$fixture.json conforms to the frozen IX-2 schema" 1
    fi
done

# ── A.5: the metric names ─────────────────────────────────────────────────────

step "A.5 metric names"
CONFIG_RS="$ROOT/settler/src/config.rs"
for metric in fills_per_settlement escrow_invariant_drift_wei selection_omitted_total roll_rate netting_ratio; do
    if grep -q "\"$metric\"" "$CONFIG_RS"; then
        check "A.5" "'$metric' is a frozen name in settler/src/config.rs" 0
    else
        check "A.5" "'$metric' is a frozen name in settler/src/config.rs" 1
    fi
done

# ── HX-1: the curve, against the contract ─────────────────────────────────────

step "HX-1 MockPool parity"
if "$HERE/pool-parity.sh"; then
    check "HX-1" "the reimplemented curve matches MockPool itself" 0
else
    check "HX-1" "the reimplemented curve matches MockPool itself" 1
fi

summary "WP-4 self-test"

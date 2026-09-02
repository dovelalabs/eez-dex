#!/usr/bin/env bash
# The enclave scenario — RD-2 WP-4, HX-2 … HX-5.
#
#   scenario/dex-scenario.sh                     A.6's happy path
#   scenario/dex-scenario.sh --matrix            the full failure matrix
#   scenario/dex-scenario.sh --matrix --pr       the rows RL-4 runs on every PR
#   scenario/dex-scenario.sh --matrix --row <id> one row, by name
#   scenario/dex-scenario.sh --soak --slots 200 --seed 1
#   scenario/dex-scenario.sh --record            rewrite the HX-5 fixtures
#   scenario/dex-scenario.sh --self-test         the hermetic half; no enclave
#
# Options: --keep leaves the enclave running, --profile full|genesis selects
# the build profile (RD-2 §1: profile is configuration, never a fork).
#
# The shape of a run is always the same. Bring the network up through the
# framework's Kurtosis package (UP-3), whose deployment step is this
# repository's own bundle (UP-1, HX-1). Deploy the L2 half onto the addresses
# the bundle predicted. Start the observer and the settler. Drive order flow
# through the wave harness's `ext:` ops (UP-2). Then fold what was observed
# into the frozen IX-2 stream and assert A.6 against it.
#
# **Nothing here decides whether an assertion passed.** The shell induces and
# observes; the assertions are `scenario/lib/assert.ts`, recomputing every
# settlement from its inputs. That split is why most of this work package is
# tested by `--self-test`, which CI runs on every pull request, and not only on
# the nights the enclave runs (RL-4).
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

DEX_SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEX_ROOT="$(cd "$DEX_SCENARIO_DIR/.." && pwd)"
DEX_RUN_DIR="${DEX_RUN_DIR:-$DEX_SCENARIO_DIR/.run}"
DEX_PLAN_DIR="${DEX_PLAN_DIR:-$DEX_SCENARIO_DIR/.plan}"
DEX_ARTIFACTS="${DEX_ARTIFACTS:-$DEX_SCENARIO_DIR/bundle/artifacts}"
export DEX_SCENARIO_DIR DEX_ROOT DEX_RUN_DIR DEX_PLAN_DIR DEX_ARTIFACTS

MODE=happy
ROWS=()
SLOTS=200
SEED=1
DEX_KEEP=0
DEX_PROFILE=full

while (( $# )); do
    case "$1" in
        --matrix)     MODE=matrix ;;
        --soak)       MODE=soak ;;
        --record)     MODE=record ;;
        --self-test)  MODE=self-test ;;
        --pr)         ROWS=(pr) ;;
        --row)        ROWS+=("$2"); shift ;;
        --slots)      SLOTS="$2"; shift ;;
        --seed)       SEED="$2"; shift ;;
        --keep)       DEX_KEEP=1 ;;
        --profile)    DEX_PROFILE="$2"; shift ;;
        -h|--help)    sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            echo "dex-scenario: unknown option '$1'" >&2; exit 2 ;;
    esac
    shift
done
export DEX_KEEP DEX_PROFILE

# The hermetic half needs nothing else sourced, and deliberately does not
# require Docker: it is what CI runs on every pull request.
if [[ "$MODE" == "self-test" ]]; then
    exec "$DEX_SCENARIO_DIR/test/self-test.sh"
fi

mkdir -p "$DEX_RUN_DIR"

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/accounts.env"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/enclave.sh"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/deploy-l2.sh"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/settler.sh"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/wave.sh"
# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/matrix.sh"

DEX_OBSERVER_PID=""

cleanup() {
    dex_observer_stop || true
    dex_settler_stop || true
    dex_enclave_down || true
}
trap cleanup EXIT

# --- the observer -------------------------------------------------------------

# dex_observer_start <expect-json> — watch both chains for the whole run.
#
# Every DEX_* binding it reads arrives by sourcing the enclave's
# deployments.env (HX-1), so shellcheck cannot see where they are assigned.
# shellcheck disable=SC2153
dex_observer_start() {
    local expect="$1" config="$DEX_RUN_DIR/observe.json"
    cat >"$config" <<JSON
{
  "l1Rpc": "$DEX_L1_RPC",
  "l2Rpc": "$DEX_L2_RPC",
  "profile": "$DEX_PROFILE",
  "windowBook": "$DEX_WINDOW_BOOK",
  "pool": "$DEX_POOL",
  "assetA": "0x0000000000000000000000000000000000000000",
  "assetB": "$DEX_ASSET_B_L2",
  "rollupManager": "${EEZ_ROLLUP_MANAGER_ADDRESS:-0x0000000000000000000000000000000000000000}",
  "traders": [$(dex_trader_json)],
  "windowSlots": ${DEX_WINDOW_SLOTS:-1},
  "params": {
    "feeMode": "bps",
    "feeBps": "${DEX_FEE_BPS:-1}",
    "feeFixedA": "0",
    "feeFixedB": "0",
    "routeFeeModel": "absorb",
    "routeFeeWei": "0",
    "assetAIsNative": true
  },
  "poolFee": "${DEX_POOL_FEE:-500}",
  "marksFile": "$DEX_RUN_DIR/marks.jsonl",
  "counterfactualGasUsed": "${DEX_COUNTERFACTUAL_GAS:-400000}",
  "counterfactualGasCostWei": "${DEX_COUNTERFACTUAL_GAS_COST:-400000000000000}",
  "expect": $expect
}
JSON
    : >"$DEX_RUN_DIR/marks.jsonl"
    step "watching the run"
    ( cd "$DEX_SCENARIO_DIR" && node lib/cli.ts observe "$config" "$DEX_RUN_DIR" ) \
        >>"$DEX_RUN_DIR/observer.log" 2>&1 &
    DEX_OBSERVER_PID=$!
    sleep 2
    kill -0 "$DEX_OBSERVER_PID" 2>/dev/null || {
        cat "$DEX_RUN_DIR/observer.log" >&2
        die "the observer exited immediately"
    }
}

# dex_observer_stop — SIGTERM, which is how it writes what it saw.
dex_observer_stop() {
    [[ -n "$DEX_OBSERVER_PID" ]] || return 0
    kill -TERM "$DEX_OBSERVER_PID" 2>/dev/null || true
    wait "$DEX_OBSERVER_PID" 2>/dev/null || true
    DEX_OBSERVER_PID=""
}

dex_trader_json() {
    local i out=""
    for (( i = 0; i < DEX_TRADER_COUNT; i++ )); do out+="\"$(dex_trader_address "$i")\","; done
    printf '%s' "${out%,}"
}

# --- bring-up and assertion ---------------------------------------------------

dex_bring_up() {
    step "preflight"
    dex_preflight
    dex_enclave_up
    dex_endpoints
    dex_wait_for_l2 1
    dex_deployments
    dex_deploy_l2
    dex_setup_balances
    dex_settler_build
}

# dex_assert <expect-json> <title> — stop watching, fold, and assert.
dex_assert() {
    local expect="$1" title="$2"
    dex_observer_stop
    step "recording the run"
    ( cd "$DEX_SCENARIO_DIR" && node lib/cli.ts record "$DEX_RUN_DIR/observations.jsonl" "$DEX_RUN_DIR/run.json" ) \
        || die "the run does not conform to the frozen IX-2 schema"

    step "asserting appendix A.6"
    ( cd "$DEX_SCENARIO_DIR" && node lib/cli.ts assert "$DEX_RUN_DIR/run.json" "$DEX_RUN_DIR/readings.json" ) \
        || DEX_FAILURES=$((DEX_FAILURES + 1))
    summary "$title"
}

# --- the modes ----------------------------------------------------------------

# HX-2: eight orders from eight accounts, one cross-layer transaction, eight
# fills. Placement goes through the `place` op, so the happy path exercises the
# same seam the failure matrix does.
run_happy() {
    dex_bring_up
    dex_observer_start '{"mode":"happy","fillsPerSettlement":8,"settlements":1}'
    dex_settler_start

    step "placing eight orders across the open window"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    dex_settle_and_wait || die "the window did not settle"
    # One more slot, so the settlement's L1 receipt is observed before the
    # observer is stopped.
    sleep 14

    dex_assert '{"mode":"happy"}' "A.6 happy path"
}

# HX-3: the failure matrix. `--pr` runs the first rows on every pull request;
# the whole table runs nightly (RL-4).
run_matrix() {
    dex_bring_up
    dex_observer_start '{"mode":"matrix"}'
    dex_settler_start

    local rows=("${ROWS[@]}")
    if [[ "${rows[0]:-}" == "pr" ]]; then rows=("${DEX_MATRIX_PR_ROWS[@]}"); fi
    dex_matrix_run "${rows[@]}"

    dex_assert '{"mode":"matrix"}' "A.6 failure matrix"
}

# HX-4: 200 slots of randomised flow against a random-walk price, settler
# unattended. Reproducible from the seed, which is printed and recorded.
run_soak() {
    dex_bring_up
    dex_observer_start '{"mode":"soak","allOrdersTerminal":true}'
    dex_settler_start

    step "soaking $SLOTS slots from seed $SEED"
    local plan="$DEX_RUN_DIR/soak-plan.json"
    ( cd "$DEX_SCENARIO_DIR" && node lib/cli.ts soak-plan "{\"seed\":\"$SEED\",\"slots\":$SLOTS}" ) >"$plan"

    dex_plan_reset
    local slot count
    count="$(jq -r '.slots | length' "$plan")"
    for (( slot = 0; slot < count; slot++ )); do
        dex_soak_slot "$plan" "$slot"
        dex_wave_run "$((slot + 1))"
    done

    say "the soak placed flow for $count slots; letting the last windows settle"
    sleep $(( (${DEX_EXPIRES_AFTER:-2} + 2) * 12 ))
    dex_assert "{\"mode\":\"soak\",\"allOrdersTerminal\":true,\"seed\":\"$SEED\"}" "HX-4 soak (seed $SEED)"
}

# dex_soak_slot <plan> <slot> — turn one planned slot into op instructions.
dex_soak_slot() {
    local plan="$1" slot="$2" wave=$(( $2 + 1 )) line
    dex_plan_reset
    while IFS=$'\t' read -r kind a b c d; do
        case "$kind" in
            drift)  dex_plan "$wave" drift "$(dex_sqrt_for_scaled "$a")" ;;
            place)  dex_plan "$wave" place "$(dex_trader_index "$a") $b $c $d ${DEX_EXPIRES_AFTER:-2}" ;;
            cancel) line="$(dex_nth_open_order "$a")"; [[ -n "$line" ]] && dex_plan "$wave" cancel "0 $line" ;;
        esac
    done < <(jq -r --argjson slot "$slot" '
        .slots[$slot].actions[]
        | if .kind == "drift" then [.kind, .price, "", "", ""]
          elif .kind == "place" then [.kind, .trader, (if .side == "SELL_A_FOR_B" then "0" else "1" end), .sellAmount, .minBuyAmount]
          else [.kind, (.openIndex|tostring), "", "", ""] end
        | @tsv' "$plan")
}

# dex_sqrt_for_scaled <price-in-millionths> — the soak plan carries prices as
# parts per million so the JSON stays exact.
dex_sqrt_for_scaled() {
    (cd "$DEX_SCENARIO_DIR" && node --input-type=module -e "
      import {sqrtPriceForPrice} from './lib/pool.ts';
      process.stdout.write(sqrtPriceForPrice(${1}n, 1000000n).toString());
    ")
}

# dex_trader_index <address> — the plan names traders by address; the ops take
# an index into accounts.env.
dex_trader_index() {
    local i
    for (( i = 0; i < DEX_TRADER_COUNT; i++ )); do
        [[ "$(dex_trader_address "$i")" == "$1" ]] && { printf '%s' "$i"; return 0; }
    done
    printf '0'
}

# dex_nth_open_order <n> — the id of the nth open order, for a planned cancel.
dex_nth_open_order() {
    cast call "$DEX_WINDOW_BOOK" "openOrderIds()(bytes32[])" --rpc-url "$DEX_L2_RPC" \
        | tr -d '[] ' | tr ',' '\n' | sed -n "$(( ($1 % 64) + 1 ))p"
}

# HX-5: the recorded run, rewritten from a real enclave run rather than from
# the oracle. Everything else is the happy path plus the three failure outcomes
# the fixtures have to cover.
run_record() {
    dex_bring_up
    dex_observer_start '{"mode":"matrix"}'
    dex_settler_start

    dex_matrix_run mid_window_drift poison_eviction raced_pool_move
    dex_observer_stop

    step "rewriting the HX-5 fixtures from this run"
    cp "$DEX_RUN_DIR/observations.jsonl" "$DEX_SCENARIO_DIR/fixtures/observations.jsonl"
    ( cd "$DEX_SCENARIO_DIR" \
        && node lib/cli.ts record fixtures/observations.jsonl fixtures/run.json ) \
        || die "the recorded run does not conform to the frozen IX-2 schema"
    say "fixtures/run.json now describes an enclave run; note it in fixtures/README.md"
    summary "HX-5 recorded run"
}

case "$MODE" in
    happy)  run_happy ;;
    matrix) run_matrix ;;
    soak)   run_soak ;;
    record) run_record ;;
    *)      die "unknown mode '$MODE'" ;;
esac

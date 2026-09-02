#!/usr/bin/env bash
# The window, as one demo — RD-2 §10, FE-5 … FE-9, HX-1 … HX-3.
#
#   scripts/demo.sh                 bring the whole stack up and open the UI
#   scripts/demo.sh --no-open       same, without launching a browser
#   scripts/demo.sh --burst 8       place a burst as soon as the book is live
#
# One command, four processes, in the order each needs the one before it:
#
#   1. the enclave — L1, the zone, the builder and the proof signer, through
#      the framework's Kurtosis package, deploying this repository's own
#      bundle (UP-1, UP-3, HX-1);
#   2. the settler — the four tasks, unattended, against those endpoints (SV-1);
#   3. the indexer — the read-side gateway on :8080, devnet profile, so the
#      director's control proxy exists (IX-1, FE-9);
#   4. the frontend — Vite on :5173 in demo mode, pointed at the gateway.
#
# Ctrl-C stops all four and removes the enclave. `--keep` leaves it running,
# which is what a second `scripts/demo.sh` adopts.
#
# What this demo does *not* wire: the settler serves no socket (it is a
# service, not a gateway — `settler/src/stream.rs`), so the gateway runs with
# its settler upstream absent and says so. Windows, orders, settlements and the
# mirror come from the chains; the price band, evictions and rollbacks are the
# three facts only the settler can state, and the UI shows them as unavailable
# rather than inventing them (IX-1, §7).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

OPEN=1
BURST=0
INDEXER_PORT="${DEX_INDEXER_PORT:-8080}"
FRONTEND_PORT="${DEX_FRONTEND_PORT:-5173}"

while (( $# )); do
    case "$1" in
        --no-open) OPEN=0 ;;
        --burst)   BURST="$2"; shift ;;
        --keep)    export DEX_KEEP=1 ;;
        -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         echo "demo: unknown option '$1'" >&2; exit 2 ;;
    esac
    shift
done

export DEX_SCENARIO_DIR="$ROOT/scenario"
export DEX_ROOT="$ROOT"
export DEX_RUN_DIR="${DEX_RUN_DIR:-$DEX_SCENARIO_DIR/.run}"
export DEX_PLAN_DIR="${DEX_PLAN_DIR:-$DEX_SCENARIO_DIR/.plan}"
export DEX_ARTIFACTS="${DEX_ARTIFACTS:-$DEX_SCENARIO_DIR/bundle/artifacts}"
export DEX_PROFILE=full
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

INDEXER_PID=""
FRONTEND_PID=""

cleanup() {
    [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null
    [[ -n "$INDEXER_PID" ]] && kill "$INDEXER_PID" 2>/dev/null
    dex_settler_stop || true
    dex_enclave_down || true
}
trap cleanup EXIT

# --- 1. the enclave ----------------------------------------------------------

step "preflight"
dex_preflight
dex_enclave_up
dex_endpoints
dex_wait_for_l2 1
dex_deployments
dex_deploy_l2
dex_setup_balances
dex_settler_build

# --- 2. the settler ----------------------------------------------------------

dex_settler_start

# --- 3. the gateway ----------------------------------------------------------

step "starting the indexer on :$INDEXER_PORT"
( cd "$ROOT/indexer" && npm install --no-audit --no-fund --silent >/dev/null 2>&1 || true )
# DEX_L1_RPC, DEX_L2_RPC, DEX_WINDOW_BOOK and DEX_POOL all arrive by sourcing
# the enclave's deployments.env (HX-1), which shellcheck cannot follow.
# shellcheck disable=SC2153
( cd "$ROOT/indexer" && node src/cli.ts \
    --l1 "$DEX_L1_RPC" \
    --l2 "$DEX_L2_RPC" \
    --book "$DEX_WINDOW_BOOK" \
    --pool "${DEX_POOL}" \
    --profile devnet \
    --port "$INDEXER_PORT" ) >>"$DEX_RUN_DIR/indexer.log" 2>&1 &
INDEXER_PID=$!
sleep 3
kill -0 "$INDEXER_PID" 2>/dev/null || {
    tail -20 "$DEX_RUN_DIR/indexer.log" >&2
    die "the indexer exited immediately; see $DEX_RUN_DIR/indexer.log"
}
say "the gateway is serving http://127.0.0.1:$INDEXER_PORT/snapshot (log: $DEX_RUN_DIR/indexer.log)"

# --- 4. the frontend ---------------------------------------------------------

step "starting the frontend on :$FRONTEND_PORT"
( cd "$ROOT/frontend" && npm install --no-audit --no-fund --silent >/dev/null 2>&1 || true )
FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT/?mode=demo&indexer=http://127.0.0.1:$INDEXER_PORT"
# PROFILE=devnet is what compiles the director's panel *in* (FE-9); every
# other profile resolves `@demo-controls` to a module that renders nothing.
( cd "$ROOT/frontend" \
    && PROFILE=devnet \
       VITE_INDEXER_URL="http://127.0.0.1:$INDEXER_PORT" \
       VITE_WINDOW_BOOK="$DEX_WINDOW_BOOK" \
       npm run --silent dev -- --port "$FRONTEND_PORT" --strictPort ) \
    >>"$DEX_RUN_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
sleep 4
kill -0 "$FRONTEND_PID" 2>/dev/null || {
    tail -20 "$DEX_RUN_DIR/frontend.log" >&2
    die "the frontend exited immediately; see $DEX_RUN_DIR/frontend.log"
}

# --- the demo ----------------------------------------------------------------

if (( BURST > 0 )); then
    step "placing an opening burst of $BURST orders"
    "$DEX_SCENARIO_DIR/dex-scenario.sh" --op place --count "$BURST" || say_bad "the burst did not land"
fi

step "the window is up"
cat <<INFO

  trading UI     $FRONTEND_URL
  gateway        http://127.0.0.1:$INDEXER_PORT/snapshot
  L1 / L2 RPC    $DEX_L1_RPC  ·  $DEX_L2_RPC
  WindowBook     $DEX_WINDOW_BOOK
  logs           $DEX_RUN_DIR/{settler,indexer,frontend}.log

  The director's three controls are in the UI (demo mode only, FE-9), and the
  same ops are a command away:

    scenario/dex-scenario.sh --op place --count 8    a burst of orders
    scenario/dex-scenario.sh --op drift --bps 50     move the pool mid-window
    scenario/dex-scenario.sh --op stall --slots 2    stall the builder

  Ctrl-C stops all four and removes the enclave.

INFO

if (( OPEN )); then
    if command -v open >/dev/null 2>&1; then open "$FRONTEND_URL" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$FRONTEND_URL" >/dev/null 2>&1 || true
    fi
fi

wait "$FRONTEND_PID" "$INDEXER_PID"

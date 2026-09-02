#!/usr/bin/env bash
# Running the settler — RD-2 SV-1 … SV-5, A.5.
#
# The settler is a service, not a script the scenario calls: four tasks over one
# state store, stepped once per L2 block. The harness starts it, leaves it
# alone, and asserts on what the chain shows. Two of the failure-matrix rows are
# about stopping and starting it, which is why that is a function here rather
# than something inline.
#
# Every key below is A.5's, spelled as `settler/src/config.rs` freezes it. The
# settler parses its configuration once, loudly, so a typo here fails at
# startup rather than at the first slot boundary.
#
# Sourced, never executed.

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"

DEX_SETTLER_DIR="$(cd "$DEX_SCENARIO_DIR/../settler" && pwd)"
DEX_SETTLER_PID=""

# dex_settler_build — build once, so the first window is not waiting on rustc.
dex_settler_build() {
    step "building the settler"
    (cd "$DEX_SETTLER_DIR" && cargo build --release --quiet) || die "the settler did not build"
}

# dex_settler_env — A.5's configuration, as a list of `KEY=value`.
dex_settler_env() {
    cat <<ENV
L1_RPC=$DEX_L1_RPC
L2_RPC=$DEX_L2_RPC
L2_FRONT=$DEX_L2_FRONT
WINDOW_BOOK=$DEX_WINDOW_BOOK
ROUTER=$DEX_ROUTER
POOL=$DEX_POOL
SETTLER_KEY=$DEX_SETTLER_KEY
MIN_WINDOW_NOTIONAL=${DEX_MIN_WINDOW_NOTIONAL:-0}
FEE_BPS=${DEX_FEE_BPS:-1}
ROUTE_FEE_MODEL=absorb
WINDOW_SLOTS=${DEX_WINDOW_SLOTS:-1}
FLOW_THRESHOLD=${DEX_FLOW_THRESHOLD:-4}
MIRROR_REFRESH_AGE=${DEX_MIRROR_REFRESH_AGE:-5}
DEADLINE_SECONDS=${DEX_DEADLINE_SECONDS:-24}
L1_GAS=${DEX_L1_CALL_GAS:-2000000}
WINDOW_HALT=${DEX_WINDOW_HALT:-3}
MAX_USER_TXS_PER_BUNDLE=${DEX_MAX_USER_TXS_PER_BUNDLE:-3}
DEX_BRIDGE_L1=$DEX_BRIDGE_L1
DEX_BRIDGE_L2=$DEX_BRIDGE_L2
RUST_LOG=${DEX_SETTLER_LOG:-eez_dex_settler=info}
ENV
}

# dex_settler_start — start it, and stop the run if it exits at once.
dex_settler_start() {
    [[ -n "$DEX_SETTLER_PID" ]] && return 0
    local log="$DEX_RUN_DIR/settler.log"
    say "starting the settler (log: $log)"
    # shellcheck disable=SC2046  # the env list is deliberately word-split
    env $(dex_settler_env | tr '\n' ' ') "$DEX_SETTLER_DIR/target/release/eez-dex-settler" \
        >>"$log" 2>&1 &
    DEX_SETTLER_PID=$!
    sleep 3
    kill -0 "$DEX_SETTLER_PID" 2>/dev/null || {
        tail -20 "$log" >&2
        die "the settler exited immediately; see $log"
    }
    say "the settler is running as pid $DEX_SETTLER_PID"
}

# dex_settler_stop — SV-3's "one settlement in flight" survives a stop only if
# the stop is clean, so the row that restarts it uses this rather than a kill.
dex_settler_stop() {
    [[ -n "$DEX_SETTLER_PID" ]] || return 0
    say "stopping the settler (pid $DEX_SETTLER_PID)"
    kill "$DEX_SETTLER_PID" 2>/dev/null || true
    wait "$DEX_SETTLER_PID" 2>/dev/null || true
    DEX_SETTLER_PID=""
}

# dex_settler_restart — the failure-matrix row: stop between selection and
# submission, start again, and exactly one settlement must reach the window.
dex_settler_restart() {
    dex_settler_stop
    dex_settler_start
}

# dex_settler_halted — SV-4's window-halt, as the settler reports it.
dex_settler_halted() {
    grep -q "halted on the unposted-window threshold" "$DEX_RUN_DIR/settler.log" 2>/dev/null
}

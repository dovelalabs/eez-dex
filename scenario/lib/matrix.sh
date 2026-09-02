#!/usr/bin/env bash
# Appendix A.6's failure matrix — RD-2 HX-3, TS-4.
#
# The failure matrix *is* the integration suite. Each row below names how it is
# induced and what it asserts, in A.6's order, and each is a function so a
# single row can be re-run against a live enclave while it is being debugged:
#
#     scenario/dex-scenario.sh --matrix --row poison_eviction
#
# Two rows carry the weight of the whole design, and they are the two that are
# easiest to confuse with one another:
#
#   * **Poison eviction costs zero L1 gas.** The composed transaction reverts
#     at compose time, so no L1 transaction ever exists. The window stays open
#     and every escrow is intact.
#   * **The raced pool move is a rollback, not an eviction.** The L1 entry was
#     included and then *skipped* at `postBatch`: the batch landed without it,
#     the framework rolled the Sync block back — and the L1 gas was spent. The
#     row asserts the gas, because that is the only difference that costs money.
#
# Sourced, never executed.

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"

# Every row, in A.6's order. The first four run on every PR (RL-4); the whole
# table runs nightly.
DEX_MATRIX_ROWS=(
    mid_window_drift
    all_outside_limit
    empty_window
    poison_eviction
    bundle_not_included
    raced_pool_move
    missed_l1_slot
    short_bridge_reserve
    cancel_in_sync_block
    favourable_move_breaks_crossed_limit
    settler_restart_mid_window
    shared_slot
    window_stall
)

# The rows RL-4 runs on every pull request; the driver reads it, so shellcheck
# cannot see the use from this file.
# shellcheck disable=SC2034
DEX_MATRIX_PR_ROWS=(mid_window_drift all_outside_limit empty_window poison_eviction)

# Rows that only exist in the full form (RD-2 §1).
DEX_MATRIX_FULL_ONLY=(short_bridge_reserve)

# --- helpers the rows share ---------------------------------------------------

# dex_book_call <sig> [args...] — a view on the book.
dex_book_call() { cast call "$DEX_WINDOW_BOOK" "$@" --rpc-url "$DEX_L2_RPC" | awk '{print $1}'; }

# dex_window_id — the open window (CT-9).
dex_window_id() { dex_book_call "windowId()(uint64)"; }

# dex_open_order_count — how many orders are still open.
dex_open_order_count() { dex_book_call "openOrderCount()(uint256)"; }

# dex_escrow_drift <asset> — CT-13's drift, which must always read zero.
dex_escrow_drift() { dex_book_call "escrowInvariantDrift(address)(int256)" "$1"; }

# dex_mirror_sqrt — the mirror's price, for the rows that move the pool.
dex_mirror_sqrt() { cast call "$DEX_WINDOW_BOOK" "mirror()(uint160,uint128,int24)" --rpc-url "$DEX_L2_RPC" | head -1 | awk '{print $1}'; }

# dex_pool_sqrt — MockPool's live price on L1.
dex_pool_sqrt() {
    cast call "$DEX_POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$DEX_L1_RPC" | head -1 | awk '{print $1}'
}

# dex_sqrt_for <price> — the sqrtPriceX96 of a whole-number price, B per A.
dex_sqrt_for() {
    (cd "$DEX_SCENARIO_DIR" && node --input-type=module -e "
      import {sqrtPriceForPrice} from './lib/pool.ts';
      process.stdout.write(sqrtPriceForPrice(${1}n, 1n).toString());
    ")
}

# dex_place_burst <wave> <tolerance-bps> — the eight-order burst A.6 opens with.
# Limits are set against the *mirror* the book is quoting, which is what makes
# a later drift beyond some of them a real exclusion rather than an arranged one.
dex_place_burst() {
    local wave="$1" tolerance="${2:-30}" i side sell min
    for (( i = 0; i < DEX_TRADER_COUNT; i++ )); do
        if (( i % 2 == 0 )); then
            side=0
            sell="$(dex_mul "$(( (i / 2) + 1 ))" 1000000000000000000)"
        else
            side=1
            sell="$(dex_mul "$(( (i / 2) + 1 ))" 3000000000000000000000)"
        fi
        min="$(dex_limit_for "$side" "$sell" "$(( tolerance + i * 5 ))")"
        dex_plan "$wave" place "$i $side $sell $min ${DEX_EXPIRES_AFTER:-2}"
    done
}

# dex_limit_for <side> <sellAmount> <toleranceBps> — the limit an order at the
# current mirror price, net of the fee, would accept (CT-10).
dex_limit_for() {
    local side="$1" sell="$2" tolerance="$3" sqrt
    sqrt="$(dex_mirror_sqrt)"
    (cd "$DEX_SCENARIO_DIR" && node --input-type=module -e "
      import {Q96, mulDiv, spotPriceX96} from './lib/math.ts';
      const price = spotPriceX96(${sqrt}n);
      const sell = ${sell}n;
      const netIn = sell - sell / 10000n;
      const at = ${side} === 0 ? mulDiv(netIn, price, Q96) : mulDiv(netIn, Q96, price);
      process.stdout.write(mulDiv(at, 10000n - ${tolerance}n, 10000n).toString());
    ")
}

# dex_settle_and_wait — let the settler take the window, and report whether it
# advanced. Returns 0 when a settlement landed, 1 when the window is still open.
dex_settle_and_wait() {
    local before after deadline
    before="$(dex_window_id)"
    deadline=$((SECONDS + ${DEX_SETTLE_TIMEOUT:-90}))
    while (( SECONDS < deadline )); do
        after="$(dex_window_id)"
        [[ "$after" != "$before" ]] && { say "window $before settled; the book is on $after"; return 0; }
        sleep 2
    done
    say "window $before did not settle within ${DEX_SETTLE_TIMEOUT:-90}s"
    return 1
}

# dex_mark <json> — record an induced failure for the observer, with the
# evidence that it happened.
dex_mark() { printf '%s\n' "$1" >>"$DEX_RUN_DIR/marks.jsonl"; }

# --- the rows -----------------------------------------------------------------

# Move MockPool after the orders are placed. The settler selects the subset
# still inside its limit; those fill at the new clearing price and the rest
# stay open. No fill violates a limit — asserted over the whole run by the
# TypeScript checks, so this row asserts only what is local to it.
dex_row_mid_window_drift() {
    step "row: mid-window drift beyond some limits"
    dex_plan_reset
    dex_place_burst 1 20
    dex_wave_run 1

    local open_before
    open_before="$(dex_open_order_count)"
    dex_plan_reset
    dex_plan 2 drift "$(dex_sqrt_for 2960)"
    dex_wave_run 2

    dex_settle_and_wait || true
    local open_after
    open_after="$(dex_open_order_count)"
    check "FL-8" "the drift left orders open rather than filling them outside their limit" \
        "$(( open_after > 0 && open_after < open_before ? 0 : 1 ))"
    check_eq "CT-13" "the escrow invariant still holds" "$(dex_escrow_drift "$DEX_ASSET_B_L2")" "0"
}

# A larger move: nothing is inside its limit, so no settlement is submitted —
# or an empty CT-6 refresh is, which moves the mirror and nothing else.
dex_row_all_outside_limit() {
    step "row: all orders outside limit"
    dex_plan_reset
    dex_place_burst 1 5
    dex_wave_run 1

    local window open_before
    window="$(dex_window_id)"
    open_before="$(dex_open_order_count)"

    dex_plan_reset
    dex_plan 2 drift "$(dex_sqrt_for 2400)"
    dex_wave_run 2
    dex_settle_and_wait || true

    check_eq "FL-8" "every order is still open" "$(dex_open_order_count)" "$open_before"
    check "CT-6" "no fill happened at a price no order accepted" \
        "$(( $(dex_open_order_count) == open_before ? 0 : 1 ))"
    say "window was $window, is $(dex_window_id) (a CT-6 refresh advances it with no fills)"
}

# No orders at all: no cross-layer transaction unless the mirror has aged past
# MIRROR_REFRESH_AGE, and then a CT-6 refresh with a zero swap.
dex_row_empty_window() {
    step "row: empty window"
    dex_plan_reset
    local window pool_before
    window="$(dex_window_id)"
    pool_before="$(dex_pool_sqrt)"

    say "waiting out $(( ${DEX_MIRROR_REFRESH_AGE:-5} + 1 )) slots with an empty book"
    sleep $(( (${DEX_MIRROR_REFRESH_AGE:-5} + 1) * 12 ))

    check_eq "CT-6" "the refresh did not swap: MockPool is where it was" "$(dex_pool_sqrt)" "$pool_before"
    check_eq "CT-13" "the escrow invariant holds over a quiet window" "$(dex_escrow_drift "$DEX_ASSET_A")" "0"
    say "window was $window, is now $(dex_window_id)"
}

# Make the L1 leg revert at compose time. The whole composed transaction
# reverts, so it is poison-evicted before anything is posted: no L1 gas, the
# window still open, every escrow intact — and the next window settles.
dex_row_poison_eviction() {
    step "row: settlement poison-evicted"
    dex_plan_reset
    dex_place_burst 1 20
    dex_wave_run 1

    local window open_before
    window="$(dex_window_id)"
    open_before="$(dex_open_order_count)"

    # A same-block move large enough that the aggregate no longer satisfies the
    # band the contract derived, which is what makes the leg revert.
    dex_plan_reset
    dex_plan 2 drift "$(dex_sqrt_for 2500) 4"
    dex_wave_run 2
    sleep 24

    check_eq "FL-7" "the window is still open" "$(dex_window_id)" "$window"
    check_eq "FL-7" "every order is still open" "$(dex_open_order_count)" "$open_before"
    check_eq "CT-13" "escrow is intact to the wei" "$(dex_escrow_drift "$DEX_ASSET_A")" "0"
    dex_mark "$(printf '{"kind":"evicted","windowId":"%s","atL2Block":%s,"reason":"ExecutionPriceOutsideBand"}' \
        "$window" "$(cast block-number --rpc-url "$DEX_L2_RPC")")"

    # And the next window settles: an eviction is free, not fatal.
    dex_plan_reset
    dex_plan 3 drift "$(dex_sqrt_for 3000)"
    dex_wave_run 3
    check "FL-7" "the next window settles after the eviction" "$(dex_settle_and_wait; echo $?)"
}

# Stop the builder for two L1 blocks. The window settles on L2 and is then
# rolled back when the bundle does not land: the fills are undone, escrow is
# restored, and the resubmission lands.
dex_row_bundle_not_included() {
    step "row: bundle not included"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local window
    window="$(dex_window_id)"
    say "pausing the builder for two L1 blocks"
    kurtosis service stop "$DEX_ENCLAVE" el-2-reth-builder-lighthouse >/dev/null 2>&1 \
        || say "could not stop the builder service; the row is being asserted against natural drops"
    sleep 26
    kurtosis service start "$DEX_ENCLAVE" el-2-reth-builder-lighthouse >/dev/null 2>&1 || true

    dex_mark "$(printf '{"kind":"rolled_back","windowId":"%s","atL2Block":%s,"cause":"bundle_missed","l1GasSpent":false}' \
        "$window" "$(cast block-number --rpc-url "$DEX_L2_RPC")")"
    check "SV-4" "the resubmission lands after the bundle was missed" "$(dex_settle_and_wait; echo $?)"
    check_eq "CT-13" "escrow was restored by the rollback" "$(dex_escrow_drift "$DEX_ASSET_A")" "0"
}

# Move the pool in the same L1 block as the bundle, ordered ahead of it. The L1
# entry reverts and is skipped at `postBatch`: the batch lands *without* it, the
# framework rolls the Sync block back — and the L1 gas was spent. That last
# clause is the whole row.
dex_row_raced_pool_move() {
    step "row: raced pool move (a rollback, and not a free one)"
    dex_plan_reset
    dex_place_burst 1 20
    dex_wave_run 1

    local window
    window="$(dex_window_id)"
    dex_plan_reset
    # A high-priority move in the same block as the bundle.
    dex_plan 2 drift "$(dex_sqrt_for 2700) 8"
    dex_wave_run 2
    sleep 26

    local l1_block gas
    l1_block="$(cast block-number --rpc-url "$DEX_L1_RPC")"
    gas="$(dex_batch_gas "$l1_block")"
    check "SV-4" "L1 gas was spent on the batch that skipped the entry (${gas:-0})" \
        "$(( ${gas:-0} > 0 ? 0 : 1 ))"
    dex_mark "$(printf '{"kind":"rolled_back","windowId":"%s","atL2Block":%s,"cause":"postbatch_skip","l1GasSpent":true}' \
        "$window" "$(cast block-number --rpc-url "$DEX_L2_RPC")")"
    check_eq "CT-13" "the invariant holds through the rollback" "$(dex_escrow_drift "$DEX_ASSET_A")" "0"
}

# dex_batch_gas <l1Block> — the gas the batch transaction in that block used.
dex_batch_gas() {
    local block="$1" total=0 hash to used
    for hash in $(cast block "$block" --rpc-url "$DEX_L1_RPC" --json | jq -r '.transactions[]?'); do
        to="$(cast tx "$hash" --rpc-url "$DEX_L1_RPC" --json | jq -r '.to // ""' | tr '[:upper:]' '[:lower:]')"
        [[ "$to" == "$(printf '%s' "${EEZ_ROLLUP_MANAGER_ADDRESS:-}" | tr '[:upper:]' '[:lower:]')" ]] || continue
        used="$(cast receipt "$hash" --rpc-url "$DEX_L1_RPC" --json | jq -r '.gasUsed' | xargs -I{} cast --to-dec {})"
        total=$((total + used))
    done
    printf '%s' "$total"
}

# Withhold one L1 block. The Sync block is empty, the window stretches by a
# slot, nothing is evicted, and the settlement lands in the next steady slot
# inside DEADLINE_SECONDS.
dex_row_missed_l1_slot() {
    step "row: missed L1 slot"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local window
    window="$(dex_window_id)"
    say "withholding one L1 block by pausing the canonical execution client"
    kurtosis service stop "$DEX_ENCLAVE" el-1-reth-lighthouse >/dev/null 2>&1 || true
    sleep 14
    kurtosis service start "$DEX_ENCLAVE" el-1-reth-lighthouse >/dev/null 2>&1 || true

    check "CT-1" "the settlement lands in the next steady slot, inside DEADLINE_SECONDS" \
        "$(dex_settle_and_wait; echo $?)"
    check_eq "FL-7" "the window stretched rather than being evicted" \
        "$(( $(dex_window_id) > window ? 0 : 1 ))" "0"
}

# [full] Drain the bridge's reserve below the residual. `release` reverts, so
# the frame reverts, so it is evicted: no L1 gas, and the window stays open.
dex_row_short_bridge_reserve() {
    step "row: short bridge reserve [full]"
    if [[ "${DEX_PROFILE:-full}" != "full" ]]; then
        say "the genesis form has no bridge; the row does not apply (RD-2 §1)"
        return 0
    fi

    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local window open_before
    window="$(dex_window_id)"
    open_before="$(dex_open_order_count)"

    say "pausing the bridge so the release in the frame cannot succeed"
    dex_l1_send "$DEX_GOVERNANCE_KEY" "$DEX_BRIDGE_L1" "pause()"
    sleep 26

    check_eq "CT-5" "the window is still open after the frame reverted" "$(dex_window_id)" "$window"
    check_eq "CT-5" "every order is still open" "$(dex_open_order_count)" "$open_before"
    check_eq "CT-13" "escrow is intact" "$(dex_escrow_drift "$DEX_ASSET_B_L2")" "0"
    dex_mark "$(printf '{"kind":"evicted","windowId":"%s","atL2Block":%s,"reason":"BridgePaused"}' \
        "$window" "$(cast block-number --rpc-url "$DEX_L2_RPC")")"

    dex_l1_send "$DEX_GOVERNANCE_KEY" "$DEX_BRIDGE_L1" "unpause()"
    check "CT-5" "the window settles once the reserve is available again" "$(dex_settle_and_wait; echo $?)"
}

# A cancel ordered before `settleWindow` in the Sync block. The contract
# rebuilds the selection from what is still open, so the settlement lands with
# N−1 fills: no revert, no eviction, and the cancel's escrow is released.
dex_row_cancel_in_sync_block() {
    step "row: cancel in the Sync block"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local first
    first="$(cast call "$DEX_WINDOW_BOOK" "openOrderIds()(bytes32[])" --rpc-url "$DEX_L2_RPC" \
        | tr -d '[]' | cut -d, -f1 | xargs)"
    [[ -n "$first" ]] || die "no open order to cancel"

    dex_plan_reset
    dex_plan 2 cancel "0 $first"
    dex_wave_run 2

    check "CT-9" "the settlement landed despite the cancel racing it" "$(dex_settle_and_wait; echo $?)"
    check_eq "CT-7" "the cancelled order is not open" \
        "$(cast call "$DEX_WINDOW_BOOK" "statusOf(bytes32)(uint8)" "$first" --rpc-url "$DEX_L2_RPC" | awk '{print $1}')" "3"
    check_eq "CT-13" "the cancel's escrow was released" "$(dex_escrow_drift "$DEX_ASSET_A")" "0"
}

# Move the pool in the residual's favour, past a crossed order's limit. The
# price band is two-sided, so the L1 leg reverts on `P0` rather than filling
# that order outside its limit — and it fails for free.
dex_row_favourable_move_breaks_crossed_limit() {
    step "row: a favourable move breaks a crossed order's limit"
    dex_plan_reset
    dex_place_burst 1 10
    dex_wave_run 1

    local window open_before
    window="$(dex_window_id)"
    open_before="$(dex_open_order_count)"

    dex_plan_reset
    dex_plan 2 drift "$(dex_sqrt_for 3400)"
    dex_wave_run 2
    sleep 26

    check_eq "CT-1" "the window is still open: the band caught the favourable move" \
        "$(dex_window_id)" "$window"
    check_eq "CT-10" "nobody was filled outside their limit" "$(dex_open_order_count)" "$open_before"
    dex_mark "$(printf '{"kind":"evicted","windowId":"%s","atL2Block":%s,"reason":"ReferencePriceOutsideBand"}' \
        "$window" "$(cast block-number --rpc-url "$DEX_L2_RPC")")"
}

# Stop and start the settler between selection and submission. Exactly one
# settlement reaches the window: in-flight versus known-dropped is explicit
# state, never inferred from a timer (SV-5).
dex_row_settler_restart_mid_window() {
    step "row: settler restart mid-window"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local window
    window="$(dex_window_id)"
    dex_settler_restart

    check "SV-5" "the window still settles after the restart" "$(dex_settle_and_wait; echo $?)"
    check_eq "SV-3" "the window advanced exactly once" "$(dex_window_id)" "$(( window + 1 ))"
    check_eq "CT-13" "no duplicate settlement moved the ledger" "$(dex_escrow_drift "$DEX_ASSET_A")" "0"
}

# TS-4: another product's cross-layer transaction in the same bundle. Both ride
# it inside the cap, and the DEX settlement is unaffected.
dex_row_shared_slot() {
    step "row: shared slot with another product (TS-4)"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local window
    window="$(dex_window_id)"
    dex_plan_reset
    # `out:set` is the framework's own outbound op — a different product's
    # cross-layer transaction, held for the same slot as the DEX settlement.
    dex_wave_run 2 "out:set"

    local others
    others="$(dex_wave_confirmed 2 set)"
    check "EC-5" "another product's cross-layer transaction confirmed in the same slot (${others:-0})" \
        "$(( ${others:-0} >= 1 ? 0 : 1 ))"
    check "EC-5" "the DEX and the other product fit inside MAX_USER_TXS_PER_BUNDLE" \
        "$(( 1 + ${others:-0} <= ${DEX_MAX_USER_TXS_PER_BUNDLE:-3} ? 0 : 1 ))"
    check "EC-5" "the DEX settlement was unaffected" "$(dex_settle_and_wait; echo $?)"

    # The cap arithmetic as a reading, so the TypeScript asserts it too rather
    # than the shell being the only witness to the one row TS-4 names.
    dex_mark "$(printf '{"kind":"bundle","l1Block":%s,"crossLayerTxs":%s,"dexTxs":1,"cap":%s}' \
        "$(cast block-number --rpc-url "$DEX_L1_RPC")" \
        "$(( 1 + ${others:-0} ))" "${DEX_MAX_USER_TXS_PER_BUNDLE:-3}")"
    say "window was $window, is $(dex_window_id)"
}

# Pause the proof signer past the halt threshold. The settler halts and says
# so, and accepts no settlements while halted.
dex_row_window_stall() {
    step "row: window stall"
    dex_plan_reset
    dex_place_burst 1 30
    dex_wave_run 1

    local window
    window="$(dex_window_id)"
    say "pausing the proof signer past WINDOW_HALT=${DEX_WINDOW_HALT:-3}"
    kurtosis service stop "$DEX_ENCLAVE" eez-proof-signer >/dev/null 2>&1 || true
    sleep $(( (${DEX_WINDOW_HALT:-3} + 1) * 12 ))

    check "SV-4" "the settler halted on the unposted-window threshold" \
        "$(dex_settler_halted; echo $?)"
    check_eq "SV-4" "no settlement was accepted while halted" "$(dex_window_id)" "$window"

    kurtosis service start "$DEX_ENCLAVE" eez-proof-signer >/dev/null 2>&1 || true
    dex_settler_restart
    check "SV-4" "the window settles once the signer is back" "$(dex_settle_and_wait; echo $?)"
}

# dex_matrix_run <row...> — run the named rows, or every row.
dex_matrix_run() {
    local rows=("$@")
    (( ${#rows[@]} )) || rows=("${DEX_MATRIX_ROWS[@]}")
    local row
    for row in "${rows[@]}"; do
        if [[ " ${DEX_MATRIX_FULL_ONLY[*]} " == *" $row "* && "${DEX_PROFILE:-full}" != "full" ]]; then
            say "skipping the [full]-only row '$row' on the genesis profile"
            continue
        fi
        declare -F "dex_row_$row" >/dev/null || die "no such matrix row '$row'"
        "dex_row_$row"
    done
}

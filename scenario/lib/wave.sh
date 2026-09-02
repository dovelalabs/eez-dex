#!/usr/bin/env bash
# Driving order flow through the UP-2 wave harness — RD-2 HX-3.
#
# The framework's `cross-chain-wave.sh` dispatches over `EEZ_WAVE_OPS`, and an
# `ext:` op is a command in *this* repository that prints a raw signed
# transaction. Going through the harness rather than sending with `cast`
# directly is the point: external ops are counted, waited for and reported
# exactly like the built-ins, and the harness's hit-rate and bundle-drop
# accounting covers them — which is what makes the shared-slot row (TS-4) an
# arithmetic check rather than an anecdote.
#
# The harness lives in the framework repository, and a remote Kurtosis run does
# not bring its scripts. `dex_wave_script` resolves one from `EEZ_ROLLUP0_DIR`
# if a checkout is at hand, and otherwise clones the pinned revision once into
# a cache — the same revision `FRAMEWORK_COMMIT` pins the package to, so the
# harness and the enclave are never a commit apart.
#
# Sourced, never executed.

# shellcheck source=/dev/null
. "$DEX_SCENARIO_DIR/lib/log.sh"

DEX_FRAMEWORK_CACHE="${DEX_FRAMEWORK_CACHE:-$DEX_SCENARIO_DIR/.framework}"

# dex_wave_script — the path to `cross-chain-wave.sh`, cloning if it must.
dex_wave_script() {
    local checkout="${EEZ_ROLLUP0_DIR:-}"
    if [[ -n "$checkout" && -f "$checkout/testing/kurtosis/scripts/cross-chain-wave.sh" ]]; then
        printf '%s' "$checkout/testing/kurtosis/scripts/cross-chain-wave.sh"
        return 0
    fi

    local target="$DEX_FRAMEWORK_CACHE/$EEZ_ROLLUP0_COMMIT"
    if [[ ! -f "$target/testing/kurtosis/scripts/cross-chain-wave.sh" ]]; then
        say "fetching the wave harness at $EEZ_ROLLUP0_COMMIT" >&2
        rm -rf "$target"
        mkdir -p "$target"
        git init --quiet "$target"
        git -C "$target" remote add origin "$EEZ_ROLLUP0_REPO"
        git -C "$target" fetch --quiet --depth 1 origin "$EEZ_ROLLUP0_COMMIT" \
            || die "could not fetch eez-rollup0 at $EEZ_ROLLUP0_COMMIT; set EEZ_ROLLUP0_DIR to a checkout"
        git -C "$target" checkout --quiet FETCH_HEAD
    fi
    printf '%s' "$target/testing/kurtosis/scripts/cross-chain-wave.sh"
}

# dex_plan_reset — start a fresh plan. The ops read only from here, so the
# whole of a run's order flow is one directory a failure can be read out of.
dex_plan_reset() {
    rm -rf "$DEX_PLAN_DIR"
    mkdir -p "$DEX_PLAN_DIR"
}

# dex_plan <wave> <kind> <line...> — append one op instruction.
dex_plan() {
    local wave="$1" kind="$2"; shift 2
    printf '%s\n' "$*" >>"$DEX_PLAN_DIR/wave-$wave.$kind"
}

# dex_plan_slots <wave> <kind> — how many lines that op has this wave, which is
# how many instances of it the op list needs.
dex_plan_slots() {
    local file="$DEX_PLAN_DIR/wave-$1.$2"
    [[ -f "$file" ]] || { printf '0'; return 0; }
    grep -cvE '^[[:space:]]*($|#)' "$file" | tr -d ' '
}

# dex_ops_for <wave> [extra-ops...] — the EEZ_WAVE_OPS list for one wave: one
# `ext:` instance per planned line, plus anything the caller adds (the
# shared-slot row adds a built-in op belonging to another product).
dex_ops_for() {
    local wave="$1"; shift
    local ops=() kind slots i
    for kind in drift place cancel; do
        slots="$(dex_plan_slots "$wave" "$kind")"
        for (( i = 0; i < slots; i++ )); do
            ops+=("ext:$DEX_SCENARIO_DIR/ops/$kind.sh $i")
        done
    done
    for extra in "$@"; do ops+=("$extra"); done
    local IFS=,
    printf '%s' "${ops[*]}"
}

# dex_wave_run <wave> [extra-ops...] — fire one wave through the harness.
#
# The harness numbers its own waves from 1, so a run of one wave always looks
# for `wave-1.*`; the caller's wave number is mapped onto that by copying the
# plan into place. Simpler than teaching the ops two numbering schemes, and it
# keeps each wave's flow in its own file.
dex_wave_run() {
    local wave="$1"; shift
    local ops
    ops="$(dex_ops_for "$wave" "$@")"
    if [[ -z "$ops" ]]; then
        say "wave $wave has nothing planned"
        return 0
    fi

    local kind
    for kind in drift place cancel; do
        rm -f "$DEX_PLAN_DIR/wave-1.$kind"
        [[ -f "$DEX_PLAN_DIR/wave-$wave.$kind" && "$wave" != "1" ]] \
            && cp "$DEX_PLAN_DIR/wave-$wave.$kind" "$DEX_PLAN_DIR/wave-1.$kind"
    done

    say "wave $wave: $ops"
    # The harness's own output is kept: its per-kind confirmed tally is what
    # the shared-slot row (TS-4) reads its cap arithmetic out of.
    KURTOSIS_ENCLAVE="$DEX_ENCLAVE" \
    DEX_PLAN_DIR="$DEX_PLAN_DIR" \
    DEX_NATIVE_SIDE="${DEX_NATIVE_SIDE:-0}" \
    DEX_DRIFTER_KEY="${DEX_DRIFTER_KEY:-$DEX_GOVERNANCE_KEY}" \
    EEZ_WAVE_OPS="$ops" \
    EEZ_WAVE_COUNT=1 \
        bash "$(dex_wave_script)" 2>&1 | tee "$DEX_RUN_DIR/wave-$wave.log"
    local status="${PIPESTATUS[0]}"
    [[ "$status" == "0" ]] || die "the wave harness failed on wave $wave"
}

# dex_wave_confirmed <wave> <kind> — how many of one op kind the harness
# reported confirmed. External ops appear here under their own kind, which is
# the accounting UP-2 promises is unchanged by them.
dex_wave_confirmed() {
    sed -nE "s/.*ops confirmed by kind:.*[^a-z]$2=([0-9]+).*/\1/p" "$DEX_RUN_DIR/wave-$1.log" | tail -1
}

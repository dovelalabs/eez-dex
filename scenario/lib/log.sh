#!/usr/bin/env bash
# Output the scenario is read through — RD-2 RL-4.
#
# A failure matrix row that fails at 3 a.m. is read in a CI log by someone who
# was not there, so every line says which of the run's phases it came from and
# every failure names the requirement it broke. Nothing here is decorative.
#
# Sourced, never executed.

DEX_STEP=""
DEX_FAILURES=0

say()      { printf '     %s\n' "$*"; }
say_ok()   { printf '  ok %s\n' "$*"; }
say_bad()  { printf '  XX %s\n' "$*" >&2; }

# step <title> — a phase of the run.
step() {
    DEX_STEP="$*"
    printf '\n==> %s\n' "$DEX_STEP"
}

# die <message...> — stop, naming the phase that could not continue.
die() {
    printf '\nscenario: %s\n' "$*" >&2
    [[ -n "$DEX_STEP" ]] && printf 'scenario: (during: %s)\n' "$DEX_STEP" >&2
    exit 1
}

# check <requirement> <what> <condition-exit-status>
# The scenario's own assertion primitive, for the handful of things the shell
# checks directly; everything that needs arithmetic is asserted in TypeScript.
check() {
    local requirement="$1" what="$2" status="$3"
    if [[ "$status" == "0" ]]; then
        printf '  PASS  %-6s %s\n' "$requirement" "$what"
    else
        printf '  FAIL  %-6s %s\n' "$requirement" "$what" >&2
        DEX_FAILURES=$((DEX_FAILURES + 1))
    fi
}

# check_eq <requirement> <what> <actual> <expected>
check_eq() {
    if [[ "$3" == "$4" ]]; then
        check "$1" "$2" 0
    else
        check "$1" "$2 (expected '$4', got '$3')" 1
    fi
}

# summary <title> — the last line, and the exit status the caller returns.
summary() {
    if (( DEX_FAILURES == 0 )); then
        printf '\n==> %s: PASSED\n' "$1"
        return 0
    fi
    printf '\n==> %s: FAILED (%d checks)\n' "$1" "$DEX_FAILURES" >&2
    return 1
}

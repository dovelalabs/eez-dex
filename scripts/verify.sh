#!/usr/bin/env bash
# RD-2 §10, as one command — the acceptance criteria, each with its evidence.
#
#   scripts/verify.sh                     every row this machine can decide
#   scripts/verify.sh --fast              skip `make check` (run it yourself)
#   scripts/verify.sh --seed 2 --slots 50 a different soak
#   scripts/verify.sh --enclave           include the rows that need Kurtosis
#
# Three verdicts, and the third is not a soft pass:
#
#   PASS  the criterion was asserted here, and the evidence is printed beside it
#   FAIL  it was asserted and did not hold
#   SKIP  it could not be asserted here — what is missing is named, and the
#         run's verdict is INCOMPLETE rather than green
#
# Every row also carries the **tier** its evidence came from, because the same
# claim is worth different amounts at different tiers:
#
#   unit       the package suites: contracts, settler, indexer, frontend
#   frame      phase 6's integration suite — both chains, the real proxy
#   recorded   the committed HX-5 runs (HX-5), which a devnet run produced
#   simulated  the seeded soak against the settlement oracle, no chain
#   fork       real Uniswap v3 at a pinned block (TS-2)
#   enclave    Kurtosis: the composer, the bundle, four processes at once
#
# Exit status: 0 all rows passed · 1 a row failed · 2 no row failed but some
# were skipped.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

FAST=0
ENCLAVE=0
SEED=1
SLOTS=200

while (( $# )); do
    case "$1" in
        --fast)     FAST=1 ;;
        --enclave)  ENCLAVE=1 ;;
        --seed)     SEED="$2"; shift ;;
        --slots)    SLOTS="$2"; shift ;;
        -h|--help)  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          echo "verify: unknown option '$1'" >&2; exit 2 ;;
    esac
    shift
done

V=""
PASSED=0
FAILED=0
SKIPPED=0
declare -a NOT_PASSED=()

if [[ -t 1 ]]; then
    C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_SKIP=$'\033[33m'; C_HEAD=$'\033[1m'; C_OFF=$'\033[0m'
else
    C_PASS=""; C_FAIL=""; C_SKIP=""; C_HEAD=""; C_OFF=""
fi

section() { printf '\n%s== %s%s\n' "$C_HEAD" "$1" "$C_OFF"; }

# row <PASS|FAIL|SKIP> <tier> <id> <statement>
row() {
    local verdict="$1" tier="$2" id="$3" statement="$4" colour
    case "$verdict" in
        PASS) colour="$C_PASS"; PASSED=$((PASSED + 1)) ;;
        FAIL) colour="$C_FAIL"; FAILED=$((FAILED + 1)); NOT_PASSED+=("FAIL  $id  $statement") ;;
        SKIP) colour="$C_SKIP"; SKIPPED=$((SKIPPED + 1)); NOT_PASSED+=("SKIP  $id  $statement") ;;
    esac
    printf '%s%-4s%s  %-9s %-6s %s\n' "$colour" "$verdict" "$C_OFF" "$tier" "$id" "$statement"
}

# evidence <line>… — printed under the row it belongs to, always.
evidence() { printf '                          %s\n' "$@"; }

# held <test-expression…> — PASS when the test holds, FAIL when it does not.
held() { if "$@"; then echo PASS; else echo FAIL; fi; }

# json <dotted.path> — one value out of the acceptance document.
# shellcheck disable=SC2016  # a node program, not a shell string
json() { printf '%s' "$ACCEPTANCE" | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
    const value = process.argv[1].split(".").reduce((node, key) => node?.[key], JSON.parse(raw));
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  });
' "$1"; }

# --- the evidence ------------------------------------------------------------

section "gathering the evidence"
echo "  the committed HX-5 recordings, and a ${SLOTS}-slot soak at seed ${SEED} against the oracle"
if ! ACCEPTANCE="$(node scenario/lib/cli.ts acceptance "{\"seed\":\"$SEED\",\"slots\":$SLOTS}")"; then
    echo "verify: the acceptance evidence could not be computed; nothing below can be trusted" >&2
    exit 1
fi

# --- the quality gate --------------------------------------------------------

section "the gate"
if (( FAST )); then
    row SKIP unit "RL-4" "make check — skipped by --fast; the package suites were not re-run"
elif make check >/tmp/verify-check.log 2>&1; then
    row PASS unit "RL-4" "make check: lint and every package's tests"
else
    row FAIL unit "RL-4" "make check: lint and every package's tests"
    evidence "$(tail -5 /tmp/verify-check.log)"
fi

if (cd contracts && forge test --match-path 'test/integration/**' >/tmp/verify-frame.log 2>&1); then
    FRAME_OK=1
    row PASS frame "CT-5" "the composed frame settles both profiles against the real router and bridge"
    evidence "$(grep -E '^Ran [0-9]+ test suites' /tmp/verify-frame.log | tail -1)"
else
    FRAME_OK=0
    row FAIL frame "CT-5" "the composed frame settles both profiles against the real router and bridge"
    evidence "$(grep -E '^\[FAIL' /tmp/verify-frame.log | head -5)"
fi

# --- §10, criterion by criterion ---------------------------------------------

section "RD-2 §10 — acceptance criteria"

FILLS="$(json amortisation.fills)"
ACCOUNTS="$(json amortisation.accounts)"
TXS="$(json amortisation.crossLayerTransactions)"
PER_FILL="$(json amortisation.gasPerFillWei)"
COUNTERFACTUAL="$(json amortisation.counterfactualPerFillWei)"
if [ "$FILLS" -ge 8 ] && [ "$ACCOUNTS" -ge 8 ] && [ "$TXS" -eq 1 ] && [ "$PER_FILL" -lt "$COUNTERFACTUAL" ]
then V=PASS; else V=FAIL; fi
row "$V" recorded "§10.1" "amortisation is real: N ≥ 8 orders, N accounts, one cross-layer transaction"
evidence "$FILLS fills from $ACCOUNTS accounts in $TXS cross-layer transaction" \
         "gas per fill ${PER_FILL} wei against a direct-L1 counterfactual of ${COUNTERFACTUAL} wei" \
         "this is the devnet scenario's scripted burst — the mainnet baseline is EC-5's:" \
         "  $(json amortisation.densityBaseline.fillsPerWindow) fills per window on average and $(json amortisation.densityBaseline.windowsAtLeastEight) of windows at ≥ 8," \
         "  netting $(json amortisation.densityBaseline.nettingRatio) — $(json amortisation.densityBaseline.source)" \
         "and the fee beside it: EC-1 caps FEE_BPS at $(json amortisation.feeCeilingBps) at measured gas"

VIOLATIONS="$(json limits.violations)"
V="$(held [ "$VIOLATIONS" -eq 0 ])"
row "$V" recorded "§10.2" "nobody is filled outside their limit"
evidence "$(json limits.fillsChecked) fills checked, $VIOLATIONS below their own minBuyAmount" \
         "sources: $(json limits.sources)" \
         "and CT-10 is enforced on-chain: contracts/test/l2 and test/integration assert the revert"

GAS_SPENT="$(json freeFailure.l1GasSpent)"
OPEN="$(json freeFailure.ordersLeftOpen)"
FILLED="$(json freeFailure.ordersFilled)"
DRIFT="$(json freeFailure.escrowDriftWei)"
if [ "$GAS_SPENT" = "false" ] && [ "$FILLED" -eq 0 ] && [ "$OPEN" -gt 0 ] && [ "$DRIFT" -eq 0 ]
then V=PASS; else V=FAIL; fi
row "$V" recorded "§10.3" "free failure: an evicted settlement costs zero L1 gas and moves nothing"
evidence "$(json freeFailure.evictions) eviction, l1GasSpent=$GAS_SPENT, $OPEN orders still open, $FILLED filled" \
         "escrow drift ${DRIFT} wei" \
         "the frame asserts the same thing against the real router: a band break and a short" \
         "  bridge reserve each revert with every order open (test/integration/FullFrame.t.sol)"

WORST_DRIFT="$(json escrow.worstDriftWei)"
V="$(held [ "$WORST_DRIFT" -eq 0 ])"
row "$V" simulated "§10.4" "the escrow invariant holds to the wei after every scenario and the soak"
evidence "worst drift ${WORST_DRIFT} wei over: $(json escrow.checked)" \
         "and as a Foundry invariant over the book itself (CT-13)"

STALE="$(json mirror.worstSettlementsBetweenRefreshes)"
AGE_BAD="$(json mirror.ageMismatches)"
if [ "$STALE" -le 1 ] && [ "$AGE_BAD" -eq 0 ]; then V=PASS; else V=FAIL; fi
row "$V" recorded "§10.5" "the mirror is never more than one settlement stale, and its age is right"
evidence "at worst $STALE settlement between refreshes; $AGE_BAD of $(json mirror.snapshots) snapshots" \
         "  disagreed with (observed − stamped) / 12 (CT-8)"

# shellcheck source=/dev/null
if [[ -z "${ETH_RPC:-}" && -f .env ]]; then set -a; . ./.env; set +a; fi
if [[ -z "${ETH_RPC:-}" ]]; then
    row SKIP fork "§10.6" "real pools: the fork suite against Uniswap v3 at a pinned block"
    evidence "ETH_RPC is not set. Run: cp .env.example .env && make contracts-fork"
elif make contracts-fork >/tmp/verify-fork.log 2>&1; then
    row PASS fork "§10.6" "real pools: both profiles' leg shapes against Uniswap v3 at a pinned block"
    # `make contracts-fork` is the gate and prints no console output, so TS-2's
    # gas recorder is re-run verbosely here: EC-1's fee ceiling is derived from
    # these numbers, and an evidence line that only says they exist is not
    # evidence. The fork is cached by the run above, so this costs seconds.
    (cd contracts && FOUNDRY_PROFILE=fork forge test \
        --match-test test_ts2_records_gas_per_residual_size -vv >/tmp/verify-gas.log 2>&1) || true
    evidence "$(grep -E '^Ran [0-9]+ test suites' /tmp/verify-fork.log | tail -1)" \
             "gas per residual size, at the pinned block, feeding EC-1's fee ceiling (TS-2):"
    while IFS= read -r line; do evidence "$line"; done < <(
        sed -n 's/^  \(SettlementRouter\.settle gas.*\)/  \1/p;s/^    \(residual (wei):.*\)/    \1/p' \
            /tmp/verify-gas.log
    )
else
    row FAIL fork "§10.6" "real pools: both profiles' leg shapes against Uniswap v3 at a pinned block"
    evidence "$(tail -5 /tmp/verify-fork.log)"
fi

if (( ENCLAVE )); then
    if scripts/demo.sh --smoke >/tmp/verify-demo.log 2>&1; then
        row PASS enclave "§10.7" "the window is one demo: enclave, settler, indexer and frontend together"
        evidence "$(grep -E '^  ok ' /tmp/verify-demo.log | tail -2)"
    else
        row FAIL enclave "§10.7" "the window is one demo: enclave, settler, indexer and frontend together"
        evidence "$(tail -5 /tmp/verify-demo.log)"
    fi
else
    row SKIP enclave "§10.7" "the window is one demo [full]: one command brings the whole stack up"
    evidence "needs Kurtosis, Docker and the framework's images." \
             "Run: scripts/demo.sh --smoke   (or verify.sh --enclave, which runs exactly that)"
fi

row SKIP enclave "§10.8" "a user can trade: a connected wallet places an order and sees it fill"
evidence "needs a browser and a wallet against a running enclave: scripts/demo.sh, then trade" \
         "what is asserted here instead: the order calldata the wallet would sign (frontend/test/" \
         "  calldata.test.ts, CT-7) and the pending → filled-at-P0 transitions (test/reduce.test.ts)"

# Each of the two rows below is decided by the suite its own evidence names,
# and not by `npm run test:e2e`, which runs both: the replay row must be able
# to fail on its own when the fixture-fed suite breaks, and the observe row
# on its own when the live-gateway one does. One command deciding two claims
# would let either row pass on the other's tests.
tally() { grep -E '^. (tests|pass|fail) [0-9]+' "$1" | tr -d '\342\204\271' | tr -s ' \n' ' '; }

if (cd frontend && node --test e2e/theater.test.ts >/tmp/verify-e2e-replay.log 2>&1); then
    row PASS unit "§10.9" "replay stands alone: the recorded run plays back with no infrastructure"
    evidence "frontend/e2e/theater.test.ts over scenario/fixtures/*.json, read from disk:" \
             "  no gateway, no chain, and the app's own component tree" \
             "$(tally /tmp/verify-e2e-replay.log)"
else
    row FAIL unit "§10.9" "replay stands alone: the recorded run plays back with no infrastructure"
    evidence "$(tail -5 /tmp/verify-e2e-replay.log)"
fi

if (cd frontend && node --test e2e/live-gateway.test.ts >/tmp/verify-e2e-live.log 2>&1); then
    row PASS unit "§10.10" "observe mode is honest: no demo affordances, no invented activity"
    evidence "frontend/e2e/live-gateway.test.ts renders observe mode against a real gateway on a" \
             "  real socket and asserts the director's controls are absent (FE-9) and that" \
             "  nothing claims to be a replay (IX-1)" \
             "$(tally /tmp/verify-e2e-live.log)"
else
    row FAIL unit "§10.10" "observe mode is honest: no demo affordances, no invented activity"
    evidence "$(tail -5 /tmp/verify-e2e-live.log)"
fi

# --- the soak's own report ---------------------------------------------------

section "HX-4 — the soak, and what it reported"

SOAK_FAILURES="$(json soak.failures)"
STRANDED="$(json soak.stranded)"
V="$(held [ "$STRANDED" -eq 0 ])"
row "$V" simulated "HX-4" "every order reached a terminal state over $(json soak.settlements) settlements"
evidence "$(json soak.orders) orders, $(json soak.fills) fills, $STRANDED stranded"

for metric in fills_per_settlement netting_ratio roll_rate gas_per_fill_wei counterfactual_l1_gas_wei impact_bps; do
    evidence "$(printf '%-26s %s' "$metric" "$(json "soak.metrics.$metric")")"
done
evidence "$(printf '%-26s %s' selection_omitted_total "$(json soak.metrics.selection_omitted_total)") (EC-4: must be 0)" \
         "$(printf '%-26s %s' escrow_invariant_drift_wei "$(json soak.metrics.escrow_invariant_drift_wei)") (CT-13: must be 0)"

if [[ "$SOAK_FAILURES" -eq 0 ]]; then
    row PASS simulated "A.6" "every A.6 check held across the soak"
else
    row FAIL simulated "A.6" "$SOAK_FAILURES A.6 check(s) did not hold across the soak"
    # shellcheck disable=SC2016  # a node program, not a shell string
    printf '%s' "$ACCEPTANCE" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
        for (const line of JSON.parse(raw).soak.lines) {
          if (line.includes("FAIL") || line.startsWith("==>")) process.stdout.write(`${line}\n`);
        }
      });
    ' | sed 's/^/                          /'
fi

# --- §11, the scope sweep ----------------------------------------------------

section "RD-2 §11 — non-goals and do-not-touch"

FRAMEWORK="${EEZ_ROLLUP0_DIR:-$ROOT/../eez-rollup0}"
PIN="$(sed -n 's/^EEZ_ROLLUP0_COMMIT=//p' FRAMEWORK_COMMIT)"
if [[ -d "$FRAMEWORK/.git" ]] && git -C "$FRAMEWORK" cat-file -e "$PIN^{commit}" 2>/dev/null; then
    # The whole of what the pin brought in, against its first parent — which
    # for the merge that landed WP-U is the branch's entire change (UP-1…UP-3).
    TOUCHED="$(git -C "$FRAMEWORK" diff --name-only "$PIN^" "$PIN")"
    # The hooks themselves, plus the framework's own CI job that runs their
    # verifier — which is named here rather than folded into the glob, so a
    # reader sees exactly what the pin brought in outside testing/kurtosis/.
    OUTSIDE="$(printf '%s\n' "$TOUCHED" \
        | grep -vE '^(testing/kurtosis/|kurtosis\.yml$|\.github/workflows/ci\.yml$|$)' || true)"
    CI_JOB="$(printf '%s\n' "$TOUCHED" | grep -cE '^\.github/workflows/ci\.yml$' || true)"
    IDENTIFIER="$(git -C "$FRAMEWORK" diff "$PIN^" "$PIN" -- . \
        | grep -E '^\+' \
        | grep -iE '(^|[^[:alnum:]_])dex([^[:alnum:]_]|$)|windowbook|settlementrouter|dexbridge' || true)"
    if [[ -z "$OUTSIDE" && -z "$IDENTIFIER" ]]; then
        row PASS unit "UP-4" "eez-rollup0 changed only under the harness hooks, and names no DEX"
        evidence "$(printf '%s\n' "$TOUCHED" | grep -c . || true) files at ${PIN:0:9}, all under testing/kurtosis/" \
                 "no added line names dex, WindowBook, SettlementRouter or DexBridge (UP-4)" \
                 "nothing on §11's list — composer, held pool, front, proof signer, deriver, registry"
        if [[ "$CI_JOB" -gt 0 ]]; then
            evidence "one file beyond the hooks: .github/workflows/ci.yml adds the job that runs" \
                     "  testing/kurtosis/scripts/verify-harness-hooks.sh, and nothing else"
        fi
    else
        row FAIL unit "UP-4" "eez-rollup0 changed outside the harness hooks, or names the DEX"
        [[ -n "$OUTSIDE" ]] && evidence "outside the hooks:" "$OUTSIDE"
        [[ -n "$IDENTIFIER" ]] && evidence "DEX identifiers in the diff:" "$IDENTIFIER"
    fi
else
    row SKIP unit "UP-4" "eez-rollup0 changed only under the harness hooks, and names no DEX"
    evidence "no framework checkout at $FRAMEWORK carrying ${PIN:0:9}. Run:" \
             "  EEZ_ROLLUP0_DIR=<checkout> scripts/verify.sh"
fi

SOURCES=(contracts/src settler/src indexer/src indexer/schema frontend/src scenario/lib)
INVENTORY="$(grep -rniE 'market.?mak|inventory|liquidity buffer|working capital' "${SOURCES[@]}" \
    | grep -vE 'no inventory|never inventory|not inventory|holds no|custody, not inventory|EC-2' || true)"
V="$(held [ -z "$INVENTORY" ])"
row "$V" unit "§11" "no inventory, no market-making, no L2 liquidity buffer"
[[ -n "$INVENTORY" ]] && evidence "$INVENTORY"

ADAPTERS="$(grep -rl 'is IPoolAdapter' contracts/src | wc -l | tr -d ' ')"
VENUE_LEAK="$(grep -rl 'IUniswapV3' contracts/src --include='*.sol' | grep -v 'src/l1/adapters/' || true)"
if [ "$ADAPTERS" -eq 1 ] && [ -z "$VENUE_LEAK" ]; then V=PASS; else V=FAIL; fi
row "$V" unit "CT-3" "one venue, behind one adapter interface: a second venue is a new adapter"
evidence "$ADAPTERS implementation of IPoolAdapter; nothing outside src/l1/adapters/ names Uniswap"
[[ -n "$VENUE_LEAK" ]] && evidence "$VENUE_LEAK"

LLM="$(grep -rniE 'openai|anthropic|langchain|llamaindex|ollama|gpt-[0-9]|claude-[0-9]|\bllm\b' "${SOURCES[@]}" \
    | grep -viE 'no llm' || true)"
V="$(held [ -z "$LLM" ])"
row "$V" unit "§11" "no LLM in the control path"
[[ -n "$LLM" ]] && evidence "$LLM"

MAINNET="$(grep -rniE 'forge script.*--broadcast|--rpc-url .*mainnet|deploy.*mainnet' \
    scripts scenario contracts/foundry.toml .github --exclude=verify.sh 2>/dev/null \
    | grep -viE 'fork|ETH_RPC|no mainnet|never' || true)"
V="$(held [ -z "$MAINNET" ])"
row "$V" unit "§11" "no mainnet deployment in any script or configuration"
evidence "the only mainnet endpoint in the tree is the fork suite's read-only ETH_RPC"
[[ -n "$MAINNET" ]] && evidence "$MAINNET"

# A `frame` row has to be decided by the frame, not by a grep over the source:
# the claim is that the *same contracts* settle both profiles, and only running
# both integration suites shows that. The grep is kept beside it because it is
# the other half of the claim — the selection is a constructor argument rather
# than a second contract — but neither half passes this row alone.
FORKED="$(grep -rn 'GENESIS' contracts/src --include='*.sol' | grep -cE 'Profile.GENESIS' || true)"
if (( FRAME_OK )) && [ "$FORKED" -gt 0 ]; then V=PASS; else V=FAIL; fi
row "$V" frame "§1" "profile is configuration, never a fork: one codebase builds both"
evidence "one bytecode, selected by a constructor argument and a zero address:" \
         "  test/integration/GenesisFrame.t.sol settles the genesis shape and" \
         "  test/integration/FullFrame.t.sol the full one, from the same contracts" \
         "both ran above (CT-5); $FORKED source lines select the profile at construction"

STUBS="$(grep -rn 'not implemented: Phase' . --exclude=verify.sh \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=out --exclude-dir=target --exclude-dir=lib \
    2>/dev/null || true)"
V="$(held [ -z "$STUBS" ])"
row "$V" unit "RL-3" "every stub is implemented by its owner: no phase marker survives"
[[ -n "$STUBS" ]] && evidence "$STUBS"

# --- the verdict -------------------------------------------------------------

section "verdict"
printf '  %d passed, %d failed, %d skipped\n' "$PASSED" "$FAILED" "$SKIPPED"
if (( FAILED || SKIPPED )); then
    printf '\n  not passed:\n'
    printf '    %s\n' "${NOT_PASSED[@]}"
fi

if (( FAILED )); then
    # Which rows failed decides what the failure means: an acceptance criterion
    # is §10 unmet, anything else is a supporting check that did not hold.
    CRITERIA_FAILED="$(printf '%s\n' "${NOT_PASSED[@]}" | grep -c '^FAIL  §10' || true)"
    if [[ "$CRITERIA_FAILED" -gt 0 ]]; then
        printf '\n%sverify: %d row(s) FAILED, %d of them an RD-2 §10 criterion%s\n' \
            "$C_FAIL" "$FAILED" "$CRITERIA_FAILED" "$C_OFF"
    else
        printf '\n%sverify: %d row(s) FAILED — no §10 criterion among them, and not green either%s\n' \
            "$C_FAIL" "$FAILED" "$C_OFF"
    fi
    exit 1
fi
if (( SKIPPED )); then
    printf '\n%sverify: INCOMPLETE — %d row(s) could not be asserted here%s\n' "$C_SKIP" "$SKIPPED" "$C_OFF"
    exit 2
fi
printf '\n%sverify: every RD-2 §10 criterion holds%s\n' "$C_PASS" "$C_OFF"
exit 0

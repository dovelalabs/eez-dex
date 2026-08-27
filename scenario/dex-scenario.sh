#!/usr/bin/env bash
# The enclave scenario — RD-2 WP-4, HX-2 … HX-5.
#
# Phase 4a stub — owner implements.
#
# What lands here: bring the enclave up through the framework's Kurtosis
# package (UP-3), deploy the external bundle of MockPool, router, adapter,
# book and bridge pair (UP-1, HX-1), place a scripted set of orders across a
# window from several accounts, let the settler settle, and assert appendix
# A.6's happy path — including that exactly one cross-layer transaction
# settled N orders. Then the failure matrix (HX-3) over the `place`, `cancel`
# and `drift` external ops (UP-2), the 200-slot soak (HX-4), and the recorded
# run the frontend replays (HX-5).
#
# It cannot run until Phase U's hooks are merged upstream and the
# FRAMEWORK_COMMIT bump pinning them has landed here (RD-2 §5).
#
# Usage, once implemented:
#   scenario/dex-scenario.sh                 happy path
#   scenario/dex-scenario.sh --matrix        the full failure matrix
#   scenario/dex-scenario.sh --soak 200      the window soak
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The Kurtosis package reference is generated from FRAMEWORK_COMMIT (RL-1).
# shellcheck source=/dev/null
. "$ROOT/scenario/framework-pin.env"

echo "not implemented: Phase 4a"
# EEZ_KURTOSIS_LOCATOR comes from the sourced file above.
# shellcheck disable=SC2154
echo "would drive ${EEZ_KURTOSIS_LOCATOR}"
exit 1

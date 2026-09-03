# eez-dex — the single quality gate.
#
# `make check` is the hard gate before every commit (CLAUDE.md,
# .claude/rules/testing.md). It runs lint, then the tests of every package.
#
# THIS FILE IS FROZEN AT THE SCAFFOLD (RD-2 §5). Every package target is
# already wired, so no later work package edits it — three parallel branches
# appending their own target is the merge conflict this prevents.

.PHONY: check lint test fix pin pin-check deps \
        contracts settler indexer frontend scenario scenario-unit \
        lint-contracts lint-settler lint-indexer lint-frontend lint-scenario \
        clean

# ---------------------------------------------------------------- the gate ---

check: lint test

lint: pin-check lint-contracts lint-settler lint-indexer lint-frontend lint-scenario

test: contracts settler indexer frontend scenario-unit

# Format and auto-fix everything `lint` checks.
fix:
	cd contracts && forge fmt
	cd settler && cargo fmt && cargo clippy --fix --allow-dirty --allow-staged
	cd indexer && npm run lint -- --fix || true
	cd frontend && npm run lint -- --fix || true

# ------------------------------------------------------------------- pin ----
# RL-1: one file generates the Foundry remapping, the cargo git+rev dependency
# and the Kurtosis package reference. `pin-check` is part of `lint`, so a hand
# edit to a generated file fails `make check`.

pin:
	./scripts/framework-pin.sh

pin-check:
	./scripts/framework-pin.sh --check

# Pinned Solidity dependencies live as git submodules under contracts/lib.
deps:
	@test -f contracts/lib/forge-std/src/Test.sol || git submodule update --init contracts/lib/forge-std
	@test -d contracts/lib/openzeppelin-contracts/contracts || git submodule update --init contracts/lib/openzeppelin-contracts
	@test -d contracts/lib/eez-core-protocol/src || git submodule update --init contracts/lib/eez-core-protocol

# -------------------------------------------------------------- contracts ---

contracts: deps
	cd contracts && forge test

lint-contracts: deps
	cd contracts && forge fmt --check && forge build --sizes

# Mainnet-fork suite (TS-2, TS-B). Not part of `check`: it needs a real RPC and
# runs sequentially. Copy .env.example to .env and set ETH_RPC and FORK_BLOCK.
#
# `forge test` exits 0 both when it discovers no tests and when every case
# reports [SKIP], so the bare command cannot gate a PR (RL-4). This target adds
# the two assertions it is missing:
#
#   * ETH_RPC must be set. Chosen over "fail on any skip" as the primary guard
#     because it names the cause before a minute is spent on the network, and an
#     unset RPC is the only reason a fork case skips today (DexBridgeFork's
#     setUp returns early). The skip assertion below backstops any future one.
#   * the run must print a summary, pass at least FORK_MIN_TESTS, and skip
#     none — so a filter or path that stops matching goes red instead of
#     quietly reporting success having proved nothing.
#
# `--threads 1` runs the suites sequentially, as .claude/rules/testing.md says
# this suite does: two suites forking in parallel put enough concurrent load on
# the keyless endpoint to draw HTTP 408s that are an endpoint limit, never a
# contract failure.
#
# FORK_TEST_PATH is overridable so the guard itself can be exercised:
#   make contracts-fork FORK_TEST_PATH='test/no-such-suite/**'   # must exit 1
FORK_TEST_PATH ?= test/fork/**
FORK_MIN_TESTS ?= 9

.PHONY: contracts-fork
contracts-fork: deps
	@if [ -z "$${ETH_RPC:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	  if [ -z "$${ETH_RPC:-}" ]; then \
	    echo "make: ETH_RPC is unset. The TS-B rows would report [SKIP] and this"; \
	    echo "make: gate would pass having proved nothing. Copy .env.example to"; \
	    echo "make: .env, or export ETH_RPC (https://eth.drpc.org works keyless)."; \
	    exit 1; \
	  fi; \
	  log="$$(mktemp)"; trap 'rm -f "$$log" "$$log.status"' EXIT; \
	  ( cd contracts && FOUNDRY_PROFILE=fork forge test --match-path '$(FORK_TEST_PATH)' --threads 1; \
	    echo $$? >"$$log.status" ) 2>&1 | tee "$$log"; \
	  status="$$(cat "$$log.status")"; \
	  summary="$$(grep -E '^Ran .*tests? passed,' "$$log" | tail -1)"; \
	  passed="$$(printf '%s' "$$summary" | sed -n 's/.*: \([0-9][0-9]*\) tests* passed.*/\1/p')"; \
	  skipped="$$(printf '%s' "$$summary" | sed -n 's/.*, \([0-9][0-9]*\) skipped.*/\1/p')"; \
	  if [ "$$status" -ne 0 ]; then exit "$$status"; fi; \
	  if [ -z "$$passed" ]; then \
	    echo "make: the fork gate discovered no tests - it proved nothing (RL-4)"; exit 1; \
	  fi; \
	  if [ "$$passed" -lt $(FORK_MIN_TESTS) ]; then \
	    echo "make: the fork gate passed $$passed tests, expected at least $(FORK_MIN_TESTS) (TS-2, TS-B)"; exit 1; \
	  fi; \
	  if [ "$${skipped:-0}" -ne 0 ]; then \
	    echo "make: the fork gate skipped $$skipped tests - a skipped row is not a passing one"; exit 1; \
	  fi

# ---------------------------------------------------------------- settler ---

settler:
	cd settler && cargo test

lint-settler:
	cd settler && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# ---------------------------------------------------------------- indexer ---

indexer: indexer/node_modules
	cd indexer && npm test

lint-indexer: indexer/node_modules
	cd indexer && npm run lint

indexer/node_modules: indexer/package.json
	cd indexer && npm install --no-audit --no-fund
	@touch indexer/node_modules

# --------------------------------------------------------------- frontend ---

frontend: frontend/node_modules
	cd frontend && npm run ci

lint-frontend: frontend/node_modules
	cd frontend && npm run lint

frontend/node_modules: frontend/package.json
	cd frontend && npm install --no-audit --no-fund
	@touch frontend/node_modules

# --------------------------------------------------------------- scenario ---
# The package splits in two, and only one half belongs in the gate.
#
# `scenario-unit` is the hermetic half — the oracle, the recorder and the A.6
# assertions (TS-4), which are arithmetic over fixtures and need no network.
# It is in `check` like every other package's suite.
#
# `scenario` is the enclave run: it needs Kurtosis and Docker, so it stays out.
# RL-4 runs the happy path and the first failure rows in CI, the full matrix
# and the soak nightly.

scenario:
	scenario/dex-scenario.sh

scenario-unit: scenario/node_modules
	cd scenario && npm test

lint-scenario: scenario/node_modules
	cd scenario && npm run lint
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck scenario/*.sh scripts/*.sh; \
	else \
		echo "make: shellcheck not installed, skipping shell lint"; \
	fi

scenario/node_modules: scenario/package.json
	cd scenario && npm install --no-audit --no-fund
	@touch scenario/node_modules

# ------------------------------------------------------------------ clean ---

clean:
	cd contracts && forge clean
	cd settler && cargo clean
	rm -rf indexer/node_modules indexer/dist frontend/node_modules frontend/dist \
	       scenario/node_modules

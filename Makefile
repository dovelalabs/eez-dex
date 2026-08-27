# eez-dex — the single quality gate.
#
# `make check` is the hard gate before every commit (CLAUDE.md,
# .claude/rules/testing.md). It runs lint, then the tests of every package.
#
# THIS FILE IS FROZEN AT THE SCAFFOLD (RD-2 §5). Every package target is
# already wired, so no later work package edits it — three parallel branches
# appending their own target is the merge conflict this prevents.

.PHONY: check lint test fix pin pin-check deps \
        contracts settler indexer frontend scenario \
        lint-contracts lint-settler lint-indexer lint-frontend lint-scenario \
        clean

# ---------------------------------------------------------------- the gate ---

check: lint test

lint: pin-check lint-contracts lint-settler lint-indexer lint-frontend lint-scenario

test: contracts settler indexer frontend

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

# Mainnet-fork suite (TS-2). Not part of `check`: it needs a real RPC and runs
# sequentially. Copy .env.example to .env and set ETH_RPC and FORK_BLOCK.
.PHONY: contracts-fork
contracts-fork: deps
	cd contracts && FOUNDRY_PROFILE=fork forge test --match-path 'test/fork/**'

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
# The enclave scenario is not part of `check`: it needs Kurtosis and Docker.
# RL-4 runs the happy path and the first failure rows in CI, the full matrix
# and the soak nightly.

scenario:
	scenario/dex-scenario.sh

lint-scenario:
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck scenario/*.sh scripts/*.sh; \
	else \
		echo "make: shellcheck not installed, skipping shell lint"; \
	fi

# ------------------------------------------------------------------ clean ---

clean:
	cd contracts && forge clean
	cd settler && cargo clean
	rm -rf indexer/node_modules indexer/dist frontend/node_modules frontend/dist

# Commits

**Gate:** `make check` must pass before every commit. No exceptions.

**Auto-commit:** Commit each logical change as it is completed, without waiting to be
asked. Do not commit mid-feature or bundle unrelated changes.

**Message format:** `type(scope): short description`

- `type` — `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- `scope` — the package or module. Common scopes:
  - Packages: `contracts`, `settler`, `scenario`, `indexer`, `frontend`
  - Contract modules: `router`, `windowbook`, `mirror`, `bridge`, `adapter`
  - Settler tasks: `watcher`, `builder`, `submitter`, `reconciler`
  - Cross-cutting: `pin` (`FRAMEWORK_COMMIT` bumps), `schema`, `docs`, `repo`, `ci`
- Description — imperative, lowercase, no period. 72 characters total max.
- Cite the requirement ID(s) in the body when the change implements or fixes one (RL-3),
  e.g. `Implements CT-10.`

```
feat(windowbook): enforce minBuyAmount per fill at settlement
fix(router): check Expired against the L1 timestamp deadline
test(contracts): add per-asset escrow invariant for CT-13
refactor(builder): resolve selection ties by ascending order id
chore(pin): bump FRAMEWORK_COMMIT to a1b2c3d
docs(repo): describe demo, replay and observe modes
```

**Branches:** one work package per branch:

| Package | Branch |
|---|---|
| scaffold | `chore/scaffold` |
| WP-1 L1 router + adapter | `feat/dex-settlement-l1` |
| WP-2 L2 window book | `feat/dex-windowbook-l2` |
| WP-B bridge pair **[full]** | `feat/dex-bridge` |
| WP-3 settler | `feat/dex-settler` |
| WP-4 scenario | `feat/dex-scenario` |
| WP-5 indexer | `feat/dex-indexer` |
| WP-6 frontend | `feat/dex-frontend` |

**Scope:** One logical change per commit. A `FRAMEWORK_COMMIT` bump is always its own
commit (RL-1). Nothing here ever commits to `eez-rollup0`.

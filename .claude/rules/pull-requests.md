# Pull Requests

When all commits on a branch are done, `make check` passes, the package's own verification
command passes (`forge test`, `cargo test`, `scenario/dex-scenario.sh`, `npm test`,
`npm run ci`), and the review agent has reported back, push and open a PR automatically.

- **Target:** always `main`
- **State:** always open as **draft**
- **Title:** `type(scope): short description` — same convention as commits
- **Body:** bullet summary of what changed, the work package it belongs to, and the
  requirement IDs it implements (RL-3), e.g.
  _Implements WP-2 — CT-7, CT-8, CT-9, CT-10._
  For fork tests, state the pinned block. For anything that moves L1 gas (router, book,
  bridge), include recorded gas per residual size — TS-2's numbers feed EC-1's parameters.

```bash
git push -u origin <branch>
gh pr create --draft --base main --title "..." --body "..."
```

## Agent Run Report (PR comment)

Immediately after the PR is created, post an agent run report as a PR comment. Assemble
it from:
1. `git log main..HEAD --oneline` — the implementation commits
2. The review agent's returned report

```bash
gh pr comment <PR-number> --body "$(cat <<'REPORT'
## Agent Run Report

### Implementation Commits
- <hash> <message>

### Review Report
<review agent's full structured output>
REPORT
)"
```

This comment is the permanent record of what every agent did on the branch. Post it
before considering the branch done.

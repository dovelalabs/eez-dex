# Review Gate

After completing a feature or bug fix — before opening a PR — the implementation agent
**must** spawn a review agent to verify the work against the source requirements. This is
a hard gate, equivalent to `make check`.

## When to trigger

- All implementation commits are done
- `make check` passes on the current branch
- You are about to open the PR

## How to spawn the review agent

```
Agent({
  description: "Requirements review: <WP or feature name>",
  prompt: """
You are a review agent for eez-dex. Verify a completed implementation against its
source requirements, fix any gaps, and commit the fixes.

## What was implemented
<one-sentence summary>

## Requirements source
RD-2 (REQUIREMENTS.md): section "<§6 WP-N — name>", requirement IDs <CT-9, CT-10, ...>,
the matching §9 TS-* row, and appendix A for shared types, state machines and metrics
where relevant. <path to the document as available in this session>

## Files changed
<list>

## Your task
1. Read every requirement row by ID and the matching TS-* row
2. Read each changed file
3. For every ID, verify it is fully implemented — [full]/[genesis] tags respected,
   profile is configuration not a fork
4. For any gap: fix it, then run `make check` and the package command
   (e.g. `forge test`) to confirm
5. Commit each fix as: fix(scope): <description>

Do not refactor or improve beyond what the requirements specify.
Do not add features not in the requirements. Do not touch eez-rollup0.

## Your output

### Requirements Checked
- <ID> <one-line gloss> — PASS / FAIL / FIXED

### Gaps Found
<bullets, or "None">

### Fixes Made
<commits, or "None">

### Quality Gate
`make check`: PASS / FAIL
`<package command>`: PASS / FAIL
"""
})
```

Capture the returned report — it goes into the PR's Agent Run Report.

## What the review agent checks

- Every requirement ID in scope is present in the implementation
- Shared types (appendix A.1) exist with the correct fields and Q96 price conventions
- Enforcement lives where the spec puts it (e.g. CT-10 on-chain, not in the settler)
- Every TS-* test the section requires exists and passes; every new behaviour has a test,
  every bug fix a regression test
- Safety invariants preserved: escrow invariant (CT-13), limit enforcement (CT-10),
  selection determinism (SV-2), rounding-down/dust (CT-12), one-in-flight (SV-3)
- Nothing on the do-not-touch list (`CLAUDE.md`) was modified

# Agent Team: Code Review

This directory defines a project-local multi-agent code review team.

## Team

- `review-coordinator.md` — main supervising agent. Plans the review, delegates to reviewers, deduplicates findings, and produces the final report.
- `correctness-reviewer.md` — logic, edge cases, regressions, lifecycle/state bugs.
- `security-reviewer.md` — command/file/network safety, trust boundaries, secrets, permission bypass risks.
- `test-reviewer.md` — test coverage, regression tests, flaky/weak assertions.
- `architecture-reviewer.md` — boundaries, cohesion, coupling, lifecycle ownership, complexity.
- `maintainability-reviewer.md` — readability, naming, errors, logging, docs, style consistency.

## Intended Usage

Ask the main agent to use the review coordinator, for example:

```text
Use review-coordinator to review the current diff with the agent team.
```

or:

```text
用 review-coordinator 组织 agent team review 当前改动。
```

The coordinator should then delegate read-only review tasks to specialized subagents and supervise the final synthesis.

## Notes

- Reviews are read-only by default.
- The coordinator should inspect scope with `git_status` / `git_diff` when the user does not provide files.
- Subagents should return evidence-backed findings only.

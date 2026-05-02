---
description: OpenSpec-style spec-driven development workflow for proposals, specs, tasks, validation, and implementation.
command: openspec
aliases:
  - spec
  - os
commands:
  propose: Create or update an OpenSpec change proposal and task list before implementation.
  validate-spec: Validate OpenSpec files, proposal consistency, and readiness.
  implement-spec: Implement an accepted OpenSpec change while keeping code aligned with the proposal/tasks.
triggers:
  - openspec
  - spec-driven
  - spec driven
  - proposal
  - change proposal
---

# OpenSpec Workflow

Use this skill when the user asks for OpenSpec-like or spec-driven development, or invokes `/openspec`, `/spec`, `/os`, `/propose`, `/validate-spec`, or `/implement-spec`.

## Core rules

- Treat user requests as changes that should be specified before broad implementation.
- Prefer project-local conventions if an `openspec/`, `specs/`, `docs/specs/`, or similar directory already exists.
- If no OpenSpec structure exists, initialize a minimal `openspec/` structure before creating a proposal.
- Do not implement code until the proposal and task list are clear, unless the user explicitly asks for initialization only.
- Keep changes focused and small; preserve existing style.
- Validate by inspecting files and, when practical, running targeted checks/tests.

## Minimal project structure

When initializing OpenSpec in a repo, create:

```text
openspec/
  README.md
  project.md
  changes/
    .gitkeep
  specs/
    .gitkeep
```

Use `openspec/project.md` to capture project-wide product/technical context. Use `openspec/changes/<change-id>/` for proposed changes.

## Change workflow

For a new requested change:

1. Understand the user request and inspect existing OpenSpec/project conventions.
2. Choose a concise kebab-case `change-id`, usually verb-led, e.g. `add-user-settings`.
3. Create or update:

```text
openspec/changes/<change-id>/
  proposal.md
  tasks.md
  specs/
```

4. `proposal.md` should include:
   - `# <change-id>`
   - `## Summary`
   - `## Motivation`
   - `## Proposed Changes`
   - `## Impact`
   - `## Open Questions`
5. `tasks.md` should include checklist items grouped by:
   - Spec/design
   - Implementation
   - Validation
6. Add spec deltas under `openspec/changes/<change-id>/specs/` when behavior/API/user-facing contracts change.
7. Before implementation, summarize the proposal and ask for confirmation if the change is broad or ambiguous.

## Validation workflow

When validating:

- Check that proposal, tasks, and spec deltas exist and are internally consistent.
- Check that tasks are actionable and validation steps are present.
- Check whether implementation files match the proposal if implementation has started.
- Report concrete missing items rather than generic advice.

## Implementation workflow

When implementing an accepted change:

- Read the relevant proposal and tasks first.
- Mark or report completed tasks as implementation proceeds.
- Keep code changes aligned with the proposal. If implementation reveals a spec issue, update the proposal/spec or ask before diverging.
- Run targeted tests or explain why validation was not run.
- Final response must mention changed files, task progress, and validation status.

## Final response format

Prefer concise bullets:

- OpenSpec status: initialized/proposed/validated/implemented
- Files changed
- Key decisions
- Validation
- Next steps

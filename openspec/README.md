# OpenSpec

This directory tracks spec-driven changes for PieCode.

## Workflow

1. Create a change under `openspec/changes/<change-id>/`.
2. Write `proposal.md` to describe the motivation, proposed behavior, impact, and open questions.
3. Write `tasks.md` with actionable implementation and validation tasks.
4. Add spec deltas under `openspec/changes/<change-id>/specs/` when behavior, API, or UX contracts change.
5. Validate the proposal before implementation.
6. Keep implementation aligned with the accepted proposal and update task status as work proceeds.

## Commands

PieCode can use the local OpenSpec skill as custom commands:

- `/openspec <request>`
- `/spec <request>`
- `/propose <request>`
- `/validate-spec <request>`
- `/implement-spec <request>`

The skill lives at `.piecode/skills/openspec/SKILL.md` for this repository.

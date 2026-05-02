# add-skill-custom-commands

## Summary

Add support for skill-backed custom slash commands so reusable workflows, including OpenSpec, can be invoked directly from the interactive command line.

## Motivation

PieCode already supports skills as reusable instructions, but users need a direct command-style workflow for spec-driven development. OpenSpec-style work benefits from commands like `/openspec`, `/propose`, `/validate-spec`, and `/implement-spec` that activate a workflow and pass the remaining input as the task request.

## Proposed Changes

- Discover slash commands from skill metadata.
- Treat each skill name as a default command, e.g. skill `openspec` exposes `/openspec`.
- Support frontmatter fields for additional commands:
  - `command`
  - `aliases`
  - `commands`
- Add `/skills commands` to list commands exposed by skills.
- Route unknown slash commands through the skill-command resolver before reporting them as unknown.
- Initialize a project-local OpenSpec skill and minimal `openspec/` workspace.

## Impact

- Users can invoke OpenSpec and other workflow skills directly from the TUI.
- Existing built-in slash commands keep priority over skill commands.
- Project-local skills can be stored under `.piecode/skills` when configured in skill paths.

## Open Questions

- Should project-local `.piecode/skills` be included as a default skill root in code, instead of documenting it in settings/project instructions?
- Should command name conflicts be surfaced explicitly in `/skills commands`?
- Should one-shot `--prompt` support direct slash command execution as well?

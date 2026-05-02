# PieCode Project Context

## Purpose

PieCode is a command-line coding agent for software engineering tasks. It provides an interactive terminal interface, model-driven tool use, multi-provider AI support, MCP integration, skills, planning, and task/session tracing.

## Tech Stack

- Node.js 18+
- JavaScript ES modules
- Jest for tests
- ESLint/Prettier for quality
- Terminal/TUI support via neo-blessed and custom line editing

## Key Areas

- `src/cli.js`: CLI entry, interactive commands, TUI wiring, settings, model switching, MCP and skill management.
- `src/lib/agent.js`: agent lifecycle, toolset rebuilds, context compaction, turn execution.
- `src/lib/turnEngine.js`: model loop, native/text tool handling, parallel tool batches, policies, planning hooks.
- `src/lib/tools.js`: workspace-safe tools and shell safety classification.
- `src/lib/skills.js`: skill discovery, trigger/mention activation, custom skill commands.
- `src/lib/prompt.js`: system prompt, tool definitions, response parsing, native message conversion.
- `__tests__/`: Jest coverage for agent, tools, prompt, TUI, skills, MCP, and session behavior.

## Development Constraints

- Preserve existing style and keep changes focused.
- Prefer read/list/search tools before shell for code inspection.
- Use targeted edits instead of broad rewrites.
- Validate meaningful changes with `npm test -- --runInBand` or targeted Jest tests.
- Treat project instructions in `AGENTS.md` as authoritative.

## Spec Conventions

- OpenSpec files live under `openspec/`.
- Proposed changes live under `openspec/changes/<change-id>/`.
- Each change should include `proposal.md` and `tasks.md`.
- Spec deltas should live under `openspec/changes/<change-id>/specs/` when needed.

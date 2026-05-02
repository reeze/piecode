# Memory

- PieCode should support durable memory loaded at startup from project `.piecode/MEMORY.md` and global `~/.piecode/MEMORY.md`.
- During work, agents should identify stable project conventions, decisions, and recurring facts and save them to project memory; user-wide preferences should go to global memory. Do not save secrets or transient debugging details.
- PieCode supports Claude Code-style `.AGENTS/*.md` project agent definitions: frontmatter (`name`, `description`, `tools`, `model`, `color`) is loaded by `src/lib/agentDefinitions.js`, named subagents are invoked via `subagent` role/agent/name, and tool lists restrict rather than elevate subagent permissions.

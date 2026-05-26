# Plugin Tool Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude/Codex-compatible plugin hooks that can rewrite tool input before execution and replace/compress tool output after execution.

**Architecture:** Discover hook configuration from active plugins, execute command hooks with JSON stdin/stdout around the existing TurnEngine tool-call path, and keep hook failures non-fatal. Use Claude/Codex event names and response shapes where possible while preserving PieCode approval/sandbox behavior.

**Tech Stack:** Node.js ESM, child_process spawn, existing PieCode plugin discovery and TurnEngine.

---

### Task 1: Discover plugin hook configuration

**Files:**
- Modify: `src/lib/plugins.js`
- Test: `__tests__/pluginHooks.test.js`

- [ ] Load hooks from plugin `hooks/hooks.json` by default.
- [ ] Support `hooks` in `PLUGIN.md` frontmatter as an inline object or JSON path.
- [ ] Support `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` `hooks` entries as paths or inline objects.
- [ ] Store normalized hook config on discovered plugin metadata as `hooks`.

### Task 2: Execute command hooks

**Files:**
- Create: `src/lib/pluginHooks.js`
- Test: `__tests__/pluginHooks.test.js`

- [ ] Implement matcher handling compatible with Claude/Codex examples (`*`, empty, regex, `Bash|Edit`).
- [ ] Implement command hook execution with JSON stdin, timeout, cwd, and plugin env vars: `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`.
- [ ] Parse JSON stdout and exit-code-2 block feedback.
- [ ] Support `PreToolUse` outputs: `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`, legacy `decision: block`.
- [ ] Support `PostToolUse` outputs: `updatedToolOutput`, `updatedResult`, `additionalContext`, `decision: block`, `continue: false`.

### Task 3: Wire hooks into tool execution

**Files:**
- Modify: `src/lib/agent.js`
- Modify: `src/lib/turnEngine.js`
- Test: focused Jest tests

- [ ] Add `Agent.applyPreToolHooks()` and `Agent.applyPostToolHooks()` wrappers.
- [ ] Run pre hooks after tool permission routing is known but before shell/read-only/commit policy checks and before pushing tool-use history.
- [ ] Run post hooks after tool execution and before `tool_end` event/history append, so model-visible output can be reduced.
- [ ] Emit `plugin_tool_hook` events for debug/trace visibility.

### Task 4: Validate

**Files:**
- Run focused tests: `npm test -- --runTestsByPath __tests__/pluginHooks.test.js`
- Run existing relevant tests: `npm test -- --runTestsByPath __tests__/agent.test.js __tests__/turnEngine.test.js`

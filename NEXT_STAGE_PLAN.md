# PieCode Next Stage Plan: System Prompt, Prompt Experience, and Tools

## Goal

Define the next development stage for PieCode around the agent's system prompt, prompt experience/persona (PE), and tool layer. This plan is based on the current repository state, including `src/lib/prompt.js`, `src/lib/tools.js`, `src/lib/turnEngine.js`, `README.md`, `openspec/project.md`, and existing improvement documents.

## Current Baseline

PieCode already has a strong foundation:

- A unified agent loop with native and text tool modes.
- A detailed system prompt in `src/lib/prompt.js` covering progress updates, validation, worktree safety, long task loops, memory, skills, plugins, MCP, and project instructions.
- Tool definitions in `src/lib/prompt.js` and implementations in `src/lib/tools.js` for file IO, search, shell, git status/diff, tests, todo, memory, web search, subagents, collaboration, and MCP.
- Turn orchestration in `src/lib/turnEngine.js` with pre-planning, replanning, parallel safe tool batches, tool budgets, plan mode, and native tool support.
- CLI/TUI/Web surfaces that share the same agent backend.

The next stage should therefore avoid broad rewrites. It should tighten behavior, reduce prompt/tool ambiguity, and add explicit contracts/tests around high-value workflows.

## Acceptance Criteria for This Stage

A next-stage implementation is successful when:

1. Prompt behavior is modular enough that prompt sections can be tested, audited, and iterated independently.
2. The agent has clearer stage-specific contracts for discovery, implementation, validation, review, and final handoff.
3. Tool definitions and tool implementations stay synchronized through automated checks.
4. The model receives stronger guidance for choosing safe native tools instead of shell fallbacks.
5. The user-visible prompt experience is consistent across CLI, TUI, and Web.
6. The stage has measurable regression tests and a small manual smoke checklist.

## Stage 1 — System Prompt Architecture

### 1.1 Split prompt construction into named sections

**Problem:** `buildSystemPrompt()` is comprehensive but monolithic, making it hard to test exact behavior and easy to introduce duplicated or conflicting rules.

**Plan:**

- Keep public API compatibility for `buildSystemPrompt()`.
- Internally split prompt sections into small builders:
  - `renderCoreIdentitySection()`
  - `renderSafetyAndWorktreeSection()`
  - `renderProgressContractSection()`
  - `renderComplexTaskSection()`
  - `renderLongTaskLoopSection()`
  - `renderToolUseSection()`
  - `renderNativeProgressSection()`
  - existing dynamic sections for skills, plugins, agents, memory, project instructions, active plans, and turn policies.
- Add tests that assert key invariants instead of entire prompt snapshots.

**Acceptance checks:**

- `__tests__/prompt.test.js` covers each named section's presence through `buildSystemPrompt()`.
- No user-facing behavior changes unless explicitly tested.
- `npm test -- --runInBand __tests__/prompt.test.js` passes.

### 1.2 Add mode-aware prompt contracts

**Problem:** PieCode already supports different implicit modes: one-shot, interactive, plan-only, goal mode, subagent, review, and web. Today, most guidance is global.

**Plan:**

- Add a lightweight `mode` or `executionProfile` option to `buildSystemPrompt()`.
- Profiles should only add constraints; they should not bypass safety:
  - `default`: current behavior.
  - `plan`: read-only discovery and concrete plan output.
  - `goal`: acceptance checklist, evidence mapping, continue/complete/blocked status discipline.
  - `review`: findings-first, severity, evidence, no broad rewrites.
  - `subagent`: read-only investigation and concise return.
- Start by wiring only modes already represented in existing control flow, avoiding large routing changes.

**Acceptance checks:**

- Prompt tests verify each mode adds the intended contract.
- Goal mode no longer relies solely on a user-message wrapper for critical completion discipline.
- Existing goal tests still pass.

### 1.3 Reduce duplicated tool-format instructions

**Problem:** Tool lists and response-format details exist in prompt text, native tool definitions, and implementation maps. Drift risk increases as tools grow.

**Plan:**

- Derive text-mode tool names from the same source used by native tool definitions.
- Add a helper such as `getAvailableToolNames({ mcpEnabled })`.
- Keep the hand-written short tool categories, but avoid duplicating the exhaustive list manually.

**Acceptance checks:**

- A test compares text-mode prompt tool names with `buildToolDefinitions()` names.
- Adding a tool in one place fails tests if prompt exposure is missing.

## Stage 2 — Prompt Experience / Persona (PE)

### 2.1 Define a stable PieCode interaction style

**Problem:** The prompt contains good guidance, but the product voice is scattered across CLI/TUI/Web rendering and final-answer behavior.

**Plan:**

- Add a concise product-level PE contract:
  - concise, operational, evidence-first;
  - progress updates before and after non-trivial tool use;
  - final answer starts with outcome, then changed files/findings, validation, risks;
  - no hidden reasoning or raw internal JSON in user-visible text.
- Make this contract a named prompt section and mirror it in docs.

**Acceptance checks:**

- Prompt tests assert final-answer structure guidance exists.
- README or docs include the same high-level user experience contract.

### 2.2 Make handoff and acceptance checklists first-class for long tasks

**Problem:** Goal mode adds strong acceptance requirements at the user-message level, but ordinary long tasks can still end with weak evidence mapping.

**Plan:**

- Add an optional `handoffChecklist` prompt section for complex tasks and goal mode.
- Encourage mapping requirements to evidence when work is non-trivial:
  - requested deliverable;
  - files changed or inspected;
  - validation run;
  - unresolved risks.
- In TUI/Web, continue showing compact progress rather than dumping the full checklist during execution.

**Acceptance checks:**

- Goal mode tests verify status line and evidence checklist behavior.
- A prompt test verifies the checklist is included only when appropriate.

### 2.3 Improve prompt ergonomics for model switching and auth state

**Problem:** Provider and tool capability state matters: Codex CLI fallback disables native tools; web now refreshes provider auth before turns. The agent should be prompted to understand capability differences.

**Plan:**

- Add a small provider capability summary to the prompt or turn policy when useful:
  - native tools enabled/disabled;
  - MCP enabled/disabled;
  - active skills/plugins count;
  - plan mode status.
- Keep secrets out of the prompt.

**Acceptance checks:**

- Tests verify capability labels do not include API keys/tokens.
- Web and CLI snapshots remain user-safe.

## Stage 3 — Tool Layer Reliability

### 3.1 Create a single tool registry source of truth

**Problem:** Tool implementations live in `src/lib/tools.js`, while schema definitions live in `src/lib/prompt.js`. This is manageable now but increasingly error-prone.

**Plan:**

- Introduce a registry module such as `src/lib/toolRegistry.js` with:
  - tool name;
  - description;
  - input schema;
  - category;
  - safety class metadata;
  - native-tool exposure flag.
- Have `buildToolDefinitions()` consume registry metadata.
- Keep actual execution in `createToolset()` initially to minimize risk.
- Add a test that all executable tools have registry metadata and all registry tools are implemented or explicitly virtual/MCP.

**Acceptance checks:**

- `__tests__/tools.test.js` or a new registry test catches metadata/implementation drift.
- No tool schemas disappear from native mode.

### 3.2 Add focused high-value native tools instead of expanding shell use

**Recommended tools:**

1. `git_log`
   - Inputs: `{ max_count?: number, path?: string }`
   - Read-only, no shell approval.
   - Useful for code archaeology and release notes.

2. `git_show`
   - Inputs: `{ ref: string, path?: string }`
   - Read-only commit/file inspection.

3. `package_scripts`
   - Inputs: `{ path?: string }`
   - Reads `package.json` and lists scripts without running them.
   - Helps the agent choose test/lint/build commands.

4. `json_read`
   - Inputs: `{ path: string, pointer?: string }`
   - Safe structured JSON inspection for settings/package files.

5. `file_stats`
   - Inputs: `{ path?: string, pattern?: string }`
   - Counts files/lines by extension within caps for planning/refactor scoping.

**Deferred / caution:**

- `npm_install` should remain explicit and approval-gated; it changes external dependency state.
- `curl`/`wget` should not be broadly safe because they touch network and can write files.
- Broad AST analysis should wait until there is a concrete workflow requiring it.

**Acceptance checks:**

- Each new tool has implementation, schema, docs, and tests.
- Shell classifier tests confirm the agent is encouraged away from shell for equivalent read-only tasks.

### 3.3 Strengthen tool-result contracts

**Problem:** Tool results vary between plain text and structured JSON. The UI already summarizes some results, but the model also benefits from consistent result shapes.

**Plan:**

- Prefer structured JSON for new tools.
- Gradually normalize existing read-only tool outputs where safe:
  - keep human-readable fallback;
  - include `ok`, `type`, `items`, `truncated`, and `summary` fields for new tools.
- Add max-result and truncation metadata consistently.

**Acceptance checks:**

- Tests verify oversized outputs include truncation metadata.
- Web tool summaries still render compactly.

## Stage 4 — Planning and Review Intelligence

### 4.1 Make planning evidence-aware

**Problem:** Pre-plans can be useful, but they can also be generic. PieCode should explicitly prefer repository evidence before implementation.

**Plan:**

- Adjust planning prompt in `src/lib/turnEngine.js` to distinguish:
  - discovery plan;
  - implementation plan;
  - validation plan.
- Encourage read/search before edit for code tasks.
- Replan only when evidence invalidates the plan or budget is insufficient.

**Acceptance checks:**

- Planner tests assert generated/parsed plan structure includes discovery and validation when relevant.
- Existing task-planner tests remain green.

### 4.2 Add review-specific workflow support

**Problem:** Project agents already include specialized reviewers, but review behavior could be better surfaced.

**Plan:**

- Add a `/review` workflow command or skill/plugin-backed command that invokes review coordinator agents on current diff or selected paths.
- Output findings first, grouped by severity, with file/line evidence when available.
- Keep it read-only unless user asks to fix findings.

**Acceptance checks:**

- Command is discoverable in CLI and Web if implemented.
- Tests verify it does not mutate files by default.

## Stage 5 — Documentation and Measurement

### 5.1 Replace stale improvement plans with a current roadmap

**Problem:** Existing improvement docs mention features that are already implemented, such as git/search tools, MCP, plugins, subagents, and session persistence.

**Plan:**

- Keep this file as the current next-stage roadmap.
- Optionally archive or annotate older plans as historical.
- Add a short `docs/ARCHITECTURE.md` focused on prompt/tool/turn architecture.

**Acceptance checks:**

- README links to the current roadmap if this becomes the accepted planning artifact.
- Stale roadmap items are either updated or marked historical.

### 5.2 Define regression gates

Recommended gates for changes in this plan:

```bash
npm test -- --runInBand __tests__/prompt.test.js __tests__/tools.test.js __tests__/taskPlanner.test.js
npm test -- --runInBand
npm run lint
```

Manual smoke checks:

- `piecode --prompt "what tools do you have?"`
- `piecode --prompt "inspect this repo and suggest next steps"`
- Web UI: `/model`, `/plugins`, a normal message, and an approval-gated shell command.
- TUI: one prompt that reads/searches files and one prompt that edits then validates.

## Recommended Implementation Order

1. Prompt section refactor with invariant tests.
2. Tool registry metadata and drift tests.
3. Add `package_scripts`, `git_log`, and `git_show` as low-risk read-only tools.
4. Add mode-aware prompt contracts for plan/goal/review/subagent.
5. Add review workflow command using existing project agents.
6. Update README/docs and archive stale roadmap items.

## Risks and Mitigations

- **Risk:** Prompt refactor changes model behavior unintentionally.
  - **Mitigation:** Preserve exact wording initially; test key invariants rather than broad snapshots.

- **Risk:** Tool registry introduces churn.
  - **Mitigation:** Start metadata-only and keep execution in `createToolset()` until stable.

- **Risk:** More prompt guidance increases token usage.
  - **Mitigation:** Use mode-specific sections so only relevant guidance is included.

- **Risk:** New tools duplicate shell capabilities.
  - **Mitigation:** Focus on read-only, structured tools that reduce shell approval friction.

## Prompt-to-Artifact Checklist

| Requirement / deliverable | Evidence in this plan |
| --- | --- |
| Next-stage plan for PieCode | Entire document, especially Recommended Implementation Order |
| System prompt direction | Stage 1 and Stage 2 |
| PE/persona direction | Stage 2 |
| Tool direction | Stage 3 |
| Repository-context based | Current Baseline cites inspected files and existing features |
| Acceptance criteria | Acceptance Criteria for This Stage plus per-stage acceptance checks |
| Validation guidance | Stage 5.2 regression gates and smoke checks |
| Risk assessment | Risks and Mitigations |

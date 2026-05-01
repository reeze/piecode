# PieCode Optimization Report

Date: 2026-03-22
Workspace: `/Users/reeze/Projects/piecode`

## Scope

This optimization pass focused on code structure, execution safety, avoidable runtime overhead, and low-risk fixes that could be applied automatically.

## Findings

### 1. Experimental planner generated fragile shell-heavy plans

Problem:
- `src/lib/taskPlanner.js` relied on shell pipelines such as `git status && git diff`, `find ... | head`, and `grep -r ... | head`.
- These plans were inconsistent with PieCode's own shell classifier and approval model, so the planner could generate steps that were later blocked or required approval.
- Some plan steps also pointed at the wrong paths, for example `test/` instead of `__tests__/`.

Fix applied:
- Reworked planner steps to prefer native tools such as `git_status`, `git_diff`, `list_files`, `glob_files`, `find_files`, `search_files`, and `run_tests`.
- Updated the testing plan to inspect `__tests__/`.
- Simplified the executor so it dispatches through the shared tool registry instead of hardcoding a small subset of tools.

Impact:
- Better safety alignment.
- Fewer approval traps in planned execution.
- Better compatibility with the rest of the agent toolchain.

### 2. Repeated system prompt reconstruction in agent loop

Problem:
- `src/lib/agent.js` rebuilt the full system prompt on every identical turn iteration.
- In multi-tool turns this is unnecessary overhead.

Fix applied:
- Added a small prompt cache in `Agent` keyed by the normalized prompt inputs.
- Capped the cache size to avoid unbounded growth.

Impact:
- Lower per-iteration overhead for repeated prompt builds in the same session.
- No behavior change for prompt content.

### 3. Missing coverage around planner execution path

Problem:
- Planner behavior changes were not covered by dedicated tests.

Fix applied:
- Added `__tests__/taskPlanner.test.js`.
- Added an agent test covering prompt cache reuse.

Impact:
- Better regression protection for the planner and prompt cache path.

## Files Changed

- `src/lib/taskPlanner.js`
- `src/lib/agent.js`
- `__tests__/agent.test.js`
- `__tests__/taskPlanner.test.js`

## Validation

Completed:
- `node --input-type=module -e "import('./src/lib/agent.js'); import('./src/lib/taskPlanner.js'); import('./src/lib/tools.js'); import('./src/lib/providers.js');"`
- `git diff --check`

Blocked:
- `npm test -- --runInBand ...`
- `npm run lint`

Reason:
- Dependencies are not installed in the current workspace. `node_modules/jest/bin/jest.js` and `node_modules/eslint/bin/eslint.js` are missing.

## Recommended Next Step

Run `npm install`, then execute:
- `npm test -- --runInBand`
- `npm run lint`

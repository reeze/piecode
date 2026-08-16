# Long-horizon tasks

A long agent run rarely fails because the model forgot how to code. It fails
because the plan, the decisions already made, and the evidence already gathered
lived only in a conversation history that got truncated or compacted away — and
the agent then redoes finished work, re-litigates settled decisions, or declares
victory on something it never verified.

piecode keeps that state outside the transcript.

## The task ledger

The ledger is an explicit artifact at
`<workspace>/.piecode/state/ledger.json`, re-injected into the system prompt on
every turn. It survives compaction, `/clear`, a crash, and a resumed session.

It holds:

| Field | Meaning |
| --- | --- |
| `objective` | What this run set out to do |
| `acceptance` | Concrete acceptance criteria |
| `todos` | The plan, with `pending` / `in_progress` / `completed` |
| `decisions` | Choices already made, so they are not re-litigated |
| `changedFiles` | Files this run has actually modified |
| `validations` | Commands run as verification, and whether they passed |
| `blockers` | What is in the way |
| `nextStep` | The single next action |
| `turnCount` | Turns spent on this objective |

### How it stays current

Most of it is derived from what actually happened, not from asking the model to
maintain bookkeeping:

- The first substantive request of a run becomes the `objective`.
- `todo_write` carries the plan straight into `todos`.
- A successful `write_file` / `edit_file` / `apply_patch` / `replace_in_files`
  appends to `changedFiles`.
- A validation-shaped shell command (`test`, `lint`, `tsc`, `build`, …) records
  the command and whether it passed or failed.

Partial updates merge, so nothing is erased by a later write, and repeated
entries deduplicate. A no-op update neither mutates state nor triggers a write.

Updating the ledger invalidates the cached system prompt, so the model always
sees the current state rather than a stale copy.

### Inspecting and resetting

```
/ledger          # objective, todos, decisions, changed files, evidence, next step
/ledger clear    # reset durable task state
```

The file is plain JSON — safe to read, diff, or delete by hand.

### Subagents

A subagent receives a read-only snapshot of the parent ledger in its prompt, so
it inherits context without being able to corrupt the parent's state.

## How this fits with the rest of the loop

The ledger complements, rather than replaces, the mechanisms already present:

- **Context compaction** (`/compact`, and automatic compaction at
  `PIECODE_AUTO_COMPACT_THRESHOLD`, default 80% of the context window) summarizes
  older turns. The ledger is injected independently of history, so compaction
  cannot lose the plan or the evidence.
- **Memory** (`.piecode/MEMORY.md`) is for durable facts that outlive a task —
  project conventions, user preferences. The ledger is for the current task and
  is meant to be cleared when it is done.
- **Goal mode** (`/goal`) drives a multi-turn loop toward an acceptance
  checklist. The ledger is what that loop reads and writes between turns.

## Tuning

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PIECODE_AUTO_COMPACT_THRESHOLD` | `0.8` | Fraction of the context window that triggers compaction |
| `PIECODE_AUTO_COMPACT_KEEP` | `12` | Recent messages preserved verbatim when compacting |
| `PIECODE_TOOL_BUDGET` | `6` | Tool calls before the agent reconsiders its plan |
| `PIECODE_GOAL_MAX_TURNS` | `50` | Turn ceiling for goal mode |

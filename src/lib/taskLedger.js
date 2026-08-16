/**
 * Durable working state for long-horizon tasks.
 *
 * The failure mode of a long agent run is not the model — it is that the plan,
 * the decisions already made, and the evidence already gathered live only in a
 * conversation history that gets truncated or compacted away. The ledger keeps
 * that state as an explicit artifact on disk, re-injected into the system
 * prompt on every turn, so a session can lose its transcript and still know
 * what it is doing and what it has already proven.
 *
 * Stored at `<workspace>/.piecode/state/ledger.json`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const LEDGER_DIR = ['.piecode', 'state'];
const LEDGER_FILE = 'ledger.json';
const MAX_ENTRIES = 40;
const MAX_TEXT = 400;

const VALID_TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);

function clip(value, max = MAX_TEXT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function uniqueTail(list, max = MAX_ENTRIES) {
  const seen = new Set();
  const out = [];
  for (const item of [...list].reverse()) {
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out.reverse();
}

export function createEmptyLedger() {
  return {
    version: 1,
    objective: '',
    acceptance: [],
    todos: [],
    decisions: [],
    changedFiles: [],
    validations: [],
    blockers: [],
    nextStep: '',
    turnCount: 0,
    updatedAt: '',
  };
}

function normalizeLedger(raw) {
  const base = createEmptyLedger();
  if (!raw || typeof raw !== 'object') return base;
  const asArray = (value) => (Array.isArray(value) ? value : []);
  return {
    ...base,
    objective: clip(raw.objective, 600),
    acceptance: uniqueTail(asArray(raw.acceptance).map((item) => clip(item)).filter(Boolean), 20),
    todos: asArray(raw.todos)
      .map((todo) => ({
        content: clip(todo?.content ?? todo?.text ?? todo),
        status: VALID_TODO_STATUS.has(String(todo?.status || '').toLowerCase())
          ? String(todo.status).toLowerCase()
          : 'pending',
      }))
      .filter((todo) => todo.content)
      .slice(0, MAX_ENTRIES),
    decisions: uniqueTail(asArray(raw.decisions).map((item) => clip(item)).filter(Boolean)),
    changedFiles: uniqueTail(asArray(raw.changedFiles).map((item) => clip(item, 200)).filter(Boolean)),
    validations: uniqueTail(
      asArray(raw.validations)
        .map((item) =>
          typeof item === 'string'
            ? { command: clip(item, 200), result: '' }
            : { command: clip(item?.command, 200), result: clip(item?.result, 200) }
        )
        .filter((item) => item.command),
      20
    ),
    blockers: uniqueTail(asArray(raw.blockers).map((item) => clip(item)).filter(Boolean), 20),
    nextStep: clip(raw.nextStep, 600),
    turnCount: Number.isFinite(Number(raw.turnCount)) ? Math.max(0, Math.round(Number(raw.turnCount))) : 0,
    updatedAt: String(raw.updatedAt || ''),
  };
}

export function getLedgerPath(workspaceDir) {
  return path.join(workspaceDir, ...LEDGER_DIR, LEDGER_FILE);
}

export async function loadLedger(workspaceDir) {
  try {
    const text = await fs.readFile(getLedgerPath(workspaceDir), 'utf8');
    return normalizeLedger(JSON.parse(text));
  } catch {
    return createEmptyLedger();
  }
}

export async function saveLedger(workspaceDir, ledger, { now = new Date() } = {}) {
  const normalized = normalizeLedger(ledger);
  normalized.updatedAt = now.toISOString();
  const target = getLedgerPath(workspaceDir);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return { ok: true, path: target, ledger: normalized };
  } catch (err) {
    return { ok: false, path: target, error: String(err?.message || err), ledger: normalized };
  }
}

export async function clearLedger(workspaceDir) {
  try {
    await fs.rm(getLedgerPath(workspaceDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Is there anything worth showing or persisting? */
export function isLedgerEmpty(ledger) {
  if (!ledger) return true;
  return (
    !ledger.objective &&
    !ledger.nextStep &&
    (ledger.todos?.length || 0) === 0 &&
    (ledger.decisions?.length || 0) === 0 &&
    (ledger.changedFiles?.length || 0) === 0 &&
    (ledger.validations?.length || 0) === 0 &&
    (ledger.blockers?.length || 0) === 0
  );
}

/**
 * Fold an update into a ledger. Arrays append-and-dedupe; scalars replace when
 * a non-empty value is supplied, so a partial update never erases state.
 */
export function applyLedgerUpdate(ledger, update = {}) {
  const base = normalizeLedger(ledger);
  const next = { ...base };

  if (typeof update.objective === 'string' && update.objective.trim()) {
    next.objective = clip(update.objective, 600);
  }
  if (typeof update.nextStep === 'string' && update.nextStep.trim()) {
    next.nextStep = clip(update.nextStep, 600);
  }
  if (Array.isArray(update.todos)) {
    next.todos = normalizeLedger({ todos: update.todos }).todos;
  }
  for (const key of ['acceptance', 'decisions', 'blockers']) {
    if (!Array.isArray(update[key])) continue;
    next[key] = uniqueTail(
      [...base[key], ...update[key].map((item) => clip(item)).filter(Boolean)],
      key === 'decisions' ? MAX_ENTRIES : 20
    );
  }
  if (Array.isArray(update.changedFiles)) {
    next.changedFiles = uniqueTail(
      [...base.changedFiles, ...update.changedFiles.map((item) => clip(item, 200)).filter(Boolean)],
      MAX_ENTRIES
    );
  }
  if (Array.isArray(update.validations)) {
    next.validations = normalizeLedger({
      validations: [...base.validations, ...update.validations],
    }).validations;
  }
  if (Number.isFinite(Number(update.turnCount))) {
    next.turnCount = Math.max(0, Math.round(Number(update.turnCount)));
  } else if (update.incrementTurn) {
    next.turnCount = base.turnCount + 1;
  }
  return next;
}

/**
 * Derive ledger updates from a completed tool call, so the ledger stays current
 * without asking the model to maintain it by hand.
 */
export function deriveLedgerUpdateFromTool({ tool, input = {}, result = '', error = null } = {}) {
  const name = String(tool || '').toLowerCase();
  if (!name) return null;

  if (name === 'todo_write' || name === 'todowrite') {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    return todos.length > 0 ? { todos } : null;
  }

  if (!error && ['write_file', 'edit_file', 'apply_patch', 'replace_in_files'].includes(name)) {
    const paths = [];
    for (const key of ['path', 'file', 'filePath', 'file_path']) {
      if (typeof input?.[key] === 'string' && input[key].trim()) paths.push(input[key].trim());
    }
    if (Array.isArray(input?.paths)) {
      for (const item of input.paths) {
        if (typeof item === 'string' && item.trim()) paths.push(item.trim());
      }
    }
    return paths.length > 0 ? { changedFiles: paths } : null;
  }

  if (name === 'run_tests' || name === 'shell') {
    const command = String(input?.command || input?.cmd || '').trim();
    if (!command) return null;
    // Only validation-shaped commands are worth remembering as evidence.
    if (!/\b(test|jest|vitest|pytest|lint|eslint|tsc|typecheck|build|cargo|go test|npm run)\b/.test(command)) {
      return null;
    }
    const output = String(result || '');
    const failed =
      Boolean(error) || /(\bfail(?:ed|ing|ure|s)?\b|\berrors?\b|✕|✗)/i.test(output.slice(0, 2000));
    return {
      validations: [{ command, result: error ? `error: ${error}` : failed ? 'failed' : 'passed' }],
    };
  }

  return null;
}

/**
 * Compact prompt section. Kept short on purpose: this is injected on every
 * turn, so it must be cheap enough to always afford.
 */
export function renderLedgerForPrompt(ledger, { maxTodos = 12, maxItems = 6 } = {}) {
  const normalized = normalizeLedger(ledger);
  if (isLedgerEmpty(normalized)) return '';

  const lines = ['TASK LEDGER (durable working state; survives context compaction):'];
  if (normalized.objective) lines.push(`- objective: ${normalized.objective}`);
  if (normalized.acceptance.length > 0) {
    lines.push('- acceptance:');
    for (const item of normalized.acceptance.slice(0, maxItems)) lines.push(`  - ${item}`);
  }
  if (normalized.todos.length > 0) {
    const done = normalized.todos.filter((t) => t.status === 'completed').length;
    lines.push(`- todos (${done}/${normalized.todos.length} done):`);
    const mark = (status) => (status === 'completed' ? 'x' : status === 'in_progress' ? '~' : ' ');
    // Open items matter more than finished ones when the list is long.
    const ordered = [
      ...normalized.todos.filter((t) => t.status !== 'completed'),
      ...normalized.todos.filter((t) => t.status === 'completed'),
    ];
    for (const todo of ordered.slice(0, maxTodos)) lines.push(`  [${mark(todo.status)}] ${todo.content}`);
  }
  if (normalized.decisions.length > 0) {
    lines.push('- decisions:');
    for (const item of normalized.decisions.slice(-maxItems)) lines.push(`  - ${item}`);
  }
  if (normalized.changedFiles.length > 0) {
    lines.push(`- changed files: ${normalized.changedFiles.slice(-maxItems * 2).join(', ')}`);
  }
  if (normalized.validations.length > 0) {
    lines.push('- validation evidence:');
    for (const item of normalized.validations.slice(-maxItems)) {
      lines.push(`  - ${item.command}${item.result ? ` → ${item.result}` : ''}`);
    }
  }
  if (normalized.blockers.length > 0) {
    lines.push('- blockers:');
    for (const item of normalized.blockers.slice(-maxItems)) lines.push(`  - ${item}`);
  }
  if (normalized.nextStep) lines.push(`- next step: ${normalized.nextStep}`);
  lines.push('Trust this ledger over older conversation turns when they disagree.');
  return lines.join('\n');
}

/** Multi-line view for `/ledger`. */
export function formatLedgerForDisplay(ledger) {
  const normalized = normalizeLedger(ledger);
  if (isLedgerEmpty(normalized)) return ['task ledger: empty'];
  const lines = ['task ledger'];
  if (normalized.objective) lines.push(`  objective: ${normalized.objective}`);
  if (normalized.todos.length > 0) {
    const done = normalized.todos.filter((t) => t.status === 'completed').length;
    lines.push(`  todos: ${done}/${normalized.todos.length} done`);
    for (const todo of normalized.todos) {
      const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' ';
      lines.push(`    [${mark}] ${todo.content}`);
    }
  }
  for (const [label, items] of [
    ['decisions', normalized.decisions],
    ['changed files', normalized.changedFiles],
    ['blockers', normalized.blockers],
  ]) {
    if (items.length === 0) continue;
    lines.push(`  ${label}:`);
    for (const item of items.slice(-10)) lines.push(`    - ${item}`);
  }
  if (normalized.validations.length > 0) {
    lines.push('  validation:');
    for (const item of normalized.validations.slice(-10)) {
      lines.push(`    - ${item.command}${item.result ? ` → ${item.result}` : ''}`);
    }
  }
  if (normalized.nextStep) lines.push(`  next step: ${normalized.nextStep}`);
  if (normalized.updatedAt) lines.push(`  updated: ${normalized.updatedAt}`);
  return lines;
}

export { normalizeLedger };

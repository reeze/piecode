/**
 * Presentation helpers for provider/model status.
 *
 * Kept free of terminal and process state so both the TUI and the web UI can
 * render the same information, and so the formatting is directly testable.
 */

import process from 'node:process';
import {
  buildModelCatalog,
  describeProviderSetup,
  describeProviderStatuses,
  formatModelRef,
  getProviderSpec,
  normalizeProviderId,
  parseModelRef,
} from './modelCatalog.js';

const CHECK = '✓';
const CROSS = '·';

export function formatContextTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function padEnd(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * One line per provider: readiness, active marker, endpoint/model, setup hint.
 */
export function formatProviderTable({
  settings = {},
  env = process.env,
  activeProviderId = '',
  includeUnconfigured = true,
} = {}) {
  const active = normalizeProviderId(activeProviderId);
  const rows = describeProviderStatuses({ settings, env }).filter(
    (row) => includeUnconfigured || row.configured
  );
  if (rows.length === 0) return ['no providers available'];

  const idWidth = Math.max(...rows.map((row) => row.id.length), 8);
  const labelWidth = Math.max(...rows.map((row) => row.label.length), 10);

  const lines = [];
  for (const row of rows) {
    const marker = row.id === active ? '>' : ' ';
    const state = row.configured ? CHECK : CROSS;
    const detail = row.configured
      ? [row.source ? `via ${row.source}` : '', row.model ? `model ${row.model}` : '']
          .filter(Boolean)
          .join(', ')
      : row.setupHint;
    const tags = [row.local ? 'local' : '', row.aggregator ? 'aggregator' : ''].filter(Boolean).join(',');
    lines.push(
      `${marker} ${state} ${padEnd(row.id, idWidth)}  ${padEnd(row.label, labelWidth)}  ${
        tags ? `[${tags}] ` : ''
      }${detail}`
    );
  }
  const ready = rows.filter((row) => row.configured).length;
  lines.push('');
  lines.push(`${ready}/${rows.length} providers ready  ·  ${CHECK} ready  ${CROSS} needs setup  > active`);
  return lines;
}

/**
 * Grouped model listing: provider header, then its models with context size and
 * capability tags. `refs` limits the listing to a specific catalog.
 */
export function formatModelCatalogLines({
  settings = {},
  env = process.env,
  refs = null,
  activeRef = '',
  includeUnconfigured = false,
  limitPerProvider = 12,
} = {}) {
  const catalog = buildModelCatalog({ settings, env, includeUnconfigured: true });
  const byRef = new Map(catalog.map((row) => [row.ref, row]));

  const wanted = Array.isArray(refs) && refs.length > 0 ? refs : catalog.map((row) => row.ref);
  const active = String(activeRef || '').trim();

  const grouped = new Map();
  for (const ref of wanted) {
    const known = byRef.get(ref);
    const parsed = parseModelRef(ref);
    const provider = known?.provider || parsed.provider || '';
    const row = known || {
      ref,
      id: parsed.model || ref,
      provider,
      context: 0,
      tags: [],
      available: true,
    };
    if (!includeUnconfigured && !row.available) continue;
    if (!grouped.has(provider)) grouped.set(provider, []);
    const bucket = grouped.get(provider);
    if (!bucket.some((item) => item.ref === row.ref)) bucket.push(row);
  }

  const lines = [];
  for (const [provider, rows] of grouped) {
    const spec = getProviderSpec(provider);
    const label = spec ? `${spec.label} (${provider})` : provider || 'other';
    const shown = rows.slice(0, Math.max(1, limitPerProvider));
    lines.push(`${label}${rows.length > shown.length ? `  — showing ${shown.length}/${rows.length}` : ''}`);
    for (const row of shown) {
      const marker = row.ref === active || row.id === active ? '>' : ' ';
      const context = formatContextTokens(row.context);
      const meta = [context ? `${context} ctx` : '', ...(row.tags || []).filter((t) => t !== 'discovered')]
        .filter(Boolean)
        .join(' · ');
      lines.push(`${marker} ${row.ref}${meta ? `   ${meta}` : ''}`);
    }
    lines.push('');
  }
  if (lines.length === 0) {
    return ['no models available — run /provider to see how to configure one'];
  }
  return lines;
}

/**
 * Short annotation for one picker row, e.g. "200k ctx · coding".
 */
export function describeModelRef(ref, { catalog = null } = {}) {
  const rows = catalog || buildModelCatalog({ includeUnconfigured: true });
  const raw = String(ref || '').trim();
  const row = rows.find((item) => item.ref === raw || item.id === raw);
  if (!row) return '';
  const context = formatContextTokens(row.context);
  return [context ? `${context} ctx` : '', ...(row.tags || []).filter((t) => t !== 'discovered' && t !== 'user')]
    .filter(Boolean)
    .join(' · ');
}

/**
 * First-run screen for a machine with nothing configured. Shows a short path to
 * a working setup rather than a stack trace.
 */
export function formatOnboardingLines({ settings = {}, env = process.env, settingsFile = '' } = {}) {
  const statuses = describeProviderStatuses({ settings, env });
  const ready = statuses.filter((row) => row.configured);

  const lines = ['piecode has no model provider configured yet.', ''];

  if (ready.length > 0) {
    // Reachable when a provider is ready but the requested model is not usable.
    lines.push('Ready providers:');
    for (const row of ready) lines.push(`  ${CHECK} ${row.id} — ${row.source || 'available'}`);
    lines.push('');
    lines.push('Pick one with: piecode --provider <id>');
    return lines;
  }

  lines.push('Pick one of these and set its key, then run piecode again:');
  lines.push('');
  const highlights = ['anthropic', 'openai', 'deepseek', 'moonshot', 'zhipu', 'openrouter'];
  for (const id of highlights) {
    const spec = getProviderSpec(id);
    if (!spec) continue;
    const envName = spec.apiKeyEnv?.[0] || '';
    lines.push(`  export ${padEnd(`${envName}="..."`, 26)} # ${spec.label}`);
  }
  lines.push('');
  lines.push('Or use a login / local runtime instead of a key:');
  lines.push('  codex login                                  # Codex, via ~/.codex');
  lines.push('  export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"   # Ollama');
  lines.push('');
  lines.push(`Settings file: ${settingsFile || '~/.piecode/settings.json'}`);
  lines.push('Full list:     piecode --list-providers');
  lines.push('Diagnose:      piecode --doctor');
  return lines;
}

/**
 * Environment health check: which providers are ready, what is missing, and the
 * exact next action for each problem.
 */
export function buildDoctorReport({
  settings = {},
  env = process.env,
  activeProvider = null,
  workspaceDir = '',
  settingsFile = '',
  extraChecks = [],
} = {}) {
  const lines = [];
  const problems = [];

  lines.push('piecode doctor');
  lines.push('');

  const nodeMajor = Number.parseInt(String(process.versions?.node || '0').split('.')[0], 10) || 0;
  const nodeOk = nodeMajor >= 22;
  lines.push(`${nodeOk ? CHECK : CROSS} node ${process.versions?.node || 'unknown'}${nodeOk ? '' : ' (requires >= 22)'}`);
  if (!nodeOk) problems.push('Upgrade Node.js to 22 or newer.');

  if (workspaceDir) lines.push(`${CHECK} workspace ${workspaceDir}`);
  if (settingsFile) lines.push(`${CHECK} settings ${settingsFile}`);

  lines.push('');
  lines.push('providers');
  const statuses = describeProviderStatuses({ settings, env });
  const ready = statuses.filter((row) => row.configured);
  for (const row of statuses) {
    const state = row.configured ? CHECK : CROSS;
    const detail = row.configured ? row.source || 'available' : row.setupHint;
    lines.push(`  ${state} ${row.id} — ${detail}`);
  }
  if (ready.length === 0) {
    problems.push(
      'No provider is configured. Set one API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY) or run `codex login`.'
    );
  }

  lines.push('');
  lines.push('active model');
  if (activeProvider?.model) {
    const providerId = normalizeProviderId(activeProvider.providerId || '');
    const ref = providerId ? formatModelRef({ provider: providerId, model: activeProvider.model }) : activeProvider.model;
    lines.push(`  ${CHECK} ${ref}  (${activeProvider.kind || 'unknown transport'})`);
    if (activeProvider.supportsNativeTools === false) {
      lines.push('  ! this transport has no native tool calling — piecode falls back to text protocol');
    }
  } else {
    lines.push(`  ${CROSS} none resolved`);
    problems.push('No active model. Run `/model` to pick one.');
  }

  // Doctor stays offline, so this counts the curated catalog only; providers
  // that serve models the registry has not seen are queried by --list-models.
  const models = buildModelCatalog({ settings, env });
  lines.push('');
  lines.push(
    `curated models for ready providers: ${models.length}  (run \`piecode --list-models\` to query providers directly)`
  );

  for (const check of Array.isArray(extraChecks) ? extraChecks : []) {
    if (!check || typeof check !== 'object') continue;
    const state = check.ok ? CHECK : CROSS;
    lines.push(`${state} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
    if (!check.ok && check.fix) problems.push(check.fix);
  }

  if (problems.length > 0) {
    lines.push('');
    lines.push('next steps');
    for (const problem of problems) lines.push(`  - ${problem}`);
  } else {
    lines.push('');
    lines.push('no problems found');
  }

  return { lines, problems, ready: ready.map((row) => row.id) };
}

export { describeProviderSetup };

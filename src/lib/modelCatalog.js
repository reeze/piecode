/**
 * Central registry for model providers and models.
 *
 * Everything that needs to know "which providers exist", "how do I authenticate
 * against one", "which models can I offer the user" or "what does this model
 * support" reads from here instead of hard-coding strings.
 *
 * The registry has three layers, merged in this order (later wins):
 *   1. Built-in provider specs + a curated seed catalog (works offline).
 *   2. `~/.piecode/models.json` (user overrides, no code changes needed).
 *   3. Live `/models` discovery per provider (best effort, never blocks).
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function codexHomeDir(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Is an executable named `name` on PATH? Cheap: no subprocess is spawned. */
function hasExecutableOnPath(name, env = process.env) {
  const raw = env.PATH || env.Path || '';
  if (!raw) return false;
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      try {
        if (existsSync(path.join(dir, `${name}${suffix}`))) return true;
      } catch {
        // Unreadable PATH entries are simply skipped.
      }
    }
  }
  return false;
}

/**
 * Cheap, side-effect-free check for a usable Codex setup: stored login state,
 * or the `codex` CLI on PATH (which manages its own session).
 */
function hasCodexCredentials(env = process.env) {
  try {
    if (existsSync(path.join(codexHomeDir(env), 'auth.json'))) return true;
  } catch {
    // Fall through to the PATH probe.
  }
  return hasExecutableOnPath('codex', env);
}

/** A locally configured Codex endpoint declared in ~/.codex/config.toml. */
function hasCodexLocalEndpoint(env = process.env) {
  try {
    const text = readFileSync(path.join(codexHomeDir(env), 'config.toml'), 'utf8');
    return /^\s*\[model_providers\./m.test(text) && /^\s*base_url\s*=\s*"http/m.test(text);
  } catch {
    return false;
  }
}

/** Transport dialects a provider can speak. */
export const TRANSPORTS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  RESPONSES: 'responses',
  CODEX_CLI: 'codex-cli',
};

const REASONING_STANDARD = ['low', 'medium', 'high'];
const REASONING_EXTENDED = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Built-in provider specs.
 *
 * `apiKeyEnv` / `baseUrlEnv` / `modelEnv` are ordered: the first non-empty
 * environment variable wins. `settingsKeys` are alternative keys accepted under
 * `providers.<id>` in settings.json, on top of the canonical
 * `apiKey` / `endpoint` / `baseUrl` / `model`.
 */
const BUILT_IN_PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    vendor: 'Anthropic',
    transport: TRANSPORTS.ANTHROPIC,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    baseUrlEnv: ['ANTHROPIC_BASE_URL'],
    modelEnv: ['ANTHROPIC_MODEL'],
    defaultModel: 'claude-sonnet-4-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    discovery: { path: '/models', auth: 'x-api-key' },
    reasoning: { supported: false },
    supportsNativeTools: true,
    notes: 'Native Messages API with tool use.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: 'OpenAI',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY'],
    baseUrlEnv: ['OPENAI_BASE_URL'],
    modelEnv: ['OPENAI_MODEL'],
    defaultModel: 'gpt-4.1-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
    discovery: { path: '/models' },
    reasoning: { supported: true, values: REASONING_EXTENDED, reasoningModelsOnly: true },
    supportsNativeTools: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    transport: TRANSPORTS.RESPONSES,
    defaultBaseUrl: 'https://chatgpt.com/backend-api',
    apiKeyEnv: [],
    baseUrlEnv: ['PIECODE_CODEX_BASE_URL', 'CODEX_CHATGPT_BASE_URL', 'CODEX_BASE_URL'],
    modelEnv: ['CODEX_MODEL'],
    defaultModel: 'gpt-5.3-codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    reasoning: { supported: true, values: REASONING_EXTENDED },
    supportsNativeTools: true,
    authKind: 'codex-login',
    detectConfigured: hasCodexCredentials,
    notes: 'Uses `codex login` state in ~/.codex (no API key needed).',
  },
  {
    id: 'codex-local',
    label: 'Codex (local)',
    vendor: 'Local',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'http://127.0.0.1:1455/v1',
    apiKeyEnv: ['CODEX_LOCAL_API_KEY'],
    baseUrlEnv: ['CODEX_LOCAL_BASE_URL', 'PIECODE_CODEX_LOCAL_BASE_URL'],
    modelEnv: ['CODEX_LOCAL_MODEL'],
    defaultModel: 'gpt-oss:20b',
    docsUrl: 'https://developers.openai.com/codex/local',
    discovery: { path: '/models', optionalAuth: true },
    reasoning: { supported: true, values: REASONING_STANDARD },
    supportsNativeTools: true,
    local: true,
    optionalApiKey: true,
    detectConfigured: hasCodexLocalEndpoint,
    notes: 'Any OpenAI-compatible server Codex is pointed at (codex --oss, vLLM, LM Studio).',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    vendor: 'OpenRouter',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    baseUrlEnv: ['OPENROUTER_BASE_URL'],
    modelEnv: ['OPENROUTER_MODEL'],
    defaultModel: 'anthropic/claude-sonnet-4.5',
    docsUrl: 'https://openrouter.ai/keys',
    discovery: { path: '/models', optionalAuth: true },
    reasoning: { supported: true, values: REASONING_EXTENDED, reasoningModelsOnly: true },
    supportsNativeTools: true,
    aggregator: true,
    notes: 'Aggregator: model ids are `vendor/model`.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: 'DeepSeek',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    baseUrlEnv: ['DEEPSEEK_BASE_URL'],
    modelEnv: ['DEEPSEEK_MODEL'],
    defaultModel: 'deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
    dropTemperature: false,
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    vendor: 'Moonshot AI',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    baseUrlEnv: ['MOONSHOT_BASE_URL', 'KIMI_BASE_URL'],
    modelEnv: ['MOONSHOT_MODEL'],
    defaultModel: 'kimi-k2-turbo-preview',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'zhipu',
    label: 'Z.ai (GLM)',
    vendor: 'Zhipu AI',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY'],
    baseUrlEnv: ['ZHIPU_BASE_URL', 'GLM_BASE_URL'],
    modelEnv: ['ZHIPU_MODEL', 'GLM_MODEL'],
    defaultModel: 'glm-4.6',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'dashscope',
    label: 'DashScope (Qwen)',
    vendor: 'Alibaba',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    baseUrlEnv: ['DASHSCOPE_BASE_URL'],
    modelEnv: ['DASHSCOPE_MODEL', 'QWEN_MODEL'],
    defaultModel: 'qwen3-coder-plus',
    docsUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    vendor: 'MiniMax',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    apiKeyEnv: ['MINIMAX_API_KEY'],
    baseUrlEnv: ['MINIMAX_BASE_URL'],
    modelEnv: ['MINIMAX_MODEL'],
    defaultModel: 'MiniMax-M2',
    docsUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'google',
    label: 'Google Gemini',
    vendor: 'Google',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrlEnv: ['GEMINI_BASE_URL'],
    modelEnv: ['GEMINI_MODEL'],
    defaultModel: 'gemini-2.5-pro',
    docsUrl: 'https://aistudio.google.com/apikey',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
    notes: 'Uses the Gemini OpenAI-compatibility endpoint.',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    vendor: 'xAI',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    baseUrlEnv: ['XAI_BASE_URL'],
    modelEnv: ['XAI_MODEL'],
    defaultModel: 'grok-4',
    docsUrl: 'https://console.x.ai',
    discovery: { path: '/models' },
    reasoning: { supported: true, values: REASONING_STANDARD, reasoningModelsOnly: true },
    supportsNativeTools: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    vendor: 'Groq',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: ['GROQ_API_KEY'],
    baseUrlEnv: ['GROQ_BASE_URL'],
    modelEnv: ['GROQ_MODEL'],
    defaultModel: 'moonshotai/kimi-k2-instruct',
    docsUrl: 'https://console.groq.com/keys',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    vendor: 'Mistral AI',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: ['MISTRAL_API_KEY'],
    baseUrlEnv: ['MISTRAL_BASE_URL'],
    modelEnv: ['MISTRAL_MODEL'],
    defaultModel: 'devstral-medium-latest',
    docsUrl: 'https://console.mistral.ai/api-keys',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    vendor: 'SiliconFlow',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: ['SILICONFLOW_API_KEY', 'SILICON_API_KEY'],
    baseUrlEnv: ['SILICONFLOW_BASE_URL'],
    modelEnv: ['SILICONFLOW_MODEL'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
    aggregator: true,
  },
  {
    id: 'together',
    label: 'Together AI',
    vendor: 'Together',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: ['TOGETHER_API_KEY'],
    baseUrlEnv: ['TOGETHER_BASE_URL'],
    modelEnv: ['TOGETHER_MODEL'],
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    discovery: { path: '/models' },
    reasoning: { supported: false },
    supportsNativeTools: true,
    aggregator: true,
  },
  {
    id: 'seed',
    label: 'Volcengine Ark (Doubao/Seed)',
    vendor: 'ByteDance',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    apiKeyEnv: ['SEED_API_KEY', 'ARK_API_KEY'],
    baseUrlEnv: ['SEED_BASE_URL', 'ARK_BASE_URL'],
    modelEnv: ['SEED_MODEL'],
    defaultModel: 'doubao-seed-code-preview-latest',
    docsUrl: 'https://console.volcengine.com/ark',
    reasoning: { supported: false },
    supportsNativeTools: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    vendor: 'Local',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnv: ['OLLAMA_API_KEY'],
    baseUrlEnv: ['OLLAMA_BASE_URL', 'OLLAMA_HOST'],
    modelEnv: ['OLLAMA_MODEL'],
    defaultModel: 'qwen3-coder:30b',
    docsUrl: 'https://ollama.com/download',
    discovery: { path: '/models', optionalAuth: true },
    reasoning: { supported: false },
    supportsNativeTools: true,
    local: true,
    optionalApiKey: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    vendor: 'Local',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyEnv: ['LMSTUDIO_API_KEY'],
    baseUrlEnv: ['LMSTUDIO_BASE_URL'],
    modelEnv: ['LMSTUDIO_MODEL'],
    defaultModel: '',
    docsUrl: 'https://lmstudio.ai',
    discovery: { path: '/models', optionalAuth: true },
    reasoning: { supported: false },
    supportsNativeTools: true,
    local: true,
    optionalApiKey: true,
  },
  {
    id: 'vllm',
    label: 'vLLM (local)',
    vendor: 'Local',
    transport: TRANSPORTS.OPENAI,
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    apiKeyEnv: ['VLLM_API_KEY'],
    baseUrlEnv: ['VLLM_BASE_URL'],
    modelEnv: ['VLLM_MODEL'],
    defaultModel: '',
    docsUrl: 'https://docs.vllm.ai',
    discovery: { path: '/models', optionalAuth: true },
    reasoning: { supported: false },
    supportsNativeTools: true,
    local: true,
    optionalApiKey: true,
  },
];

/**
 * Curated seed models. Live discovery adds to this; it never removes from it.
 * `context` is the context window in tokens.
 */
const SEED_MODELS = [
  // Anthropic
  { id: 'claude-opus-4-5', provider: 'anthropic', context: 200000, tags: ['flagship', 'coding'] },
  { id: 'claude-sonnet-4-5', provider: 'anthropic', context: 200000, tags: ['coding', 'balanced'] },
  { id: 'claude-haiku-4-5', provider: 'anthropic', context: 200000, tags: ['fast'] },
  { id: 'claude-3-5-sonnet-latest', provider: 'anthropic', context: 200000, tags: ['legacy'] },

  // OpenAI
  { id: 'gpt-5.1', provider: 'openai', context: 400000, tags: ['flagship', 'reasoning'] },
  { id: 'gpt-4.1', provider: 'openai', context: 1047576, tags: ['coding'] },
  { id: 'gpt-4.1-mini', provider: 'openai', context: 1047576, tags: ['fast'] },
  { id: 'gpt-4o', provider: 'openai', context: 128000, tags: ['legacy'] },
  { id: 'gpt-4o-mini', provider: 'openai', context: 128000, tags: ['fast', 'legacy'] },
  { id: 'o3', provider: 'openai', context: 200000, tags: ['reasoning'] },

  // Codex
  { id: 'gpt-5.3-codex', provider: 'codex', context: 400000, tags: ['coding', 'agentic'] },
  { id: 'gpt-5-codex', provider: 'codex', context: 400000, tags: ['coding', 'agentic'] },

  // DeepSeek
  { id: 'deepseek-chat', provider: 'deepseek', context: 128000, tags: ['coding'] },
  { id: 'deepseek-reasoner', provider: 'deepseek', context: 128000, tags: ['reasoning'] },

  // Moonshot / Kimi
  { id: 'kimi-k2-turbo-preview', provider: 'moonshot', context: 256000, tags: ['coding', 'agentic'] },
  { id: 'kimi-k2-0905-preview', provider: 'moonshot', context: 256000, tags: ['coding'] },

  // Zhipu / GLM
  { id: 'glm-4.6', provider: 'zhipu', context: 200000, tags: ['coding'] },
  { id: 'glm-4.5-air', provider: 'zhipu', context: 128000, tags: ['fast'] },

  // Qwen
  { id: 'qwen3-coder-plus', provider: 'dashscope', context: 1000000, tags: ['coding', 'agentic'] },
  { id: 'qwen3-max', provider: 'dashscope', context: 262144, tags: ['flagship'] },

  // MiniMax
  { id: 'MiniMax-M2', provider: 'minimax', context: 204800, tags: ['coding'] },

  // Google
  { id: 'gemini-2.5-pro', provider: 'google', context: 1048576, tags: ['flagship'] },
  { id: 'gemini-2.5-flash', provider: 'google', context: 1048576, tags: ['fast'] },

  // xAI
  { id: 'grok-4', provider: 'xai', context: 256000, tags: ['flagship'] },
  { id: 'grok-code-fast-1', provider: 'xai', context: 256000, tags: ['coding', 'fast'] },

  // Mistral
  { id: 'devstral-medium-latest', provider: 'mistral', context: 128000, tags: ['coding'] },

  // Volcengine Ark
  { id: 'doubao-seed-code-preview-latest', provider: 'seed', context: 256000, tags: ['coding'] },

  // OpenRouter (aggregated ids)
  { id: 'anthropic/claude-opus-4.5', provider: 'openrouter', context: 200000, tags: ['flagship'] },
  { id: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', context: 200000, tags: ['coding'] },
  { id: 'openai/gpt-5.1', provider: 'openrouter', context: 400000, tags: ['reasoning'] },
  { id: 'deepseek/deepseek-chat', provider: 'openrouter', context: 128000, tags: ['coding'] },
  { id: 'moonshotai/kimi-k2.5', provider: 'openrouter', context: 256000, tags: ['coding'] },
  { id: 'z-ai/glm-4.7', provider: 'openrouter', context: 200000, tags: ['coding'] },
  { id: 'minimax/minimax-m2.1', provider: 'openrouter', context: 204800, tags: ['coding'] },
  { id: 'google/gemini-3-flash-preview', provider: 'openrouter', context: 1048576, tags: ['fast'] },
  { id: 'qwen/qwen3-coder', provider: 'openrouter', context: 262144, tags: ['coding'] },
];

const PROVIDER_ALIASES = new Map([
  ['claude', 'anthropic'],
  ['gpt', 'openai'],
  ['oai', 'openai'],
  ['router', 'openrouter'],
  ['or', 'openrouter'],
  ['kimi', 'moonshot'],
  ['moonshotai', 'moonshot'],
  ['glm', 'zhipu'],
  ['zai', 'zhipu'],
  ['z-ai', 'zhipu'],
  ['bigmodel', 'zhipu'],
  ['qwen', 'dashscope'],
  ['bailian', 'dashscope'],
  ['aliyun', 'dashscope'],
  ['gemini', 'google'],
  ['grok', 'xai'],
  ['ark', 'seed'],
  ['doubao', 'seed'],
  ['volcengine', 'seed'],
  ['silicon', 'siliconflow'],
  ['lm-studio', 'lmstudio'],
  ['codexlocal', 'codex-local'],
  ['codex_local', 'codex-local'],
]);

const PROVIDER_INDEX = new Map(BUILT_IN_PROVIDERS.map((spec) => [spec.id, spec]));

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstEnvValue(names, env) {
  for (const name of Array.isArray(names) ? names : []) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return { value: value.trim(), name };
  }
  return { value: '', name: '' };
}

/** Canonical provider id for user input (`Kimi`, `z-ai`, `openrouter`, ...). */
export function normalizeProviderId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (PROVIDER_INDEX.has(raw)) return raw;
  return PROVIDER_ALIASES.get(raw) || raw;
}

export function listProviderSpecs() {
  return BUILT_IN_PROVIDERS.slice();
}

export function getProviderSpec(id) {
  return PROVIDER_INDEX.get(normalizeProviderId(id)) || null;
}

export function isKnownProvider(id) {
  return PROVIDER_INDEX.has(normalizeProviderId(id));
}

/** All provider ids, in display order. */
export function listProviderIds() {
  return BUILT_IN_PROVIDERS.map((spec) => spec.id);
}

/**
 * Parse `provider:model`, `provider/model` for known providers, or a bare model
 * id. Returns `{ provider, model }` where `provider` may be empty.
 */
export function parseModelRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return { provider: '', model: '' };

  const colon = raw.match(/^([a-zA-Z][\w.-]*)\s*:\s*(.+)$/);
  if (colon) {
    const provider = normalizeProviderId(colon[1]);
    if (isKnownProvider(provider)) return { provider, model: colon[2].trim() };
  }
  return { provider: '', model: raw };
}

export function formatModelRef({ provider = '', model = '' } = {}) {
  const id = String(model || '').trim();
  const key = normalizeProviderId(provider);
  if (!id) return '';
  return key ? `${key}:${id}` : id;
}

const SEED_BY_MODEL_ID = new Map();
for (const entry of SEED_MODELS) {
  const list = SEED_BY_MODEL_ID.get(entry.id) || [];
  list.push(entry);
  SEED_BY_MODEL_ID.set(entry.id, list);
}

/**
 * Guess which provider owns a bare model id. Kept deliberately conservative:
 * an unknown id returns "" so callers can fall back to the active provider.
 */
export function inferProviderForModel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  const parsed = parseModelRef(raw);
  if (parsed.provider) return parsed.provider;

  const lower = raw.toLowerCase();
  // Exact seed match with a single owner is the strongest signal.
  const seeds = SEED_BY_MODEL_ID.get(raw);
  if (seeds && seeds.length === 1) return seeds[0].provider;

  if (lower.includes('doubao') || lower.startsWith('seed-')) return 'seed';
  if (lower.includes('codex') || /^gpt-5/.test(lower)) return 'codex';
  // Aggregator ids look like `vendor/model`.
  if (raw.includes('/')) return 'openrouter';
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gpt-') || /^o[134]\b/.test(lower)) return 'openai';
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('kimi')) return 'moonshot';
  if (lower.startsWith('glm')) return 'zhipu';
  if (lower.startsWith('qwen')) return 'dashscope';
  if (lower.startsWith('minimax')) return 'minimax';
  if (lower.startsWith('gemini')) return 'google';
  if (lower.startsWith('grok')) return 'xai';
  if (lower.startsWith('devstral') || lower.startsWith('mistral')) return 'mistral';
  return '';
}

/**
 * Resolve the effective credentials/endpoint for a provider from settings and
 * environment. Settings win over environment so a saved profile is stable.
 */
export function resolveProviderConfig(providerId, { settings = {}, env = process.env } = {}) {
  const id = normalizeProviderId(providerId);
  const spec = getProviderSpec(id);
  if (!spec) {
    return { id, spec: null, apiKey: '', baseUrl: '', model: '', configured: false, source: '' };
  }

  const providers = isRecord(settings?.providers) ? settings.providers : {};
  const scoped = isRecord(providers[id]) ? providers[id] : {};
  const topLevelMatches = normalizeProviderId(settings?.provider) === id;

  const settingsApiKey =
    String(scoped.apiKey || scoped.api_key || (topLevelMatches ? settings?.apiKey : '') || '').trim();
  const settingsBaseUrl = String(
    scoped.endpoint || scoped.baseUrl || scoped.base_url || (topLevelMatches ? settings?.endpoint || settings?.baseUrl : '') || ''
  ).trim();
  const settingsModel = String(scoped.model || (topLevelMatches ? settings?.model : '') || '').trim();

  const envKey = firstEnvValue(spec.apiKeyEnv, env);
  const envBase = firstEnvValue(spec.baseUrlEnv, env);
  const envModel = firstEnvValue(spec.modelEnv, env);

  const apiKey = settingsApiKey || envKey.value;
  const baseUrl = settingsBaseUrl || envBase.value || spec.defaultBaseUrl || '';
  const model = settingsModel || envModel.value || spec.defaultModel || '';

  let source = '';
  if (settingsApiKey) source = 'settings';
  else if (envKey.value) source = `env:${envKey.name}`;

  const needsKey = !spec.optionalApiKey && spec.authKind !== 'codex-login' && (spec.apiKeyEnv || []).length > 0;
  // Local servers need no key, but must not be auto-selected just because they
  // could exist: require an explicit opt-in via settings or an environment var.
  const explicitLocalOptIn = Boolean(
    settingsApiKey || settingsBaseUrl || settingsModel || envKey.value || envBase.value || envModel.value
  );
  const detected = typeof spec.detectConfigured === 'function' ? Boolean(spec.detectConfigured(env)) : null;
  const configured = needsKey
    ? Boolean(apiKey)
    : detected != null
      ? detected || explicitLocalOptIn
      : spec.local
        ? explicitLocalOptIn
        : true;

  return {
    id,
    spec,
    apiKey,
    baseUrl,
    model,
    configured,
    source,
    needsKey,
    reasoningEfforts: Array.isArray(scoped.reasoningEfforts)
      ? scoped.reasoningEfforts
      : Array.isArray(scoped.thinkingEfforts)
        ? scoped.thinkingEfforts
        : null,
    extraHeaders: isRecord(scoped.headers) ? scoped.headers : null,
  };
}

/**
 * Human-readable setup hint for a provider that is not configured yet.
 */
export function describeProviderSetup(providerId) {
  const spec = getProviderSpec(providerId);
  if (!spec) return '';
  if (spec.authKind === 'codex-login') return 'run `codex login`';
  if (spec.local) {
    const envName = spec.baseUrlEnv?.[0] || '';
    return envName
      ? `start the server, optionally set ${envName} (default ${spec.defaultBaseUrl})`
      : `start the local server at ${spec.defaultBaseUrl}`;
  }
  const envName = spec.apiKeyEnv?.[0] || '';
  return envName ? `set ${envName}` : 'configure in ~/.piecode/settings.json';
}

/** Providers usable right now, in display order. */
export function listConfiguredProviders({ settings = {}, env = process.env } = {}) {
  return BUILT_IN_PROVIDERS.map((spec) => resolveProviderConfig(spec.id, { settings, env })).filter(
    (config) => config.configured
  );
}

/**
 * Status rows for the `/provider` view: every provider with whether it is ready
 * and how to make it ready.
 */
export function describeProviderStatuses({ settings = {}, env = process.env } = {}) {
  return BUILT_IN_PROVIDERS.map((spec) => {
    const config = resolveProviderConfig(spec.id, { settings, env });
    return {
      id: spec.id,
      label: spec.label,
      vendor: spec.vendor,
      local: Boolean(spec.local),
      aggregator: Boolean(spec.aggregator),
      configured: config.configured,
      source: config.source,
      baseUrl: config.baseUrl,
      model: config.model,
      setupHint: config.configured ? '' : describeProviderSetup(spec.id),
      docsUrl: spec.docsUrl || '',
      notes: spec.notes || '',
    };
  });
}

let userCatalogCache = null;

/** Optional `~/.piecode/models.json`: `{ "models": [{ id, provider, context }] }`. */
export function loadUserModelCatalog({ filePath = '', force = false } = {}) {
  if (userCatalogCache && !force) return userCatalogCache;
  const target = filePath || path.join(os.homedir(), '.piecode', 'models.json');
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    parsed = null;
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  const models = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const parsedRef = parseModelRef(row);
      if (parsedRef.model) {
        models.push({ id: parsedRef.model, provider: parsedRef.provider || inferProviderForModel(row), tags: ['user'] });
      }
      continue;
    }
    if (!isRecord(row)) continue;
    const id = String(row.id || row.model || '').trim();
    if (!id) continue;
    models.push({
      id,
      provider: normalizeProviderId(row.provider) || inferProviderForModel(id),
      context: Number.isFinite(Number(row.context ?? row.contextWindow))
        ? Math.max(0, Math.round(Number(row.context ?? row.contextWindow)))
        : undefined,
      tags: Array.isArray(row.tags) ? row.tags.map(String) : ['user'],
    });
  }
  userCatalogCache = { models, path: target };
  return userCatalogCache;
}

export function resetUserModelCatalogCache() {
  userCatalogCache = null;
}

/**
 * The merged catalog: seed models + user overrides + any discovered models,
 * annotated with provider metadata and availability.
 */
export function buildModelCatalog({
  settings = {},
  env = process.env,
  discovered = [],
  includeUnconfigured = false,
  userCatalog = null,
} = {}) {
  const byRef = new Map();
  const configuredCache = new Map();

  const isConfigured = (providerId) => {
    const key = normalizeProviderId(providerId);
    if (!key) return true;
    if (!configuredCache.has(key)) {
      configuredCache.set(key, resolveProviderConfig(key, { settings, env }).configured);
    }
    return configuredCache.get(key);
  };

  const add = (entry) => {
    if (!entry) return;
    const model = String(entry.id || entry.model || '').trim();
    if (!model) return;
    const provider = normalizeProviderId(entry.provider) || inferProviderForModel(model);
    const ref = formatModelRef({ provider, model });
    const existing = byRef.get(ref);
    const merged = {
      ref,
      id: model,
      provider,
      label: String(entry.label || existing?.label || model),
      context: Number.isFinite(Number(entry.context)) ? Math.round(Number(entry.context)) : existing?.context,
      tags: [...new Set([...(existing?.tags || []), ...(Array.isArray(entry.tags) ? entry.tags : [])])],
      available: isConfigured(provider),
      source: entry.source || existing?.source || 'seed',
    };
    byRef.set(ref, merged);
  };

  for (const entry of SEED_MODELS) add({ ...entry, source: 'seed' });
  const user = userCatalog || loadUserModelCatalog();
  for (const entry of user.models) add({ ...entry, source: 'user' });
  for (const entry of Array.isArray(discovered) ? discovered : []) add({ ...entry, source: entry.source || 'discovered' });

  const rows = [...byRef.values()];
  return includeUnconfigured ? rows : rows.filter((row) => row.available);
}

/**
 * Known context window for a model reference, or 0 when unknown.
 */
export function getCatalogContextWindow(modelRef, { catalog = null } = {}) {
  const raw = String(modelRef || '').trim();
  if (!raw) return 0;
  const rows = catalog || buildModelCatalog({ includeUnconfigured: true });
  const parsed = parseModelRef(raw);
  const provider = parsed.provider || inferProviderForModel(raw);
  const model = parsed.model || raw;
  const exact = rows.find((row) => row.provider === provider && row.id === model);
  if (exact?.context) return exact.context;
  const byModel = rows.find((row) => row.id === model && row.context);
  return byModel?.context || 0;
}

/**
 * Whether a provider/model pair supports a reasoning-effort knob, and which
 * values are valid. Providers that reject unknown request fields (DeepSeek,
 * Moonshot, GLM, ...) report `supported: false` so callers never send one.
 */
export function getModelReasoningSupport({ provider = '', model = '', overrides = null } = {}) {
  if (Array.isArray(overrides)) {
    const values = overrides.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
    return { supported: values.length > 0, values, source: 'settings' };
  }
  const spec = getProviderSpec(provider);
  if (!spec) return { supported: false, values: [], source: 'unknown' };
  const rule = spec.reasoning || {};
  if (!rule.supported) return { supported: false, values: [], source: 'provider' };

  const values = Array.isArray(rule.values) ? rule.values : REASONING_STANDARD;
  if (rule.reasoningModelsOnly) {
    const key = String(model || '').toLowerCase();
    const isReasoningModel = /gpt-5|codex|\bo[134]\b|thinking|reasoner|-r1\b/.test(key);
    return {
      supported: true,
      values: isReasoningModel ? values : REASONING_STANDARD,
      source: 'provider',
    };
  }
  return { supported: true, values, source: 'provider' };
}

/**
 * Live model discovery for a provider that exposes an OpenAI-style `/models`
 * endpoint. Best effort: any failure resolves to an empty list.
 */
export async function discoverProviderModels(
  providerId,
  { settings = {}, env = process.env, signal = null, timeoutMs = 6000, fetchImpl = null } = {}
) {
  const config = resolveProviderConfig(providerId, { settings, env });
  const spec = config.spec;
  if (!spec?.discovery?.path) return { models: [], ok: false, reason: 'no-discovery' };
  if (!config.configured) return { models: [], ok: false, reason: 'not-configured' };
  if (!config.apiKey && !spec.discovery.optionalAuth) {
    return { models: [], ok: false, reason: 'no-key' };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { models: [], ok: false, reason: 'no-fetch' };

  const base = String(config.baseUrl || spec.defaultBaseUrl || '').replace(/\/+$/, '');
  if (!base) return { models: [], ok: false, reason: 'no-base-url' };
  const url = `${base}${spec.discovery.path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const headers = { accept: 'application/json' };
    if (config.apiKey) {
      if (spec.discovery.auth === 'x-api-key') {
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }
    }
    const res = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return { models: [], ok: false, reason: `http-${res.status}` };
    const data = await res.json().catch(() => ({}));
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = [];
    for (const row of rows) {
      const id = String(row?.id || row?.name || '').trim().replace(/^models\//, '');
      if (!id) continue;
      const contextRaw = row?.context_length ?? row?.context_window ?? row?.max_context_length;
      const context = Number.isFinite(Number(contextRaw)) ? Math.round(Number(contextRaw)) : undefined;
      models.push({ id, provider: config.id, context, tags: ['discovered'], source: 'discovered' });
    }
    return { models, ok: true, reason: '', count: models.length };
  } catch (err) {
    return { models: [], ok: false, reason: String(err?.message || err || 'failed') };
  } finally {
    clearTimeout(timer);
    if (signal) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {}
    }
  }
}

/**
 * Discover models across every configured provider concurrently.
 */
export async function discoverAllProviderModels({
  settings = {},
  env = process.env,
  signal = null,
  timeoutMs = 6000,
  fetchImpl = null,
  providerIds = null,
} = {}) {
  const targets = (providerIds || listProviderIds())
    .map((id) => normalizeProviderId(id))
    .filter((id) => getProviderSpec(id)?.discovery?.path);

  const results = await Promise.all(
    targets.map(async (id) => ({
      provider: id,
      ...(await discoverProviderModels(id, { settings, env, signal, timeoutMs, fetchImpl })),
    }))
  );

  const models = [];
  const sources = [];
  for (const result of results) {
    if (!result.ok || result.models.length === 0) continue;
    sources.push(result.provider);
    models.push(...result.models);
  }
  return { models, sources, results };
}

export { SEED_MODELS, BUILT_IN_PROVIDERS };

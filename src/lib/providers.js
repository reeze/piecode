import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import {
  TRANSPORTS,
  getModelReasoningSupport,
  getProviderSpec,
  inferProviderForModel,
  isKnownProvider,
  listProviderSpecs,
  normalizeProviderId,
  parseModelRef,
  resolveProviderConfig,
} from './modelCatalog.js';

const DEFAULT_ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.3-codex';
const DEFAULT_CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_ACCOUNT_CLAIM = 'https://api.openai.com/auth';
const DEFAULT_MODEL_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.PIECODE_MODEL_TIMEOUT_MS || '120000', 10) ||
    120_000
);
const execFile = promisify(execFileCb);

function createAbortTimeout(controller) {
  let timer = null;
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), DEFAULT_MODEL_TIMEOUT_MS);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  refresh();
  return { refresh, clear };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function describeFetchError(err) {
  const parts = [String(err?.message || err || 'request failed')];
  const cause = err?.cause;
  if (cause?.code) parts.push(String(cause.code));
  if (cause?.hostname) parts.push(String(cause.hostname));
  return [...new Set(parts.filter(Boolean))].join(' ');
}

function modelNetworkError(label, url, err) {
  const wrapped = new Error(
    `${label} failed while connecting to ${url}: ${describeFetchError(err)}`
  );
  wrapped.cause = err;
  return wrapped;
}

async function postJson(url, headers, body, options = {}) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let abortListener = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    abortListener = () => controller.abort();
    externalSignal.addEventListener('abort', abortListener, { once: true });
  }
  const timeout = createAbortTimeout(controller);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (externalSignal?.aborted) {
        const abortErr = new Error('Model request aborted.');
        abortErr.code = 'ABORT_ERR';
        throw abortErr;
      }
      throw new Error(
        `Model request timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
      );
    }
    throw modelNetworkError('Model request', url, err);
  } finally {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      `Model API error (${res.status}): ${JSON.stringify(data)}`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function postJsonStream(url, headers, body, onChunk, options = {}) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let abortListener = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    abortListener = () => controller.abort();
    externalSignal.addEventListener('abort', abortListener, { once: true });
  }
  const timeout = createAbortTimeout(controller);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
    if (err?.name === 'AbortError') {
      if (externalSignal?.aborted) {
        const abortErr = new Error('Model stream aborted.');
        abortErr.code = 'ABORT_ERR';
        throw abortErr;
      }
      throw new Error(
        `Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
      );
    }
    throw modelNetworkError('Model stream', url, err);
  }
  timeout.refresh();
  try {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(
        `Model API error (${res.status}): ${JSON.stringify(data)}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }

    if (!res.body) {
      return {
        text: '',
        usage: null,
      };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let combined = '';
    let usage = null;

    while (true) {
      let packet;
      try {
        packet = await reader.read();
      } catch (err) {
        if (err?.name === 'AbortError') {
          if (externalSignal?.aborted) {
            const abortErr = new Error('Model stream aborted.');
            abortErr.code = 'ABORT_ERR';
            throw abortErr;
          }
          throw new Error(
            `Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
          );
        }
        throw err;
      }
      const { done, value } = packet;
      if (done) break;
      timeout.refresh();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage && typeof parsed.usage === 'object') {
            const normalized = normalizeUsage(parsed.usage);
            if (normalized) usage = normalized;
          }
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            combined += delta;
            onChunk?.(delta);
          }
        } catch {
          // Ignore malformed event chunks and continue.
        }
      }
    }

    return {
      text: combined.trim(),
      usage,
    };
  } finally {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
  }
}

function extractDeltaContent(delta) {
  if (!delta) return '';
  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .join('');
  }
  return '';
}

function extractDeltaReasoning(delta) {
  if (!delta) return '';
  const fields = [
    delta.reasoning,
    delta.reasoning_content,
    delta.thinking,
    delta.analysis,
  ];
  for (const field of fields) {
    if (typeof field === 'string' && field.length > 0) return field;
    if (Array.isArray(field)) {
      const joined = field
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.content === 'string') return part.content;
          return '';
        })
        .join('');
      if (joined) return joined;
    }
  }
  return '';
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function normalizeThinkingEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return '';
  if (effort === 'extra' || effort === 'extra-high' || effort === 'extra_high' || effort === 'max') return 'xhigh';
  if (effort === 'default' || effort === 'off') return '';
  return effort;
}

function normalizeReasoningEffortList(values) {
  if (!Array.isArray(values)) return null;
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeThinkingEffort(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function getReasoningEffortCapabilities({
  provider = '',
  providerId = '',
  kind = '',
  model = '',
  reasoningEfforts = null,
  thinkingEfforts = null,
} = {}) {
  const configured = normalizeReasoningEffortList(reasoningEfforts || thinkingEfforts);
  if (configured) {
    return {
      supported: configured.length > 0,
      values: configured,
      source: 'settings',
    };
  }

  // A registry-known provider knows exactly which efforts its API accepts.
  // This keeps piecode from sending `reasoning_effort` to providers that reject
  // unknown request fields (DeepSeek, Moonshot, GLM, ...).
  const registryId = normalizeProviderId(providerId);
  if (registryId && isKnownProvider(registryId)) {
    const support = getModelReasoningSupport({ provider: registryId, model });
    return {
      supported: support.supported,
      values: support.values,
      source: 'registry',
      ...(support.supported ? {} : { reason: `${registryId}-effort-unsupported` }),
    };
  }

  const providerKey = String(provider || '').trim().toLowerCase();
  const kindKey = String(kind || '').trim().toLowerCase();
  const modelKey = String(model || '').trim().toLowerCase();
  const combined = `${providerKey} ${kindKey}`;
  const reasoningModel =
    /\bgpt-5\b|gpt-5[.\w-]*|\bo[134]\b|o[134][\w-]*|codex/.test(modelKey);

  if (combined.includes('anthropic') && !combined.includes('openrouter')) {
    return {
      supported: false,
      values: [],
      source: 'provider',
      reason: 'anthropic-direct-effort-unsupported',
    };
  }

  if (combined.includes('codex')) {
    return {
      supported: true,
      values: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      source: 'provider',
    };
  }

  if (combined.includes('openrouter')) {
    return {
      supported: true,
      values: reasoningModel
        ? ['minimal', 'low', 'medium', 'high', 'xhigh']
        : ['low', 'medium', 'high'],
      source: 'provider',
    };
  }

  if (combined.includes('openai')) {
    return {
      supported: true,
      values: reasoningModel
        ? ['minimal', 'low', 'medium', 'high', 'xhigh']
        : ['low', 'medium', 'high'],
      source: 'provider',
    };
  }

  return {
    supported: true,
    values: ['low', 'medium', 'high'],
    source: 'generic',
  };
}

function normalizeThinkingEffortForProvider(value, context = {}) {
  const effort = normalizeThinkingEffort(value);
  if (!effort) return '';
  const capabilities = getReasoningEffortCapabilities(context);
  return capabilities.values.includes(effort) ? effort : '';
}

function withReasoningEffort(body, thinkingEffort, context = {}) {
  const effort = normalizeThinkingEffortForProvider(thinkingEffort, context);
  if (!effort || !body || typeof body !== 'object') return body;
  return {
    ...body,
    reasoning_effort: effort,
    reasoning: { ...(body.reasoning || {}), effort },
  };
}

function withResponsesReasoningEffort(body, thinkingEffort, context = {}) {
  const effort = normalizeThinkingEffortForProvider(thinkingEffort, context);
  if (!effort || !body || typeof body !== 'object') return body;
  return {
    ...body,
    reasoning: { ...(body.reasoning || {}), effort },
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = toFiniteNumber(
    raw.input_tokens ?? raw.prompt_tokens ?? raw.inputTokens
  );
  const outputTokens = toFiniteNumber(
    raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens
  );
  const totalTokens = toFiniteNumber(raw.total_tokens ?? raw.totalTokens);
  const out = {};
  if (inputTokens != null) out.input_tokens = inputTokens;
  if (outputTokens != null) out.output_tokens = outputTokens;
  if (totalTokens != null) out.total_tokens = totalTokens;
  if (Object.keys(out).length === 0) return null;
  if (
    out.total_tokens == null &&
    out.input_tokens != null &&
    out.output_tokens != null
  ) {
    out.total_tokens = out.input_tokens + out.output_tokens;
  }
  return out;
}

async function postResponsesStream(url, headers, body, onChunk, options = {}) {
  const detailed = await postResponsesStreamDetailed(url, headers, body, onChunk, options);
  return { text: detailed.text, usage: detailed.usage };
}

async function postResponsesStreamDetailed(url, headers, body, onChunk, options = {}) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let abortListener = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    abortListener = () => controller.abort();
    externalSignal.addEventListener('abort', abortListener, { once: true });
  }
  const timeout = createAbortTimeout(controller);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
    if (err?.name === 'AbortError') {
      if (externalSignal?.aborted) {
        const abortErr = new Error('Model stream aborted.');
        abortErr.code = 'ABORT_ERR';
        throw abortErr;
      }
      throw new Error(
        `Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
      );
    }
    throw modelNetworkError('Model stream', url, err);
  }

  timeout.refresh();
  try {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(
        `Model API error (${res.status}): ${JSON.stringify(data)}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }

    if (!res.body) return { text: '', usage: null };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = null;
    let finishReason = '';
    const toolCalls = [];
    const toolCallByKey = new Map();
    let currentToolKey = '';

    const ensureToolCall = (item = {}) => {
      const key = String(item.call_id || item.id || currentToolKey || `tool_${toolCalls.length}`);
      if (toolCallByKey.has(key)) return toolCallByKey.get(key);
      const call = {
        id: String(item.id || responsesItemIdFromToolCallId(key)),
        call_id: String(item.call_id || key),
        name: String(item.name || ''),
        arguments: typeof item.arguments === 'string' ? item.arguments : '',
      };
      toolCallByKey.set(key, call);
      toolCalls.push(call);
      return call;
    };

    const handleEvent = (rawData) => {
      if (!rawData || rawData === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return;
      }

      if (parsed?.usage && typeof parsed.usage === 'object') {
        const normalized = normalizeUsage(parsed.usage);
        if (normalized) usage = normalized;
      }

      const type = String(parsed?.type || '');
      if (type === 'response.output_item.added' && parsed?.item?.type === 'function_call') {
        const call = ensureToolCall(parsed.item);
        currentToolKey = call.call_id || call.id;
        return;
      }
      if (type === 'response.function_call_arguments.delta') {
        const call = ensureToolCall({ call_id: currentToolKey });
        call.arguments += String(parsed?.delta || '');
        return;
      }
      if (type === 'response.function_call_arguments.done') {
        const call = ensureToolCall({ call_id: currentToolKey });
        if (typeof parsed?.arguments === 'string') call.arguments = parsed.arguments;
        return;
      }
      if (type === 'response.output_item.done' && parsed?.item?.type === 'function_call') {
        const call = ensureToolCall(parsed.item);
        call.id = String(parsed.item.id || call.id);
        call.call_id = String(parsed.item.call_id || call.call_id);
        call.name = String(parsed.item.name || call.name);
        if (typeof parsed.item.arguments === 'string') call.arguments = parsed.item.arguments;
        currentToolKey = '';
        return;
      }

      const delta =
        typeof parsed?.delta === 'string'
          ? parsed.delta
          : typeof parsed?.text === 'string'
            ? parsed.text
            : '';
      if (
        (type.endsWith('.delta') || type === 'response.output_text.delta') &&
        delta
      ) {
        text += delta;
        onChunk?.(delta);
        return;
      }

      const response =
        parsed?.response && typeof parsed.response === 'object'
          ? parsed.response
          : null;
      if (response?.usage) {
        const normalized = normalizeUsage(response.usage);
        if (normalized) usage = normalized;
      }
      if (type === 'response.completed' && response) {
        finishReason = response.status === 'completed' ? 'stop' : String(response.status || '');
        const outputItems = Array.isArray(response.output) ? response.output : [];
        for (const item of outputItems) {
          if (item?.type === 'function_call') {
            const call = ensureToolCall(item);
            call.id = String(item.id || call.id);
            call.call_id = String(item.call_id || call.call_id);
            call.name = String(item.name || call.name);
            if (typeof item.arguments === 'string') call.arguments = item.arguments;
          }
        }
        const finalText = extractResponsesText(response);
        if (finalText && finalText.length > text.length) text = finalText;
      }
    };

    while (true) {
      let packet;
      try {
        packet = await reader.read();
      } catch (err) {
        if (err?.name === 'AbortError') {
          if (externalSignal?.aborted) {
            const abortErr = new Error('Model stream aborted.');
            abortErr.code = 'ABORT_ERR';
            throw abortErr;
          }
          throw new Error(
            `Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
          );
        }
        throw err;
      }
      const { done, value } = packet;
      if (done) break;
      timeout.refresh();
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = eventBlock
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        handleEvent(data);
      }
    }

    if (buffer.trim()) {
      const data = buffer
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      handleEvent(data);
    }

    return { text: text.trim(), usage, toolCalls, finishReason };
  } finally {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
  }
}

async function postJsonStreamOpenAINative(
  url,
  headers,
  body,
  onChunk,
  options = {}
) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let abortListener = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    abortListener = () => controller.abort();
    externalSignal.addEventListener('abort', abortListener, { once: true });
  }
  const timeout = createAbortTimeout(controller);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
    if (err?.name === 'AbortError') {
      if (externalSignal?.aborted) {
        const abortErr = new Error('Model stream aborted.');
        abortErr.code = 'ABORT_ERR';
        throw abortErr;
      }
      throw new Error(
        `Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
      );
    }
    throw modelNetworkError('Model stream', url, err);
  }
  timeout.refresh();
  try {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(
        `Model API error (${res.status}): ${JSON.stringify(data)}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }

    if (!res.body) {
      return {
        message: { role: 'assistant', content: '' },
        finishReason: '',
        usage: null,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = '';
    const toolCallsByIndex = new Map();
    let usage = null;

    while (true) {
      let packet;
      try {
        packet = await reader.read();
      } catch (err) {
    if (err?.name === 'AbortError') {
          if (externalSignal?.aborted) {
            const abortErr = new Error('Model stream aborted.');
            abortErr.code = 'ABORT_ERR';
            throw abortErr;
          }
          throw new Error(
            `Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`
      );
    }
    throw modelNetworkError('Model stream', url, err);
  }
      const { done, value } = packet;
      if (done) break;
      timeout.refresh();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage && typeof parsed.usage === 'object') {
            const normalized = normalizeUsage(parsed.usage);
            if (normalized) usage = normalized;
          }
          const choice = parsed?.choices?.[0];
          if (!choice) continue;
          if (
            typeof choice.finish_reason === 'string' &&
            choice.finish_reason
          ) {
            finishReason = choice.finish_reason;
          }
          const delta = choice?.delta || {};

          const deltaContent = extractDeltaContent(delta);
          if (deltaContent) {
            content += deltaContent;
            onChunk?.(deltaContent);
          }

          const deltaReasoning = extractDeltaReasoning(delta);
          if (deltaReasoning) {
            onChunk?.(deltaReasoning);
          }

          const deltaToolCalls = Array.isArray(delta.tool_calls)
            ? delta.tool_calls
            : [];
          if (deltaToolCalls.length > 0) timeout.refresh();
          for (const item of deltaToolCalls) {
            const idx = Number.isInteger(item?.index) ? item.index : 0;
            const current = toolCallsByIndex.get(idx) || {
              id: '',
              type: 'function',
              function: { name: '', arguments: '' },
            };
            if (typeof item?.id === 'string' && item.id) current.id = item.id;
            if (typeof item?.type === 'string' && item.type)
              current.type = item.type;
            if (item?.function && typeof item.function === 'object') {
              if (
                typeof item.function.name === 'string' &&
                item.function.name
              ) {
                current.function.name = item.function.name;
              }
              if (
                typeof item.function.arguments === 'string' &&
                item.function.arguments
              ) {
                current.function.arguments += item.function.arguments;
              }
            }
            toolCallsByIndex.set(idx, current);
          }
        } catch {
          // Ignore malformed event chunks and continue.
        }
      }
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call);

    const message = {
      role: 'assistant',
      content: content.trim(),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return { message, finishReason, usage };
  } finally {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseCodexConfigModel(configToml) {
  const match = String(configToml).match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match?.[1] || null;
}

function parseCodexTopLevelString(configToml, key) {
  // Only scan the implicit root table, i.e. everything before the first [table].
  const root = String(configToml || '').split(/^\s*\[/m)[0];
  const match = root.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match?.[1] || '';
}

/**
 * Parse the `[model_providers.<id>]` tables out of ~/.codex/config.toml so
 * piecode can reuse whatever endpoints Codex is already configured against —
 * including local ones (`codex --oss`, vLLM, LM Studio, a private gateway).
 */
function parseCodexModelProviders(configToml) {
  const providers = {};
  let current = null;
  for (const rawLine of String(configToml || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      const parts = table[1].split('.');
      if (parts.length === 2 && parts[0].trim() === 'model_providers') {
        const id = parts[1].replace(/^["']|["']$/g, '').trim();
        current = id ? (providers[id] = { id, name: id, baseUrl: '', envKey: '', wireApi: 'chat' }) : null;
      } else {
        current = null;
      }
      continue;
    }

    if (!current) continue;
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key === 'name') current.name = value;
    else if (key === 'base_url') current.baseUrl = value;
    else if (key === 'env_key') current.envKey = value;
    else if (key === 'wire_api') current.wireApi = value.toLowerCase();
  }
  return providers;
}

/**
 * Everything piecode needs to know about the local Codex installation.
 */
export function loadCodexLocalConfig({ codexHome = getCodexHome(), env = process.env } = {}) {
  const configToml = readTextFile(path.join(codexHome, 'config.toml'));
  const providers = parseCodexModelProviders(configToml);
  const activeProviderId =
    env.CODEX_MODEL_PROVIDER || parseCodexTopLevelString(configToml, 'model_provider') || '';
  const activeProvider = activeProviderId ? providers[activeProviderId] || null : null;
  return {
    codexHome,
    model: parseCodexConfigModel(configToml) || '',
    activeProviderId,
    activeProvider,
    providers,
    hasLocalProvider: Boolean(activeProvider?.baseUrl && isLocalBaseUrl(activeProvider.baseUrl)),
  };
}

function isLocalBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim().toLowerCase();
  if (!value) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)([:/]|$)/.test(value);
}

/**
 * OpenAI-compatible provider backed by a locally running Codex-compatible
 * server. Resolution order: explicit options, CODEX_LOCAL_BASE_URL, then the
 * `model_provider` table selected in ~/.codex/config.toml.
 */
function createCodexLocalProvider({
  configuredModel = '',
  configuredBaseUrl = '',
  configuredApiKey = '',
  thinkingEffort = '',
  reasoningEfforts = null,
  env = process.env,
} = {}) {
  const local = loadCodexLocalConfig({ env });
  const baseUrl =
    configuredBaseUrl ||
    env.CODEX_LOCAL_BASE_URL ||
    env.PIECODE_CODEX_LOCAL_BASE_URL ||
    local.activeProvider?.baseUrl ||
    '';
  if (!baseUrl) return null;

  const envKeyName = local.activeProvider?.envKey || '';
  const apiKey =
    configuredApiKey ||
    env.CODEX_LOCAL_API_KEY ||
    (envKeyName ? env[envKeyName] || '' : '') ||
    'local';

  const model =
    configuredModel || env.CODEX_LOCAL_MODEL || local.model || getProviderSpec('codex-local')?.defaultModel || '';
  if (!model) return null;

  return createOpenAICompatibleProvider({
    kind: 'codex-local',
    providerId: 'codex-local',
    model,
    apiKey,
    baseUrl,
    thinkingEffort,
    reasoningEfforts,
  });
}

function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function getSupportedCodexApiModels(codexHome) {
  const modelsCachePath = path.join(codexHome, 'models_cache.json');
  const modelsCache = readJsonFile(modelsCachePath);
  if (!Array.isArray(modelsCache?.models)) return new Set();
  return new Set(
    modelsCache.models
      .filter((m) => m?.supported_in_api)
      .map((m) => m?.slug)
      .filter(Boolean)
  );
}

function isCodexSpecificModel(modelName) {
  return String(modelName || '').toLowerCase().includes('codex');
}

function resolveCodexModel(codexHome, preferredModel) {
  const supported = getSupportedCodexApiModels(codexHome);
  const hasSupportData = supported.size > 0;
  if (preferredModel && (!hasSupportData || supported.has(preferredModel)))
    return preferredModel;
  if (supported.has(DEFAULT_CODEX_MODEL)) return DEFAULT_CODEX_MODEL;
  if (supported.has('gpt-5.3-codex')) return 'gpt-5.3-codex';
  if (supported.has('gpt-5-codex')) return 'gpt-5-codex';
  return preferredModel || DEFAULT_CODEX_MODEL;
}

function loadCodexAuth() {
  const codexHome = getCodexHome();
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');
  const auth = readJsonFile(authPath);
  if (!auth || typeof auth !== 'object') return null;

  const configModel = parseCodexConfigModel(readTextFile(configPath));
  const preferredModel =
    process.env.CODEX_MODEL ||
    (isCodexSpecificModel(configModel) ? configModel : '') ||
    DEFAULT_CODEX_MODEL;
  const resolvedModel = resolveCodexModel(
    codexHome,
    preferredModel
  );
  const openaiApiKey =
    typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : '';
  const accessToken =
    typeof auth?.tokens?.access_token === 'string'
      ? auth.tokens.access_token
      : '';

  return {
    openaiApiKey,
    accessToken,
    model: resolvedModel,
    codexHome,
  };
}

function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  const outputs = Array.isArray(data?.output) ? data.output : [];
  const textParts = [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === 'output_text' && typeof block?.text === 'string') {
        textParts.push(block.text);
      }
    }
  }
  return textParts.join('\n').trim();
}

function responsesItemIdFromToolCallId(id) {
  const raw = String(id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.startsWith('fc_') ? cleaned : `fc_${cleaned}`;
}

function normalizeResponsesInputContent(role, content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.type === 'text') {
          return { type: role === 'assistant' ? 'output_text' : 'input_text', text: String(part.text || '') };
        }
        if (part?.type === 'image_url' && role !== 'assistant') {
          const url = String(part?.image_url?.url || '');
          if (url) return { type: 'input_image', image_url: url, detail: 'auto' };
        }
        if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'input_image') return part;
        return null;
      })
      .filter(Boolean);
  }
  const text = String(content ?? '');
  if (role === 'assistant') {
    return [{ type: 'output_text', text }];
  }
  return [{ type: 'input_text', text }];
}

function convertOpenAIMessagesToResponsesInput(messages = []) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = String(msg?.role || '').toLowerCase();
    if (!role || role === 'system') continue;
    if (role === 'tool') {
      const callId = String(msg?.tool_call_id || '').trim();
      if (!callId) continue;
      out.push({
        type: 'function_call_output',
        call_id: callId,
        output: typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? ''),
      });
      continue;
    }
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const callId = String(call?.id || '').trim() || `call_${out.length + 1}`;
        out.push({
          type: 'function_call',
          id: responsesItemIdFromToolCallId(callId),
          call_id: callId,
          name: String(call?.function?.name || ''),
          arguments: String(call?.function?.arguments || '{}'),
        });
      }
      continue;
    }
    if (role === 'user' || role === 'assistant') {
      out.push({
        role,
        content: normalizeResponsesInputContent(role, msg?.content ?? ''),
      });
    }
  }
  return out;
}

function convertOpenAIToolsToResponsesTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool;
      const name = String(fn?.name || '').trim();
      if (!name) return null;
      return {
        type: 'function',
        name,
        description: String(fn?.description || ''),
        parameters: fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
        strict: null,
      };
    })
    .filter(Boolean);
}

async function postResponsesStreamNative(url, headers, body, onChunk, options = {}) {
  const streamed = await postResponsesStreamDetailed(url, headers, body, onChunk, options);
  const toolCalls = streamed.toolCalls.map((call) => ({
    id: call.call_id || call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.arguments || '{}',
    },
  }));
  return {
    message: {
      role: 'assistant',
      content: streamed.text || '',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finishReason: toolCalls.length > 0 ? 'tool_calls' : streamed.finishReason || 'stop',
    usage: streamed.usage || null,
  };
}

/**
 * Reasoning-first models (o-series, gpt-5*, codex) reject `temperature` on the
 * chat-completions API, so it is omitted for them.
 */
function supportsTemperatureSampling(modelName) {
  const key = String(modelName || '').toLowerCase();
  if (!key) return true;
  return !/(^|[/:])(o[134])\b|gpt-5|codex/.test(key);
}

function createOpenAICompatibleProvider({
  kind,
  providerId = '',
  model,
  apiKey,
  baseUrl,
  extraHeaders = {},
  thinkingEffort = '',
  reasoningEfforts = null,
}) {
  const normalizedBase = (baseUrl || 'https://api.openai.com/v1').replace(
    /\/$/,
    ''
  );
  const chatUrl = normalizedBase.endsWith('/chat/completions')
    ? normalizedBase
    : `${normalizedBase}/chat/completions`;
  const effortContext = { kind, providerId, model, reasoningEfforts };
  const effortCapabilities = getReasoningEffortCapabilities(effortContext);
  const effectiveThinkingEffort = normalizeThinkingEffortForProvider(
    thinkingEffort,
    effortContext
  );
  const sampling = supportsTemperatureSampling(model) ? { temperature: 0.2 } : {};

  return {
    kind,
    providerId: normalizeProviderId(providerId) || '',
    model,
    baseUrl: normalizedBase,
    thinkingEffort: effectiveThinkingEffort,
    reasoningEffortOptions: effortCapabilities.values,
    supportsReasoningEffort: effortCapabilities.supported,
    supportsNativeTools: true,
    _lastUsage: null,
    getLastUsage() {
      return this._lastUsage || null;
    },
    async complete({ systemPrompt, prompt, messages, tools, signal }) {
      this._lastUsage = null;
      const useNative = Array.isArray(messages) && Array.isArray(tools);
      const body = useNative
        ? {
            model,
            ...sampling,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            tools,
          }
        : {
            model,
            ...sampling,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          };
      const data = await postJson(
        chatUrl,
        { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        withReasoningEffort(body, thinkingEffort, effortContext),
        { signal }
      );
      this._lastUsage = normalizeUsage(data?.usage);
      if (useNative) {
        const msg = data?.choices?.[0]?.message;
        if (!msg)
          throw new Error(
            'OpenAI-compatible response did not contain message.'
          );
        return {
          type: 'native',
          format: 'openai',
          message: msg,
          finishReason: data?.choices?.[0]?.finish_reason,
          usage: this._lastUsage || null,
        };
      }
      const text = data?.choices?.[0]?.message?.content;
      if (!text)
        throw new Error(
          'OpenAI-compatible response did not contain message content.'
        );
      return text;
    },
    async completeStream({
      systemPrompt,
      prompt,
      messages,
      tools,
      onDelta,
      signal,
    }) {
      this._lastUsage = null;
      if (Array.isArray(messages) && Array.isArray(tools)) {
        const streamed = await postJsonStreamOpenAINative(
          chatUrl,
          { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
          withReasoningEffort(
            {
              model,
              ...sampling,
              stream: true,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              tools,
            },
            thinkingEffort,
            effortContext
          ),
          onDelta,
          { signal }
        );
        this._lastUsage = streamed.usage || null;
        return {
          type: 'native',
          format: 'openai',
          message: streamed.message,
          finishReason: streamed.finishReason,
          usage: this._lastUsage || null,
        };
      }
      const streamed = await postJsonStream(
        chatUrl,
        { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        withReasoningEffort(
          {
            model,
            ...sampling,
            stream: true,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          },
          thinkingEffort,
          effortContext
        ),
        onDelta,
        { signal }
      );
      this._lastUsage = streamed?.usage || null;
      const text = String(streamed?.text || '');
      if (!text)
        throw new Error(
          'OpenAI-compatible stream did not contain message content.'
        );
      return text;
    },
  };
}

function resolveCodexResponsesUrl(baseUrl) {
  const raw =
    baseUrl && String(baseUrl).trim()
      ? String(baseUrl).trim()
      : DEFAULT_CODEX_BACKEND_BASE_URL;
  const normalized = raw.replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function decodeBase64UrlJson(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function extractCodexAccountId(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length !== 3) {
    throw new Error(
      'Codex auth token is not a JWT and cannot be used with ChatGPT backend.'
    );
  }
  const payload = decodeBase64UrlJson(parts[1]);
  const accountId = payload?.[CODEX_ACCOUNT_CLAIM]?.chatgpt_account_id;
  if (!accountId) {
    throw new Error('Codex auth token does not contain a ChatGPT account id.');
  }
  return accountId;
}

function buildCodexBackendHeaders(accessToken, accountId) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    originator: 'piecode',
    'User-Agent': `piecode (${os.platform()} ${os.release()}; ${os.arch()})`,
    'OpenAI-Beta': 'responses=experimental',
    accept: 'text/event-stream',
  };
}

function hasCodexCliSession() {
  if (process.env.PIECODE_DISABLE_CODEX_CLI === '1') return false;
  try {
    const out = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      timeout: 8_000,
    });
    if (out.status !== 0) return false;
    const combined = `${String(out.stdout || '')}\n${String(out.stderr || '')}`;
    return /(Logged in|Authenticated|ChatGPT)/i.test(combined);
  } catch {
    return false;
  }
}

async function prepareCodexExecHome(codexHome) {
  const sandboxHome = path.join(
    os.tmpdir(),
    `piecode-codex-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(sandboxHome, { recursive: true });

  const optionalFiles = ['auth.json', 'config.toml', 'models_cache.json'];
  for (const name of optionalFiles) {
    const src = path.join(codexHome, name);
    const dest = path.join(sandboxHome, name);
    try {
      await fsp.copyFile(src, dest);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  return sandboxHome;
}

function createCodexCliProvider(customModel = null, thinkingEffort = '', reasoningEfforts = null) {
  const codexHome = getCodexHome();
  const requestedModel = customModel || process.env.CODEX_MODEL || null;
  const model = requestedModel || resolveCodexModel(codexHome, null);
  const effortContext = { kind: 'codex-cli-session', model, reasoningEfforts };
  const effortCapabilities = getReasoningEffortCapabilities(effortContext);
  const effectiveThinkingEffort = normalizeThinkingEffortForProvider(
    thinkingEffort,
    effortContext
  );
  return {
    kind: 'codex-cli-session',
    model,
    thinkingEffort: effectiveThinkingEffort,
    reasoningEffortOptions: effortCapabilities.values,
    supportsReasoningEffort: effortCapabilities.supported,
    supportsNativeTools: false,
    _lastUsage: null,
    getLastUsage() {
      return this._lastUsage || null;
    },
    async complete({ systemPrompt, prompt, signal }) {
      this._lastUsage = null;
      const tmpFile = path.join(
        os.tmpdir(),
        `piecode-last-message-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
      );
      const execCodexHome = await prepareCodexExecHome(codexHome);

      const composedPrompt = `${systemPrompt}\n\n${prompt}`;
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--output-last-message',
        tmpFile,
        '--color',
        'never',
        '-m',
        model,
        ...(effectiveThinkingEffort
          ? ['--config', `model_reasoning_effort="${effectiveThinkingEffort}"`]
          : []),
        composedPrompt,
      ];

      try {
        const { stdout } = await execFile('codex', args, {
          maxBuffer: 1024 * 1024 * 8,
          timeout: 120_000,
          signal,
          env: {
            ...process.env,
            CODEX_HOME: execCodexHome,
            OTEL_SDK_DISABLED: 'true',
          },
        });

        let text = '';
        try {
          text = (await fsp.readFile(tmpFile, 'utf8')).trim();
        } catch {
          text = String(stdout || '').trim();
        }

        if (!text) {
          throw new Error('Codex CLI provider produced empty output.');
        }
        return text;
      } catch (err) {
        throw new Error(`Codex CLI session provider failed: ${err.message}`);
      } finally {
        try {
          await fsp.unlink(tmpFile);
        } catch {}
        try {
          await fsp.rm(execCodexHome, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

function createCodexTokenProvider({
  configuredModel,
  configuredBaseUrl,
  codexAuth,
  thinkingEffort = '',
}) {
  const model = configuredModel || codexAuth.model;
  const responsesUrl = resolveCodexResponsesUrl(
    configuredBaseUrl ||
      process.env.PIECODE_CODEX_BASE_URL ||
      process.env.CODEX_CHATGPT_BASE_URL ||
      process.env.CODEX_BASE_URL ||
      DEFAULT_CODEX_BACKEND_BASE_URL
  );
  const accountId = extractCodexAccountId(codexAuth.accessToken);
  const headers = buildCodexBackendHeaders(codexAuth.accessToken, accountId);

  return {
    kind: 'codex-auth-token',
    model,
    thinkingEffort: normalizeThinkingEffort(thinkingEffort),
    supportsNativeTools: true,
    _lastUsage: null,
    getLastUsage() {
      return this._lastUsage || null;
    },
    buildResponsesBody(systemPrompt, prompt) {
      return withResponsesReasoningEffort(
        {
          model,
          store: false,
          instructions: systemPrompt,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: prompt }] },
          ],
          text: { verbosity: 'medium' },
          include: ['reasoning.encrypted_content'],
        },
        thinkingEffort
      );
    },
    buildNativeResponsesBody(systemPrompt, messages, tools) {
      const input = convertOpenAIMessagesToResponsesInput(messages);
      const convertedTools = convertOpenAIToolsToResponsesTools(tools);
      return withResponsesReasoningEffort(
        {
          model,
          store: false,
          instructions: systemPrompt,
          input,
          text: { verbosity: 'medium' },
          include: ['reasoning.encrypted_content'],
          tool_choice: 'auto',
          parallel_tool_calls: true,
          ...(convertedTools.length > 0 ? { tools: convertedTools } : {}),
        },
        thinkingEffort
      );
    },
    async complete({ systemPrompt, prompt, messages, tools, signal }) {
      this._lastUsage = null;
      if (Array.isArray(messages) && Array.isArray(tools)) {
        const streamed = await postResponsesStreamNative(
          responsesUrl,
          headers,
          this.buildNativeResponsesBody(systemPrompt, messages, tools),
          null,
          { signal }
        );
        this._lastUsage = streamed.usage || null;
        return {
          type: 'native',
          format: 'openai',
          message: streamed.message,
          finishReason: streamed.finishReason,
          usage: this._lastUsage || null,
        };
      }
      const streamed = await postResponsesStream(
        responsesUrl,
        headers,
        this.buildResponsesBody(systemPrompt, prompt),
        null,
        { signal }
      );
      this._lastUsage = streamed.usage || null;
      if (streamed.text) return streamed.text;
      throw new Error('Codex auth response did not contain text output.');
    },
    async completeStream({ systemPrompt, prompt, messages, tools, onDelta, signal }) {
      this._lastUsage = null;
      if (Array.isArray(messages) && Array.isArray(tools)) {
        const streamed = await postResponsesStreamNative(
          responsesUrl,
          headers,
          this.buildNativeResponsesBody(systemPrompt, messages, tools),
          onDelta,
          { signal }
        );
        this._lastUsage = streamed.usage || null;
        return {
          type: 'native',
          format: 'openai',
          message: streamed.message,
          finishReason: streamed.finishReason,
          usage: this._lastUsage || null,
        };
      }
      const streamed = await postResponsesStream(
        responsesUrl,
        headers,
        this.buildResponsesBody(systemPrompt, prompt),
        onDelta,
        { signal }
      );
      this._lastUsage = streamed.usage || null;
      if (streamed.text) return streamed.text;
      throw new Error('Codex auth stream did not contain text output.');
    },
  };
}

function createCodexDirectProvider({
  configuredModel,
  configuredBaseUrl,
  codexAuth,
  thinkingEffort = '',
}) {
  if (codexAuth?.openaiApiKey) {
    return createOpenAICompatibleProvider({
      kind: 'codex-auth-key',
      model:
        configuredModel || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      apiKey: codexAuth.openaiApiKey,
      baseUrl:
        configuredBaseUrl ||
        process.env.OPENAI_BASE_URL ||
        'https://api.openai.com/v1',
      thinkingEffort,
    });
  }

  if (codexAuth?.accessToken) {
    return createCodexTokenProvider({
      configuredModel,
      configuredBaseUrl,
      codexAuth,
      thinkingEffort,
    });
  }

  return null;
}

function prefersCodexCli() {
  return process.env.PIECODE_CODEX_PREFER_CLI === '1';
}

/**
 * Stream an Anthropic Messages response, reassembling the SSE content blocks
 * into the same `content` array shape the non-streaming call returns.
 */
async function postAnthropicStream(url, headers, body, onChunk, options = {}) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let abortListener = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    abortListener = () => controller.abort();
    externalSignal.addEventListener('abort', abortListener, { once: true });
  }
  const timeout = createAbortTimeout(controller);
  const abortError = () => {
    if (externalSignal?.aborted) {
      const err = new Error('Model stream aborted.');
      err.code = 'ABORT_ERR';
      return err;
    }
    return new Error(`Model stream timed out after ${DEFAULT_MODEL_TIMEOUT_MS}ms`);
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
    if (err?.name === 'AbortError') throw abortError();
    throw modelNetworkError('Model stream', url, err);
  }
  timeout.refresh();

  try {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(`Model API error (${res.status}): ${JSON.stringify(data)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    if (!res.body) return { content: [], stopReason: '', usage: null, text: '' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason = '';
    let usage = null;
    const blocks = new Map();

    while (true) {
      let packet;
      try {
        packet = await reader.read();
      } catch (err) {
        if (err?.name === 'AbortError') throw abortError();
        throw modelNetworkError('Model stream', url, err);
      }
      if (packet.done) break;
      timeout.refresh();
      buffer += decoder.decode(packet.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        const index = Number.isInteger(event?.index) ? event.index : 0;
        switch (event?.type) {
          case 'message_start': {
            const started = normalizeUsage(event?.message?.usage);
            if (started) usage = { ...(usage || {}), ...started };
            break;
          }
          case 'content_block_start': {
            const block = event?.content_block || {};
            blocks.set(index, {
              type: block.type || 'text',
              text: typeof block.text === 'string' ? block.text : '',
              id: block.id || '',
              name: block.name || '',
              partialJson: '',
            });
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(index) || { type: 'text', text: '', partialJson: '' };
            const delta = event?.delta || {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              block.text += delta.text;
              onChunk?.(delta.text);
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              onChunk?.(delta.thinking);
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              block.partialJson += delta.partial_json;
              timeout.refresh();
            }
            blocks.set(index, block);
            break;
          }
          case 'message_delta': {
            if (typeof event?.delta?.stop_reason === 'string' && event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            const deltaUsage = normalizeUsage(event?.usage);
            if (deltaUsage) usage = { ...(usage || {}), ...deltaUsage };
            break;
          }
          default:
            break;
        }
      }
    }

    const content = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => {
        if (block.type === 'tool_use') {
          let input = {};
          try {
            input = block.partialJson ? JSON.parse(block.partialJson) : {};
          } catch {
            input = {};
          }
          return { type: 'tool_use', id: block.id, name: block.name, input };
        }
        return { type: 'text', text: block.text };
      });

    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (usage && usage.input_tokens != null && usage.output_tokens != null && usage.total_tokens == null) {
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
    }
    return { content, stopReason, usage, text };
  } finally {
    timeout.clear();
    if (externalSignal && abortListener) {
      try {
        externalSignal.removeEventListener('abort', abortListener);
      } catch {}
    }
  }
}

function resolveAnthropicMessagesUrl(baseUrl) {
  const raw = String(baseUrl || '').trim() || 'https://api.anthropic.com/v1';
  const normalized = raw.replace(/\/+$/, '');
  if (normalized.endsWith('/messages')) return normalized;
  return `${normalized}/messages`;
}

const ANTHROPIC_MAX_OUTPUT_TOKENS = Math.max(
  512,
  Number.parseInt(process.env.PIECODE_ANTHROPIC_MAX_TOKENS || '8192', 10) || 8192
);

function createAnthropicProvider({ apiKey, model, baseUrl = '', thinkingEffort = '' }) {
  const messagesUrl = resolveAnthropicMessagesUrl(baseUrl);
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  return {
    kind: 'anthropic',
    providerId: 'anthropic',
    model,
    baseUrl: messagesUrl.replace(/\/messages$/, ''),
    thinkingEffort: normalizeThinkingEffort(thinkingEffort),
    reasoningEffortOptions: [],
    supportsReasoningEffort: false,
    supportsNativeTools: true,
    _lastUsage: null,
    getLastUsage() {
      return this._lastUsage || null;
    },
    buildBody({ systemPrompt, prompt, messages, tools }) {
      const useNative = Array.isArray(messages) && Array.isArray(tools);
      return useNative
        ? {
            model,
            max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
            system: systemPrompt,
            messages,
            ...(tools.length > 0 ? { tools } : {}),
          }
        : {
            model,
            max_tokens: Math.min(ANTHROPIC_MAX_OUTPUT_TOKENS, 4096),
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          };
    },
    async complete({ systemPrompt, prompt, messages, tools, signal }) {
      this._lastUsage = null;
      const useNative = Array.isArray(messages) && Array.isArray(tools);
      const data = await postJson(
        messagesUrl,
        headers,
        this.buildBody({ systemPrompt, prompt, messages, tools }),
        { signal }
      );
      this._lastUsage = normalizeUsage(data?.usage);
      if (useNative) {
        return {
          type: 'native',
          format: 'anthropic',
          content: Array.isArray(data?.content) ? data.content : [],
          stopReason: data?.stop_reason || '',
          usage: this._lastUsage || null,
        };
      }
      const text = data?.content?.find((c) => c?.type === 'text')?.text;
      if (!text)
        throw new Error('Anthropic response did not contain text content.');
      return text;
    },
    async completeStream({ systemPrompt, prompt, messages, tools, onDelta, signal }) {
      this._lastUsage = null;
      const useNative = Array.isArray(messages) && Array.isArray(tools);
      const streamed = await postAnthropicStream(
        messagesUrl,
        headers,
        this.buildBody({ systemPrompt, prompt, messages, tools }),
        onDelta,
        { signal }
      );
      this._lastUsage = streamed.usage || null;
      if (useNative) {
        return {
          type: 'native',
          format: 'anthropic',
          content: streamed.content,
          stopReason: streamed.stopReason,
          usage: this._lastUsage || null,
        };
      }
      if (streamed.text) return streamed.text;
      throw new Error('Anthropic stream did not contain text content.');
    },
  };
}

function looksLikeCodexModel(modelName) {
  const name = String(modelName || '')
    .trim()
    .toLowerCase();
  return Boolean(name) && (name.includes('codex') || name.startsWith('gpt-5'));
}

/**
 * Historical `kind` strings, kept so sessions, traces and the UI stay stable.
 * New providers get a predictable `<id>-openai-compatible` kind.
 */
const LEGACY_PROVIDER_KINDS = {
  openai: 'openai-compatible',
  openrouter: 'openrouter-compatible',
  seed: 'seed-openai-compatible',
};

function providerKindFor(providerId) {
  return LEGACY_PROVIDER_KINDS[providerId] || `${providerId}-openai-compatible`;
}

/**
 * Providers considered during the last-resort auto-detection sweep, after the
 * historical anthropic/openai/openrouter/codex order has been exhausted.
 */
function listRegistryFallbackOrder() {
  const alreadyTried = new Set(['anthropic', 'openai', 'openrouter', 'codex', 'codex-local']);
  return listProviderSpecs().filter(
    (spec) => spec.transport === TRANSPORTS.OPENAI && !alreadyTried.has(spec.id)
  );
}

function providerExtraHeaders(providerId, config) {
  const fromSettings = config?.extraHeaders || {};
  if (providerId === 'openrouter') {
    return {
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://piecode.local',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Piecode',
      ...fromSettings,
    };
  }
  return fromSettings;
}

/**
 * Build any registry provider that speaks an OpenAI-compatible dialect.
 * Returns null when the provider is not usable (missing key, unknown id).
 */
function createRegistryProvider(
  providerId,
  { model = '', apiKey = '', baseUrl = '', thinkingEffort = '', settings = {}, required = false } = {}
) {
  const id = normalizeProviderId(providerId);
  const spec = getProviderSpec(id);
  if (!spec || spec.transport !== TRANSPORTS.OPENAI) return null;

  const config = resolveProviderConfig(id, { settings });
  const effectiveKey = apiKey || config.apiKey;
  // Auto-detection must never pick a provider the user has not set up — a local
  // server that needs no key still needs an explicit opt-in.
  if (!required && !config.configured && !baseUrl && !apiKey) return null;
  if (config.needsKey && !effectiveKey) {
    if (!required) return null;
    const envName = spec.apiKeyEnv?.[0] || '';
    throw new Error(
      `Missing API key for ${spec.label} (${id}). ${
        envName ? `Set ${envName}` : 'Configure it in ~/.piecode/settings.json'
      } or pass --api-key.`
    );
  }

  return createOpenAICompatibleProvider({
    kind: providerKindFor(id),
    providerId: id,
    model: model || config.model || spec.defaultModel,
    apiKey: effectiveKey || (spec.optionalApiKey ? 'local' : ''),
    baseUrl: baseUrl || config.baseUrl || spec.defaultBaseUrl,
    thinkingEffort,
    reasoningEfforts: config.reasoningEfforts,
    extraHeaders: providerExtraHeaders(id, config),
  });
}

function createCodexProviderChain({ configuredModel, configuredBaseUrl, thinkingEffort, settings }) {
  const codexAuth = loadCodexAuth();
  if (!prefersCodexCli()) {
    const directProvider = createCodexDirectProvider({
      configuredModel,
      configuredBaseUrl,
      codexAuth,
      thinkingEffort,
    });
    if (directProvider) return directProvider;
  }
  if (hasCodexCliSession()) {
    const cliProvider = createCodexCliProvider(configuredModel, thinkingEffort);
    if (cliProvider) return cliProvider;
  }
  // Last resort for codex: a locally running Codex-compatible server.
  return createCodexLocalProvider({
    configuredModel,
    configuredBaseUrl,
    thinkingEffort,
    reasoningEfforts: resolveProviderConfig('codex-local', { settings }).reasoningEfforts,
  });
}

export function getProvider(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const rawModel = options.model || '';
  // `--model deepseek:deepseek-chat` selects both provider and model.
  const parsedRef = parseModelRef(rawModel);
  const configuredModel = parsedRef.model || rawModel || null;
  const configuredBaseUrl = options.baseUrl || options.endpoint || null;
  const configuredApiKey = options.apiKey || null;
  const configuredThinkingEffort = normalizeThinkingEffort(
    options.thinkingEffort || options.thinking_effort || options.reasoningEffort || options.reasoning_effort
  );
  const requestedProvider = normalizeProviderId(options.provider || parsedRef.provider || '');

  // 1. Explicitly requested provider wins.
  if (requestedProvider) {
    if (requestedProvider === 'anthropic') {
      const config = resolveProviderConfig('anthropic', { settings });
      const apiKey = configuredApiKey || config.apiKey;
      if (apiKey) {
        return createAnthropicProvider({
          apiKey,
          model: configuredModel || config.model || DEFAULT_ANTHROPIC_MODEL,
          baseUrl: configuredBaseUrl || config.baseUrl,
          thinkingEffort: configuredThinkingEffort,
        });
      }
    } else if (requestedProvider === 'codex') {
      const provider = createCodexProviderChain({
        configuredModel,
        configuredBaseUrl,
        thinkingEffort: configuredThinkingEffort,
        settings,
      });
      if (provider) return provider;
    } else if (requestedProvider === 'codex-local') {
      const provider = createCodexLocalProvider({
        configuredModel,
        configuredBaseUrl,
        configuredApiKey,
        thinkingEffort: configuredThinkingEffort,
      });
      if (provider) return provider;
      throw new Error(
        'No local Codex endpoint found. Start one and set CODEX_LOCAL_BASE_URL, or configure [model_providers.*] in ~/.codex/config.toml.'
      );
    } else if (isKnownProvider(requestedProvider)) {
      const provider = createRegistryProvider(requestedProvider, {
        model: configuredModel,
        apiKey: configuredApiKey,
        baseUrl: configuredBaseUrl,
        thinkingEffort: configuredThinkingEffort,
        settings,
        required: true,
      });
      if (provider) return provider;
    } else {
      throw new Error(
        `Unknown provider: ${requestedProvider}. Run \`/provider\` to see the supported providers.`
      );
    }
  }

  // 2. A codex-shaped model prefers codex auth over generic key fallbacks.
  if (looksLikeCodexModel(configuredModel)) {
    const provider = createCodexProviderChain({
      configuredModel,
      configuredBaseUrl,
      thinkingEffort: configuredThinkingEffort,
      settings,
    });
    if (provider) return provider;
  }

  // 3. A bare model id that clearly belongs to one provider selects it.
  const inferred = normalizeProviderId(inferProviderForModel(configuredModel));
  if (inferred && inferred !== requestedProvider && isKnownProvider(inferred)) {
    const provider = createRegistryProvider(inferred, {
      model: configuredModel,
      apiKey: configuredApiKey,
      baseUrl: configuredBaseUrl,
      thinkingEffort: configuredThinkingEffort,
      settings,
    });
    if (provider) return provider;
    if (inferred === 'anthropic') {
      const config = resolveProviderConfig('anthropic', { settings });
      const apiKey = configuredApiKey || config.apiKey;
      if (apiKey) {
        return createAnthropicProvider({
          apiKey,
          model: configuredModel,
          baseUrl: configuredBaseUrl || config.baseUrl,
          thinkingEffort: configuredThinkingEffort,
        });
      }
    }
  }

  // 4. Environment fallbacks, in the historical priority order.
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({
      apiKey: requireEnv('ANTHROPIC_API_KEY'),
      model: configuredModel || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      baseUrl: configuredBaseUrl || process.env.ANTHROPIC_BASE_URL || '',
      thinkingEffort: configuredThinkingEffort,
    });
  }

  for (const fallbackId of ['openai', 'openrouter']) {
    const provider = createRegistryProvider(fallbackId, {
      model: configuredModel,
      apiKey: configuredApiKey,
      baseUrl: configuredBaseUrl,
      thinkingEffort: configuredThinkingEffort,
      settings,
    });
    if (provider) return provider;
  }

  // 5. Codex login / local Codex endpoint.
  const codexProvider = createCodexProviderChain({
    configuredModel,
    configuredBaseUrl,
    thinkingEffort: configuredThinkingEffort,
    settings,
  });
  if (codexProvider) return codexProvider;

  // 6. Any other provider the user has configured, including local servers.
  for (const spec of listRegistryFallbackOrder()) {
    const provider = createRegistryProvider(spec.id, {
      model: configuredModel,
      apiKey: configuredApiKey,
      baseUrl: configuredBaseUrl,
      thinkingEffort: configuredThinkingEffort,
      settings,
    });
    if (provider) return provider;
  }

  throw new Error(
    'No model provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY (or another provider key), run `codex login`, or start a local server. Run `piecode --doctor` for details.'
  );
}

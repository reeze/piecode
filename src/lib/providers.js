import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const DEFAULT_ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const DEFAULT_OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini';
const DEFAULT_OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.3-codex';
const DEFAULT_CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_ACCOUNT_CLAIM = 'https://api.openai.com/auth';
const DEFAULT_SEED_MODEL =
  process.env.SEED_MODEL || 'doubao-seed-code-preview-latest';
const DEFAULT_SEED_BASE_URL =
  process.env.SEED_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding';
const DEFAULT_MODEL_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.PIECODE_MODEL_TIMEOUT_MS || '120000', 10) ||
    120_000
);
const execFile = promisify(execFileCb);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_MODEL_TIMEOUT_MS
  );
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
    throw err;
  } finally {
    clearTimeout(timeout);
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
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_MODEL_TIMEOUT_MS
  );
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
    clearTimeout(timeout);
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
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_MODEL_TIMEOUT_MS
  );
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
    clearTimeout(timeout);
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
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_MODEL_TIMEOUT_MS
  );
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
        throw err;
      }
      const { done, value } = packet;
      if (done) break;
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
                current.function.name += item.function.name;
              }
              if (
                typeof item.function.arguments === 'string' &&
                item.function.arguments
              ) {
                current.function.arguments += item.function.arguments;
                onChunk?.(item.function.arguments);
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
    clearTimeout(timeout);
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
  const resolvedModel = resolveCodexModel(
    codexHome,
    process.env.CODEX_MODEL || configModel || DEFAULT_CODEX_MODEL
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
  if (Array.isArray(content)) return content;
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

function createOpenAICompatibleProvider({
  kind,
  model,
  apiKey,
  baseUrl,
  extraHeaders = {},
}) {
  const normalizedBase = (baseUrl || 'https://api.openai.com/v1').replace(
    /\/$/,
    ''
  );
  const chatUrl = normalizedBase.endsWith('/chat/completions')
    ? normalizedBase
    : `${normalizedBase}/chat/completions`;

  return {
    kind,
    model,
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
            temperature: 0.2,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            tools,
          }
        : {
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          };
      const data = await postJson(
        chatUrl,
        { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body,
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
          {
            model,
            temperature: 0.2,
            stream: true,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            tools,
          },
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
        {
          model,
          temperature: 0.2,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        },
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

function buildSeedChatUrls(baseUrl) {
  const base = (baseUrl || DEFAULT_SEED_BASE_URL).replace(/\/$/, '');
  const urls = [];
  if (base.endsWith('/chat/completions')) {
    urls.push(base);
  } else {
    urls.push(`${base}/chat/completions`);
    urls.push(`${base}/v1/chat/completions`);
  }

  if (base.includes('/api/coding')) {
    try {
      const u = new URL(base);
      urls.push(`${u.origin}/api/v3/chat/completions`);
    } catch {}
  }

  return [...new Set(urls)];
}

function extractAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.find(
    (b) => b?.type === 'text' && typeof b?.text === 'string'
  )?.text;
  return text || '';
}

function createSeedProvider({ model, apiKey, baseUrl }) {
  const resolvedModel = model || DEFAULT_SEED_MODEL;
  const resolvedBase = baseUrl || DEFAULT_SEED_BASE_URL;

  return {
    kind: 'seed-openai-compatible',
    model: resolvedModel,
    supportsNativeTools: true,
    _lastUsage: null,
    getLastUsage() {
      return this._lastUsage || null;
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
        const nativeBody = {
          model: resolvedModel,
          temperature: 0.2,
          stream: true,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          tools,
        };
        let lastErr = null;
        for (const url of buildSeedChatUrls(resolvedBase)) {
          try {
            const streamed = await postJsonStreamOpenAINative(
              url,
              { Authorization: `Bearer ${apiKey}` },
              nativeBody,
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
          } catch (err) {
            lastErr = err;
            if (err?.status !== 404) break;
          }
        }
        return this.complete({
          systemPrompt,
          prompt,
          messages,
          tools,
          signal,
        }).catch((err) => {
          throw new Error(
            `Seed native stream failed. Last stream error: ${lastErr?.message || 'unknown'}. Fallback error: ${err?.message || 'unknown'}`
          );
        });
      }
      const chatUrls = buildSeedChatUrls(resolvedBase);
      const openaiBody = {
        model: resolvedModel,
        temperature: 0.2,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      };

      let lastErr = null;
      for (const url of chatUrls) {
        try {
          const streamed = await postJsonStream(
            url,
            { Authorization: `Bearer ${apiKey}` },
            openaiBody,
            onDelta,
            { signal }
          );
          this._lastUsage = streamed?.usage || null;
          const text = String(streamed?.text || '');
          if (text) return text;
        } catch (err) {
          lastErr = err;
          if (err?.status !== 404) {
            break;
          }
        }
      }

      // Fall back to non-stream mode when streaming is unavailable upstream.
      return this.complete({ systemPrompt, prompt, signal }).catch((err) => {
        throw new Error(
          `Seed stream failed. Last stream error: ${lastErr?.message || 'unknown'}. Fallback error: ${err?.message || 'unknown'}`
        );
      });
    },
    async complete({ systemPrompt, prompt, messages, tools, signal }) {
      this._lastUsage = null;
      const useNative = Array.isArray(messages) && Array.isArray(tools);
      const chatUrls = buildSeedChatUrls(resolvedBase);
      const openaiBody = useNative
        ? {
            model: resolvedModel,
            temperature: 0.2,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            tools,
          }
        : {
            model: resolvedModel,
            temperature: 0.2,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          };

      let lastErr = null;
      for (const url of chatUrls) {
        try {
          const data = await postJson(
            url,
            { Authorization: `Bearer ${apiKey}` },
            openaiBody,
            { signal }
          );
          this._lastUsage = normalizeUsage(data?.usage);
          if (useNative) {
            const msg = data?.choices?.[0]?.message;
            if (msg) {
              return {
                type: 'native',
                format: 'openai',
                message: msg,
                finishReason: data?.choices?.[0]?.finish_reason,
                usage: this._lastUsage || null,
              };
            }
          }
          const text = data?.choices?.[0]?.message?.content;
          if (text) return text;
        } catch (err) {
          lastErr = err;
          if (err?.status !== 404) {
            break;
          }
        }
      }

      // Do not attempt Anthropic-text fallback for native tool calls.
      // It needs `prompt` text and incompatible schema, causing misleading errors.
      if (useNative) {
        throw new Error(
          `Seed provider native call failed. Tried: ${chatUrls.join(', ')}. Last error: ${lastErr?.message || 'unknown'}`
        );
      }

      // Claude-compatible fallback for /api/coding deployments.
      const anthropicUrl = `${resolvedBase.replace(/\/$/, '')}/v1/messages`;
      const anthropicBody = {
        model: resolvedModel,
        max_tokens: 1600,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      };
      const anthHeaders = [
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          Authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
      ];

      for (const headers of anthHeaders) {
        try {
          const data = await postJson(anthropicUrl, headers, anthropicBody, {
            signal,
          });
          this._lastUsage = normalizeUsage(data?.usage);
          const text = extractAnthropicText(data);
          if (text) return text;
        } catch (err) {
          lastErr = err;
        }
      }

      throw new Error(
        `Seed provider failed. Tried: ${chatUrls.join(', ')}, ${anthropicUrl}. Last error: ${lastErr?.message || 'unknown'}`
      );
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

function createCodexCliProvider(customModel = null) {
  const codexHome = getCodexHome();
  const requestedModel = customModel || process.env.CODEX_MODEL || null;
  const model = requestedModel || resolveCodexModel(codexHome, null);
  return {
    kind: 'codex-cli-session',
    model,
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
    supportsNativeTools: true,
    _lastUsage: null,
    getLastUsage() {
      return this._lastUsage || null;
    },
    buildResponsesBody(systemPrompt, prompt) {
      return {
        model,
        store: false,
        instructions: systemPrompt,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
        ],
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
      };
    },
    buildNativeResponsesBody(systemPrompt, messages, tools) {
      const input = convertOpenAIMessagesToResponsesInput(messages);
      const convertedTools = convertOpenAIToolsToResponsesTools(tools);
      return {
        model,
        store: false,
        instructions: systemPrompt,
        input,
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        ...(convertedTools.length > 0 ? { tools: convertedTools } : {}),
      };
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
    });
  }

  if (codexAuth?.accessToken) {
    return createCodexTokenProvider({
      configuredModel,
      configuredBaseUrl,
      codexAuth,
    });
  }

  return null;
}

function prefersCodexCli() {
  return process.env.PIECODE_CODEX_PREFER_CLI === '1';
}

function createAnthropicProvider({ apiKey, model }) {
  return {
    kind: 'anthropic',
    model,
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
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            tools,
          }
        : {
            model,
            max_tokens: 1600,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          };
      const data = await postJson(
        'https://api.anthropic.com/v1/messages',
        {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
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
  };
}

function looksLikeCodexModel(modelName) {
  const name = String(modelName || '')
    .trim()
    .toLowerCase();
  return Boolean(name) && (name.includes('codex') || name.startsWith('gpt-5'));
}

export function getProvider(options = {}) {
  const configuredModel = options.model || null;
  const configuredBaseUrl = options.baseUrl || options.endpoint || null;
  const configuredApiKey = options.apiKey || null;

  // Command line arguments take highest priority
  if (options.provider) {
    const provider = options.provider.toLowerCase();

    if (provider === 'anthropic' && options.apiKey) {
      return createAnthropicProvider({
        apiKey: options.apiKey,
        model:
          options.model ||
          process.env.ANTHROPIC_MODEL ||
          DEFAULT_ANTHROPIC_MODEL,
      });
    }

    if (provider === 'openai' && configuredApiKey) {
      return createOpenAICompatibleProvider({
        kind: 'openai-compatible',
        model:
          configuredModel || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
        apiKey: configuredApiKey,
        baseUrl:
          configuredBaseUrl ||
          process.env.OPENAI_BASE_URL ||
          'https://api.openai.com/v1',
      });
    }

    if (provider === 'openrouter') {
      const openRouterApiKey =
        configuredApiKey || process.env.OPENROUTER_API_KEY;
      if (!openRouterApiKey) {
        throw new Error(
          'Missing API key for openrouter provider. Set OPENROUTER_API_KEY or pass --api-key.'
        );
      }
      return createOpenAICompatibleProvider({
        kind: 'openrouter-compatible',
        model: configuredModel || DEFAULT_OPENROUTER_MODEL,
        apiKey: openRouterApiKey,
        baseUrl: configuredBaseUrl || DEFAULT_OPENROUTER_BASE_URL,
        extraHeaders: {
          'HTTP-Referer':
            process.env.OPENROUTER_SITE_URL || 'https://piecode.local',
          'X-Title': process.env.OPENROUTER_APP_NAME || 'Piecode',
        },
      });
    }

    if (provider === 'seed') {
      const seedApiKey =
        configuredApiKey || process.env.SEED_API_KEY || process.env.ARK_API_KEY;
      if (!seedApiKey) {
        throw new Error(
          'Missing API key for seed provider. Set SEED_API_KEY or pass --api-key.'
        );
      }
      return createSeedProvider({
        model: configuredModel || DEFAULT_SEED_MODEL,
        apiKey: seedApiKey,
        baseUrl: configuredBaseUrl || DEFAULT_SEED_BASE_URL,
      });
    }

    if (provider === 'codex') {
      const codexAuth = loadCodexAuth();
      if (!prefersCodexCli()) {
        const directProvider = createCodexDirectProvider({
          configuredModel,
          configuredBaseUrl,
          codexAuth,
        });
        if (directProvider) {
          return directProvider;
        }
      }
      const cliAvailable = hasCodexCliSession();
      const cliProvider = cliAvailable
        ? createCodexCliProvider(options.model)
        : null;
      if (cliProvider) return cliProvider;
    }
  }

  // If the selected model is codex-like, prefer codex auth/session before other key-based fallbacks.
  if (looksLikeCodexModel(configuredModel)) {
    const codexAuth = loadCodexAuth();
    if (!prefersCodexCli()) {
      const directProvider = createCodexDirectProvider({
        configuredModel,
        configuredBaseUrl,
        codexAuth,
      });
      if (directProvider) {
        return directProvider;
      }
    }
    const cliAvailable = hasCodexCliSession();
    const cliProvider = cliAvailable
      ? createCodexCliProvider(configuredModel)
      : null;
    if (cliProvider) return cliProvider;
  }

  // Environment variables (original behavior)
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({
      apiKey: requireEnv('ANTHROPIC_API_KEY'),
      model:
        configuredModel ||
        process.env.ANTHROPIC_MODEL ||
        DEFAULT_ANTHROPIC_MODEL,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    return createOpenAICompatibleProvider({
      kind: 'openai-compatible',
      model:
        configuredModel || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      apiKey: requireEnv('OPENAI_API_KEY'),
      baseUrl:
        configuredBaseUrl ||
        process.env.OPENAI_BASE_URL ||
        'https://api.openai.com/v1',
    });
  }

  if (process.env.OPENROUTER_API_KEY) {
    return createOpenAICompatibleProvider({
      kind: 'openrouter-compatible',
      model: configuredModel || DEFAULT_OPENROUTER_MODEL,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: configuredBaseUrl || DEFAULT_OPENROUTER_BASE_URL,
      extraHeaders: {
        'HTTP-Referer':
          process.env.OPENROUTER_SITE_URL || 'https://piecode.local',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Piecode',
      },
    });
  }

  if (process.env.SEED_API_KEY || process.env.ARK_API_KEY) {
    return createSeedProvider({
      model: configuredModel || DEFAULT_SEED_MODEL,
      apiKey: process.env.SEED_API_KEY || process.env.ARK_API_KEY,
      baseUrl: configuredBaseUrl || DEFAULT_SEED_BASE_URL,
    });
  }

  const codexAuth = loadCodexAuth();
  if (!prefersCodexCli()) {
    const directProvider = createCodexDirectProvider({
      configuredModel,
      configuredBaseUrl,
      codexAuth,
    });
    if (directProvider) {
      return directProvider;
    }
  }
  const cliAvailable = hasCodexCliSession();
  const cliProvider = cliAvailable
    ? createCodexCliProvider(configuredModel)
    : null;
  if (cliProvider) return cliProvider;

  throw new Error(
    'No model provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or run `codex login`.'
  );
}

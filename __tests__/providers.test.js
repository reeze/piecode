import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider } from '../src/lib/providers.js';

function createCodexTestToken(accountId = 'acct_test') {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
    'signature',
  ].join('.');
}

describe('provider selection', () => {
  test('creates openrouter provider when explicitly selected', () => {
    const provider = getProvider({
      provider: 'openrouter',
      apiKey: 'or-test-key',
      model: 'anthropic/claude-3.5-sonnet',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    expect(provider.kind).toBe('openrouter-compatible');
    expect(provider.model).toBe('anthropic/claude-3.5-sonnet');
  });

  test('uses OPENROUTER_API_KEY fallback when no provider is specified', () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-test-env-key';
    try {
      const provider = getProvider({ model: 'openai/gpt-4.1-mini' });
      expect(provider.kind).toBe('openrouter-compatible');
      expect(provider.model).toBe('openai/gpt-4.1-mini');
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  test('seed provider exposes stream completion', () => {
    const provider = getProvider({
      provider: 'seed',
      apiKey: 'seed-test-key',
      model: 'doubao-seed-code-preview-latest',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    });
    expect(provider.kind).toBe('seed-openai-compatible');
    expect(typeof provider.completeStream).toBe('function');
  });

  test('openrouter native completeStream emits deltas and returns tool call message', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"cli.js\\"}"}}]}}]}\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":123,"completion_tokens":17,"total_tokens":140}}\n',
        'data: [DONE]\n',
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    try {
      const provider = getProvider({
        provider: 'openrouter',
        apiKey: 'or-test-key',
        model: 'anthropic/claude-sonnet-4.5',
        baseUrl: 'https://openrouter.ai/api/v1',
      });

      const deltas = [];
      const response = await provider.completeStream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'read cli' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read file',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        onDelta: (chunk) => deltas.push(String(chunk || '')),
      });

      expect(response?.type).toBe('native');
      expect(response?.format).toBe('openai');
      expect(response?.finishReason).toBe('tool_calls');
      expect(response?.message?.tool_calls?.[0]?.function?.name).toBe(
        'read_file'
      );
      expect(response?.message?.tool_calls?.[0]?.function?.arguments).toBe(
        '{"path":"src/cli.js"}'
      );
      expect(response?.usage).toEqual({
        input_tokens: 123,
        output_tokens: 17,
        total_tokens: 140,
      });
      expect(provider.getLastUsage()).toEqual({
        input_tokens: 123,
        output_tokens: 17,
        total_tokens: 140,
      });
      expect(deltas.join('')).toContain('"path":"src/cli.js"');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('openai-compatible providers include configured thinking effort', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.reasoning_effort).toBe('xhigh');
      expect(body.reasoning).toMatchObject({ effort: 'xhigh' });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    try {
      const provider = getProvider({
        provider: 'openai',
        apiKey: 'openai-test-key',
        model: 'gpt-5-mini',
        thinkingEffort: 'extra-high',
      });
      expect(provider.thinkingEffort).toBe('xhigh');
      await provider.complete({ systemPrompt: 'sys', prompt: 'hello' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('anthropic provider does not send openai reasoning fields', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.thinking).toBeUndefined();
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    try {
      const provider = getProvider({
        provider: 'anthropic',
        apiKey: 'anthropic-test-key',
        model: 'claude-test',
        thinkingEffort: 'high',
      });
      expect(provider.thinkingEffort).toBe('high');
      await provider.complete({ systemPrompt: 'sys', prompt: 'hello' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('openrouter complete stores normalized usage metadata', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'done' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );

    try {
      const provider = getProvider({
        provider: 'openrouter',
        apiKey: 'or-test-key',
        model: 'anthropic/claude-sonnet-4.5',
        baseUrl: 'https://openrouter.ai/api/v1',
      });
      const text = await provider.complete({
        systemPrompt: 'sys',
        prompt: 'say done',
      });
      expect(text).toBe('done');
      expect(provider.getLastUsage()).toEqual({
        input_tokens: 21,
        output_tokens: 9,
        total_tokens: 30,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('codex token provider streams Responses API text deltas', async () => {
    const originalFetch = global.fetch;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalDisableCli = process.env.PIECODE_DISABLE_CODEX_CLI;
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'piecode-provider-test-')
    );

    process.env.CODEX_HOME = tmp;
    process.env.PIECODE_DISABLE_CODEX_CLI = '1';
    const codexToken = createCodexTestToken();
    await fs.writeFile(
      path.join(tmp, 'auth.json'),
      JSON.stringify({ tokens: { access_token: codexToken } }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmp, 'config.toml'),
      'model = "gpt-5.3-codex"\n',
      'utf8'
    );

    global.fetch = async (url, init) => {
      expect(String(url)).toBe(
        'https://chatgpt.com/backend-api/codex/responses'
      );
      expect(String(url)).not.toContain('api.openai.com');
      expect(init?.headers?.Authorization).toBe(`Bearer ${codexToken}`);
      expect(init?.headers?.['chatgpt-account-id']).toBe('acct_test');
      expect(init?.headers?.originator).toBe('piecode');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.store).toBe(false);
      expect(body.instructions).toBe('sys');
      expect(body.input?.[0]?.role).toBe('user');
      expect(body.reasoning).toMatchObject({ effort: 'high' });
      expect(body.thinking).toBeUndefined();
      const chunks = [
        'data: {"type":"response.output_text.delta","delta":"{\\"type\\":\\"final\\","}\n\n',
        'data: {"type":"response.output_text.delta","delta":"\\"message\\":\\"done\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18},"output":[{"content":[{"type":"output_text","text":"{\\"type\\":\\"final\\",\\"message\\":\\"done\\"}"}]}]}}\n\n',
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    try {
      const provider = getProvider({ provider: 'codex', thinkingEffort: 'high' });
      expect(provider.thinkingEffort).toBe('high');
      const deltas = [];
      const text = await provider.completeStream({
        systemPrompt: 'sys',
        prompt: 'reply',
        onDelta: (chunk) => deltas.push(String(chunk || '')),
      });

      expect(provider.kind).toBe('codex-auth-token');
      expect(provider.supportsNativeTools).toBe(true);
      expect(text).toBe('{"type":"final","message":"done"}');
      expect(deltas.join('')).toBe('{"type":"final","message":"done"}');
      expect(provider.getLastUsage()).toEqual({
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      });
    } finally {
      global.fetch = originalFetch;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalDisableCli === undefined)
        delete process.env.PIECODE_DISABLE_CODEX_CLI;
      else process.env.PIECODE_DISABLE_CODEX_CLI = originalDisableCli;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('codex token provider supports native Responses tool calls', async () => {
    const originalFetch = global.fetch;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalDisableCli = process.env.PIECODE_DISABLE_CODEX_CLI;
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'piecode-provider-test-')
    );

    process.env.CODEX_HOME = tmp;
    process.env.PIECODE_DISABLE_CODEX_CLI = '1';
    const codexToken = createCodexTestToken();
    await fs.writeFile(
      path.join(tmp, 'auth.json'),
      JSON.stringify({ tokens: { access_token: codexToken } }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmp, 'config.toml'),
      'model = "gpt-5.3-codex"\n',
      'utf8'
    );

    global.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.instructions).toBe('sys');
      expect(body.input?.[0]).toMatchObject({
        role: 'user',
      });
      expect(body.tools?.[0]).toMatchObject({
        type: 'function',
        name: 'read_file',
      });
      expect(body.parallel_tool_calls).toBe(true);

      const chunks = [
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_read_0","call_id":"call_read_0","name":"read_file","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"src/"}\n\n',
        'data: {"type":"response.function_call_arguments.done","arguments":"{\\"path\\":\\"src/cli.js\\"}"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_read_0","call_id":"call_read_0","name":"read_file","arguments":"{\\"path\\":\\"src/cli.js\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13},"output":[{"type":"function_call","id":"fc_read_0","call_id":"call_read_0","name":"read_file","arguments":"{\\"path\\":\\"src/cli.js\\"}"}]}}\n\n',
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    try {
      const provider = getProvider({ provider: 'codex' });
      const response = await provider.completeStream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'read cli' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read file',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      });

      expect(response?.type).toBe('native');
      expect(response?.format).toBe('openai');
      expect(response?.finishReason).toBe('tool_calls');
      expect(response?.message?.tool_calls?.[0]?.id).toBe('call_read_0');
      expect(response?.message?.tool_calls?.[0]?.function?.name).toBe('read_file');
      expect(response?.message?.tool_calls?.[0]?.function?.arguments).toBe('{"path":"src/cli.js"}');
      expect(provider.getLastUsage()).toEqual({
        input_tokens: 9,
        output_tokens: 4,
        total_tokens: 13,
      });
    } finally {
      global.fetch = originalFetch;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalDisableCli === undefined)
        delete process.env.PIECODE_DISABLE_CODEX_CLI;
      else process.env.PIECODE_DISABLE_CODEX_CLI = originalDisableCli;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

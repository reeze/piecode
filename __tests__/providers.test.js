import { getProvider } from "../src/lib/providers.js";

describe("provider selection", () => {
  test("creates openrouter provider when explicitly selected", () => {
    const provider = getProvider({
      provider: "openrouter",
      apiKey: "or-test-key",
      model: "anthropic/claude-3.5-sonnet",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(provider.kind).toBe("openrouter-compatible");
    expect(provider.model).toBe("anthropic/claude-3.5-sonnet");
  });

  test("uses OPENROUTER_API_KEY fallback when no provider is specified", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "or-test-env-key";
    try {
      const provider = getProvider({ model: "openai/gpt-4.1-mini" });
      expect(provider.kind).toBe("openrouter-compatible");
      expect(provider.model).toBe("openai/gpt-4.1-mini");
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  test("seed provider exposes stream completion", () => {
    const provider = getProvider({
      provider: "seed",
      apiKey: "seed-test-key",
      model: "doubao-seed-code-preview-latest",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    });
    expect(provider.kind).toBe("seed-openai-compatible");
    expect(typeof provider.completeStream).toBe("function");
  });

  test("openrouter native completeStream emits deltas and returns tool call message", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"cli.js\\"}"}}]}}]}\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
        "data: [DONE]\n",
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
        headers: { "content-type": "text/event-stream" },
      });
    };

    try {
      const provider = getProvider({
        provider: "openrouter",
        apiKey: "or-test-key",
        model: "anthropic/claude-sonnet-4.5",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      const deltas = [];
      const response = await provider.completeStream({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "read cli" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        onDelta: (chunk) => deltas.push(String(chunk || "")),
      });

      expect(response?.type).toBe("native");
      expect(response?.format).toBe("openai");
      expect(response?.finishReason).toBe("tool_calls");
      expect(response?.message?.tool_calls?.[0]?.function?.name).toBe("read_file");
      expect(response?.message?.tool_calls?.[0]?.function?.arguments).toBe('{"path":"src/cli.js"}');
      expect(deltas.join("")).toContain('"path":"src/cli.js"');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

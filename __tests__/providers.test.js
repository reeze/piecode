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
});

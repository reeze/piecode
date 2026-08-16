import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildModelCatalog,
  describeProviderSetup,
  describeProviderStatuses,
  discoverProviderModels,
  formatModelRef,
  getCatalogContextWindow,
  getModelReasoningSupport,
  getProviderSpec,
  inferProviderForModel,
  isKnownProvider,
  listProviderIds,
  loadUserModelCatalog,
  normalizeProviderId,
  parseModelRef,
  resolveProviderConfig,
} from "../src/lib/modelCatalog.js";

const CODEX_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-home");

describe("provider registry", () => {
  test("covers the mainstream providers plus local runtimes", () => {
    const ids = listProviderIds();
    for (const expected of [
      "anthropic",
      "openai",
      "codex",
      "codex-local",
      "openrouter",
      "deepseek",
      "moonshot",
      "zhipu",
      "dashscope",
      "minimax",
      "google",
      "xai",
      "ollama",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  test("normalizes vendor aliases to canonical provider ids", () => {
    expect(normalizeProviderId("Kimi")).toBe("moonshot");
    expect(normalizeProviderId("z-ai")).toBe("zhipu");
    expect(normalizeProviderId("qwen")).toBe("dashscope");
    expect(normalizeProviderId("doubao")).toBe("seed");
    expect(normalizeProviderId("gemini")).toBe("google");
    expect(isKnownProvider("grok")).toBe(true);
    expect(isKnownProvider("not-a-provider")).toBe(false);
  });

  test("parses provider-qualified model refs and leaves bare ids alone", () => {
    expect(parseModelRef("deepseek:deepseek-chat")).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(parseModelRef("kimi:kimi-k2-turbo-preview")).toEqual({
      provider: "moonshot",
      model: "kimi-k2-turbo-preview",
    });
    // `vendor/model` is an aggregator id, not a provider prefix.
    expect(parseModelRef("moonshotai/kimi-k2.5")).toEqual({ provider: "", model: "moonshotai/kimi-k2.5" });
    expect(formatModelRef({ provider: "zhipu", model: "glm-4.6" })).toBe("zhipu:glm-4.6");
  });

  test("infers the owning provider for bare model ids", () => {
    expect(inferProviderForModel("claude-sonnet-4-5")).toBe("anthropic");
    expect(inferProviderForModel("deepseek-reasoner")).toBe("deepseek");
    expect(inferProviderForModel("glm-4.6")).toBe("zhipu");
    expect(inferProviderForModel("qwen3-coder-plus")).toBe("dashscope");
    expect(inferProviderForModel("gemini-2.5-pro")).toBe("google");
    expect(inferProviderForModel("gpt-5.3-codex")).toBe("codex");
    expect(inferProviderForModel("vendor/some-model")).toBe("openrouter");
    expect(inferProviderForModel("totally-unknown-model")).toBe("");
  });
});

describe("provider configuration", () => {
  test("prefers settings over environment and reports the source", () => {
    const fromEnv = resolveProviderConfig("deepseek", { settings: {}, env: { DEEPSEEK_API_KEY: "env-key" } });
    expect(fromEnv.configured).toBe(true);
    expect(fromEnv.apiKey).toBe("env-key");
    expect(fromEnv.source).toBe("env:DEEPSEEK_API_KEY");

    const fromSettings = resolveProviderConfig("deepseek", {
      settings: { providers: { deepseek: { apiKey: "settings-key", model: "deepseek-reasoner" } } },
      env: { DEEPSEEK_API_KEY: "env-key" },
    });
    expect(fromSettings.apiKey).toBe("settings-key");
    expect(fromSettings.model).toBe("deepseek-reasoner");
    expect(fromSettings.source).toBe("settings");
  });

  test("falls back to the provider default endpoint and model", () => {
    const config = resolveProviderConfig("moonshot", { settings: {}, env: { MOONSHOT_API_KEY: "k" } });
    expect(config.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(config.model).toBe(getProviderSpec("moonshot").defaultModel);
  });

  test("local providers require an explicit opt-in before counting as ready", () => {
    expect(resolveProviderConfig("ollama", { settings: {}, env: {} }).configured).toBe(false);
    expect(resolveProviderConfig("ollama", { settings: {}, env: { OLLAMA_BASE_URL: "http://x:1/v1" } }).configured).toBe(
      true
    );
    expect(
      resolveProviderConfig("ollama", { settings: { providers: { ollama: { model: "qwen3" } } }, env: {} }).configured
    ).toBe(true);
  });

  test("codex readiness follows stored login state", () => {
    expect(resolveProviderConfig("codex", { settings: {}, env: { CODEX_HOME } }).configured).toBe(true);
    expect(resolveProviderConfig("codex", { settings: {}, env: { CODEX_HOME: "/nope", PATH: "" } }).configured).toBe(
      false
    );
  });

  test("setup hints name the exact next action", () => {
    expect(describeProviderSetup("deepseek")).toBe("set DEEPSEEK_API_KEY");
    expect(describeProviderSetup("codex")).toBe("run `codex login`");
    expect(describeProviderSetup("ollama")).toContain("OLLAMA_BASE_URL");
  });

  test("status rows mark configured providers and carry a hint for the rest", () => {
    const rows = describeProviderStatuses({ settings: {}, env: { XAI_API_KEY: "k", PATH: "" } });
    const xai = rows.find((row) => row.id === "xai");
    const groq = rows.find((row) => row.id === "groq");
    expect(xai.configured).toBe(true);
    expect(xai.setupHint).toBe("");
    expect(groq.configured).toBe(false);
    expect(groq.setupHint).toBe("set GROQ_API_KEY");
  });
});

describe("model catalog", () => {
  test("only lists models whose provider is usable", () => {
    const withoutKeys = buildModelCatalog({ settings: {}, env: { PATH: "" } });
    expect(withoutKeys).toHaveLength(0);

    const withDeepseek = buildModelCatalog({ settings: {}, env: { DEEPSEEK_API_KEY: "k", PATH: "" } });
    expect(withDeepseek.length).toBeGreaterThan(0);
    expect(withDeepseek.every((row) => row.provider === "deepseek")).toBe(true);
    expect(withDeepseek.map((row) => row.ref)).toContain("deepseek:deepseek-chat");
  });

  test("merges discovered models and keeps curated metadata", () => {
    const rows = buildModelCatalog({
      settings: {},
      env: { DEEPSEEK_API_KEY: "k", PATH: "" },
      discovered: [
        { id: "deepseek-chat", provider: "deepseek", context: 64000 },
        { id: "deepseek-brand-new", provider: "deepseek" },
      ],
    });
    const refs = rows.map((row) => row.ref);
    expect(refs).toContain("deepseek:deepseek-brand-new");
    // Discovered context wins because it comes from the live API.
    expect(rows.find((row) => row.ref === "deepseek:deepseek-chat").context).toBe(64000);
  });

  test("reports known context windows for curated models", () => {
    expect(getCatalogContextWindow("anthropic:claude-sonnet-4-5")).toBe(200000);
    expect(getCatalogContextWindow("glm-4.6")).toBe(200000);
    expect(getCatalogContextWindow("unknown-model-xyz")).toBe(0);
  });

  test("ignores a missing or malformed user catalog file", () => {
    const loaded = loadUserModelCatalog({ filePath: "/nonexistent/models.json", force: true });
    expect(loaded.models).toEqual([]);
  });
});

describe("reasoning effort support", () => {
  test("providers that reject unknown fields report no effort support", () => {
    expect(getModelReasoningSupport({ provider: "deepseek", model: "deepseek-chat" }).supported).toBe(false);
    expect(getModelReasoningSupport({ provider: "moonshot", model: "kimi-k2" }).supported).toBe(false);
    expect(getModelReasoningSupport({ provider: "anthropic", model: "claude-sonnet-4-5" }).supported).toBe(false);
  });

  test("codex and openai reasoning models expose the extended effort scale", () => {
    expect(getModelReasoningSupport({ provider: "codex", model: "gpt-5.3-codex" }).values).toContain("xhigh");
    expect(getModelReasoningSupport({ provider: "openai", model: "gpt-5.1" }).values).toContain("minimal");
    expect(getModelReasoningSupport({ provider: "openai", model: "gpt-4.1" }).values).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  test("explicit overrides win over provider defaults", () => {
    const support = getModelReasoningSupport({ provider: "deepseek", overrides: ["low", "high"] });
    expect(support).toEqual({ supported: true, values: ["low", "high"], source: "settings" });
  });
});

describe("live model discovery", () => {
  test("maps an OpenAI-style /models payload into catalog entries", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, headers: options.headers });
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "deepseek-chat", context_length: 128000 },
            { id: "deepseek-reasoner" },
          ],
        }),
      };
    };
    const result = await discoverProviderModels("deepseek", {
      settings: {},
      env: { DEEPSEEK_API_KEY: "k" },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/models");
    expect(calls[0].headers.Authorization).toBe("Bearer k");
    expect(result.models.map((row) => row.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(result.models[0].context).toBe(128000);
  });

  test("uses the anthropic auth header for anthropic discovery", async () => {
    let seen = null;
    const fetchImpl = async (_url, options) => {
      seen = options.headers;
      return { ok: true, json: async () => ({ data: [{ id: "claude-sonnet-4-5" }] }) };
    };
    await discoverProviderModels("anthropic", {
      settings: {},
      env: { ANTHROPIC_API_KEY: "sk" },
      fetchImpl,
    });
    expect(seen["x-api-key"]).toBe("sk");
    expect(seen["anthropic-version"]).toBe("2023-06-01");
  });

  test("never throws when a provider is unreachable or unconfigured", async () => {
    const failing = await discoverProviderModels("deepseek", {
      settings: {},
      env: { DEEPSEEK_API_KEY: "k" },
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(failing.ok).toBe(false);
    expect(failing.models).toEqual([]);

    const unconfigured = await discoverProviderModels("groq", { settings: {}, env: {} });
    expect(unconfigured).toEqual({ models: [], ok: false, reason: "not-configured" });
  });
});

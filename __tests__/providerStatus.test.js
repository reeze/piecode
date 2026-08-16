import {
  buildDoctorReport,
  formatOnboardingLines,
  describeModelRef,
  formatContextTokens,
  formatModelCatalogLines,
  formatProviderTable,
} from "../src/lib/providerStatus.js";

const NO_PROVIDERS = { PATH: "" };

describe("provider table", () => {
  test("marks ready providers, the active one, and setup hints for the rest", () => {
    const lines = formatProviderTable({
      settings: {},
      env: { ...NO_PROVIDERS, DEEPSEEK_API_KEY: "k" },
      activeProviderId: "deepseek",
    });
    const text = lines.join("\n");

    expect(text).toMatch(/> ✓ deepseek/);
    expect(text).toMatch(/· openai\s+OpenAI\s+set OPENAI_API_KEY/);
    expect(text).toContain("providers ready");
  });

  test("can hide providers that are not configured", () => {
    const lines = formatProviderTable({
      settings: {},
      env: { ...NO_PROVIDERS, GROQ_API_KEY: "k" },
      includeUnconfigured: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("groq");
    expect(text).not.toContain("mistral");
  });

  test("aggregator and local providers are labelled", () => {
    const text = formatProviderTable({ settings: {}, env: NO_PROVIDERS }).join("\n");
    expect(text).toMatch(/openrouter.*\[aggregator\]/);
    expect(text).toMatch(/ollama.*\[local\]/);
  });
});

describe("model catalog listing", () => {
  test("groups models under their provider with context and tags", () => {
    const lines = formatModelCatalogLines({
      settings: {},
      env: { ...NO_PROVIDERS, DEEPSEEK_API_KEY: "k" },
      refs: ["deepseek:deepseek-chat", "deepseek:deepseek-reasoner"],
      activeRef: "deepseek:deepseek-chat",
    });
    const text = lines.join("\n");

    expect(text).toContain("DeepSeek (deepseek)");
    expect(text).toContain("> deepseek:deepseek-chat");
    expect(text).toContain("128k ctx");
    expect(text).toContain("reasoning");
  });

  test("explains itself when nothing is available", () => {
    const lines = formatModelCatalogLines({ settings: {}, env: NO_PROVIDERS, refs: ["deepseek:deepseek-chat"] });
    expect(lines.join("\n")).toContain("/provider");
  });

  test("annotates a single model reference", () => {
    expect(describeModelRef("anthropic:claude-sonnet-4-5")).toContain("200k ctx");
    expect(describeModelRef("nope:nothing")).toBe("");
  });

  test("formats context sizes compactly", () => {
    expect(formatContextTokens(128000)).toBe("128k");
    expect(formatContextTokens(1048576)).toBe("1M");
    expect(formatContextTokens(0)).toBe("");
  });
});

describe("doctor report", () => {
  test("flags a completely unconfigured environment with next steps", () => {
    const report = buildDoctorReport({ settings: {}, env: NO_PROVIDERS, activeProvider: null });

    expect(report.ready).toEqual([]);
    expect(report.problems.join(" ")).toContain("No provider is configured");
    expect(report.problems.join(" ")).toContain("No active model");
    expect(report.lines.join("\n")).toContain("piecode doctor");
  });

  test("reports a healthy environment with no problems", () => {
    const report = buildDoctorReport({
      settings: {},
      env: { ...NO_PROVIDERS, DEEPSEEK_API_KEY: "k" },
      activeProvider: { providerId: "deepseek", model: "deepseek-chat", kind: "deepseek-openai-compatible" },
      workspaceDir: "/tmp/x",
    });

    expect(report.ready).toEqual(["deepseek"]);
    expect(report.problems).toEqual([]);
    expect(report.lines.join("\n")).toContain("deepseek:deepseek-chat");
    expect(report.lines.join("\n")).toContain("no problems found");
  });

  test("warns when the active transport lacks native tool calling", () => {
    const report = buildDoctorReport({
      settings: {},
      env: { ...NO_PROVIDERS, DEEPSEEK_API_KEY: "k" },
      activeProvider: { providerId: "codex", model: "gpt-5.3-codex", kind: "codex-cli-session", supportsNativeTools: false },
    });
    expect(report.lines.join("\n")).toContain("no native tool calling");
  });

  test("surfaces extra checks and their fixes", () => {
    const report = buildDoctorReport({
      settings: {},
      env: { ...NO_PROVIDERS, DEEPSEEK_API_KEY: "k" },
      activeProvider: { providerId: "deepseek", model: "deepseek-chat" },
      extraChecks: [{ label: "mcp servers", ok: false, detail: "spawn failed", fix: "Check mcpServers in settings.json" }],
    });
    expect(report.lines.join("\n")).toContain("mcp servers — spawn failed");
    expect(report.problems).toContain("Check mcpServers in settings.json");
  });
});

describe("first-run onboarding", () => {
  test("offers concrete key exports and login alternatives when nothing is set", () => {
    const text = formatOnboardingLines({ settings: {}, env: NO_PROVIDERS, settingsFile: "/home/u/.piecode/settings.json" }).join("\n");

    expect(text).toContain("no model provider configured");
    expect(text).toContain('export ANTHROPIC_API_KEY="..."');
    expect(text).toContain('export DEEPSEEK_API_KEY="..."');
    expect(text).toContain("codex login");
    expect(text).toContain("OLLAMA_BASE_URL");
    expect(text).toContain("/home/u/.piecode/settings.json");
    expect(text).toContain("piecode --doctor");
  });

  test("points at the ready provider when one exists", () => {
    const text = formatOnboardingLines({ settings: {}, env: { ...NO_PROVIDERS, GROQ_API_KEY: "k" } }).join("\n");

    expect(text).toContain("Ready providers:");
    expect(text).toContain("groq");
    expect(text).toContain("piecode --provider <id>");
    expect(text).not.toContain('export ANTHROPIC_API_KEY="..."');
  });
});

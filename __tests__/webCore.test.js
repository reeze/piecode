import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipDiffText, getSessionDiff, parseToolResultDetails } from "../src/web/core.js";
import {
  ClarificationBroker,
  createWebAuthToken,
  isAuthorizedWebRequest,
  normalizeWebAttachments,
  resolveWebBindOptions,
  summarizeToolIntent,
  validateWebOrigin,
  WebAgentSession,
} from "../src/web/server.js";

describe("web server security helpers", () => {
  test("binds to loopback by default", () => {
    expect(resolveWebBindOptions({}).host).toBe("127.0.0.1");
    expect(resolveWebBindOptions({ PIECODE_WEB_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  test("does not require a token by default", () => {
    expect(createWebAuthToken({})).toBe("");
    expect(isAuthorizedWebRequest({ headers: {} }, new URL("http://localhost/api/state"), "")).toBe(true);
  });

  test("requires token for api requests when configured", () => {
    const req = { headers: {} };
    const url = new URL("http://localhost/api/state");
    expect(createWebAuthToken({ PIECODE_WEB_TOKEN: "secret" })).toBe("secret");
    expect(isAuthorizedWebRequest(req, url, "secret")).toBe(false);
    url.searchParams.set("token", "secret");
    expect(isAuthorizedWebRequest(req, url, "secret")).toBe(true);
    expect(isAuthorizedWebRequest({ headers: { "x-piecode-token": "secret" } }, new URL("http://localhost/api/state"), "secret")).toBe(true);
  });

  test("rejects foreign origins", () => {
    expect(validateWebOrigin({ headers: {} }, "127.0.0.1", 3737).ok).toBe(true);
    expect(validateWebOrigin({ headers: { origin: "http://localhost:3737" } }, "127.0.0.1", 3737).ok).toBe(true);
    expect(validateWebOrigin({ headers: { origin: "https://evil.example" } }, "127.0.0.1", 3737).ok).toBe(false);
  });

  test("normalizes valid web image attachments", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const result = normalizeWebAttachments([{ type: "image", name: "shot.png", mimeType: "image/png", data: png.toString("base64") }]);
    expect(result).toEqual([
      expect.objectContaining({ type: "image", source: "web", name: "shot.png", mimeType: "image/png", bytes: png.length }),
    ]);
  });

  test("rejects web image attachment mime mismatches", () => {
    const gif = Buffer.from("GIF89a", "ascii");
    expect(() => normalizeWebAttachments([{ type: "image", mimeType: "image/png", data: gif.toString("base64") }])).toThrow(/does not match/);
  });

  test("summarizes tool intent when native tool calls have no user-visible thought", () => {
    expect(summarizeToolIntent("shell", { command: "pwd" })).toBe("Running a shell command.");
    expect(summarizeToolIntent("read_file", { path: "src/web/server.js" })).toBe("Reading src/web/server.js.");
    expect(summarizeToolIntent("rg", { pattern: "model_call" })).toBe("Searching for model_call.");
    expect(summarizeToolIntent("custom_tool", {})).toBe("Using custom_tool.");
  });

  test("clarification broker resolves selected options with stable payloads", async () => {
    const events = [];
    const broker = new ClarificationBroker({ publish: (type, payload) => events.push({ type, payload }) });
    const promise = broker.request({
      question: "Choose mode",
      options: [{ label: "Fast", value: "fast" }, { label: "Safe", value: "safe" }],
      multiple: false,
      required: true,
    });

    expect(broker.list()).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "clarification.request", payload: { question: "Choose mode", multiple: false } });
    expect(broker.resolve(events[0].payload.id, [1])).toBe(true);
    await expect(promise).resolves.toEqual({ selected: [{ label: "Safe", value: "safe" }] });
    expect(events[1]).toMatchObject({ type: "clarification.resolved", payload: { id: events[0].payload.id, selectedIndexes: [1] } });
  });

  test("web /goal without a task returns usage", async () => {
    const session = new WebAgentSession({ workspaceDir: process.cwd(), settings: {}, settingsFile: "" });

    const result = await session.handleSlashCommand("/goal");

    expect(result.handled).toBe(true);
    expect(result.message).toContain("Usage: `/goal <task>`");
  });

  test("web /goal runs a multi-turn loop outside plan-only mode", async () => {
    const session = new WebAgentSession({
      workspaceDir: process.cwd(),
      settings: {},
      settingsFile: "",
      providerFactory: () => ({ kind: "test", model: "test-model", supportsNativeTools: true }),
    });
    session.skillIndex = new Map();
    session.pluginIndex = new Map();
    session.planOnly = true;
    const calls = [];
    session.agent = {
      async runTurn(input, options) {
        calls.push({ input, options });
        if (calls.length === 1) return "first pass\nGOAL_STATUS: continue";
        return "done\nGOAL_STATUS: complete";
      },
    };

    const message = await session.sendMessage("/goal make web goals work", { planOnly: true });

    expect(message.content).toContain("GOAL_STATUS: complete");
    expect(calls).toHaveLength(2);
    expect(calls[0].input).toContain("make web goals work");
    expect(calls[0].options.planOnly).toBe(false);
    expect(calls[1].input).toContain("Goal supervisor loop iteration 2");
    expect(calls[1].options.planOnly).toBe(false);
    expect(session.planOnly).toBe(true);
  });

  test("web normal messages honor session plan mode when request options omit planOnly", async () => {
    const session = new WebAgentSession({
      workspaceDir: process.cwd(),
      settings: {},
      settingsFile: "",
      providerFactory: () => ({ kind: "test", model: "test-model", supportsNativeTools: true }),
    });
    session.skillIndex = new Map();
    session.pluginIndex = new Map();
    session.planOnly = true;
    const calls = [];
    session.agent = {
      history: [],
      async runTurn(input, options) {
        calls.push({ input, options });
        return "planned response";
      },
    };

    await session.sendMessage("inspect the repo for bugs");

    expect(calls).toHaveLength(1);
    expect(calls[0].options.planOnly).toBe(true);
  });

  test("web refreshes provider before each model turn so Codex auth changes are picked up", async () => {
    const providers = [
      { kind: "codex-auth-token", model: "gpt-5.3-codex", supportsNativeTools: true },
      { kind: "codex-auth-key", model: "gpt-5.3-codex", supportsNativeTools: true },
    ];
    const providerCalls = [];
    const providerFactory = (options) => {
      providerCalls.push(options);
      return providers[Math.min(providerCalls.length - 1, providers.length - 1)];
    };
    const session = new WebAgentSession({ workspaceDir: process.cwd(), settings: { provider: "codex" }, settingsFile: "", providerFactory });
    session.skillIndex = new Map();
    session.pluginIndex = new Map();
    session.provider = providers[0];
    const seenProviders = [];
    session.agent = {
      history: [],
      provider: providers[0],
      async runTurn() {
        seenProviders.push(this.provider);
        return "ok";
      },
    };

    await session.sendMessage("first turn");
    await session.sendMessage("second turn");

    expect(providerCalls).toHaveLength(2);
    expect(seenProviders).toEqual(providers);
    expect(session.provider).toBe(providers[1]);
    expect(session.snapshot().provider).toBe("codex-auth-key");
  });

  test("web plugin slash commands are discovered, suggested, and executable", async () => {
    const session = new WebAgentSession({ workspaceDir: process.cwd(), settings: {}, settingsFile: "" });
    session.skillIndex = new Map();
    session.pluginIndex = new Map([
      ["demo", {
        name: "demo",
        description: "Demo plugin",
        version: "1.0.0",
        path: "/tmp/demo/PLUGIN.md",
        frontmatter: { command: "demo", commandDescription: "Run demo" },
        commandFiles: [],
        skills: [],
      }],
    ]);

    const command = session.getSlashCommands().find((item) => item.name === "/demo");
    expect(command).toMatchObject({ pluginName: "demo", description: "Run demo" });

    const result = await session.handleSlashCommand("/demo hello");

    expect(result.handled).toBe(false);
    expect(result.input).toContain("Plugin command /demo invoked.");
    expect(result.input).toContain("User request / arguments:\nhello");
    expect(session.activePluginsRef.value.map((plugin) => plugin.name)).toEqual(["demo"]);
  });

  test("web /help keeps dynamic skill and plugin command lists out of the main help output", async () => {
    const session = new WebAgentSession({ workspaceDir: process.cwd(), settings: {}, settingsFile: "" });
    session.skillIndex = new Map([
      ["demo-skill", {
        name: "demo-skill",
        description: "Demo skill",
        path: "/tmp/demo-skill/SKILL.md",
        frontmatter: { command: "demo-skill", commandDescription: "Run demo skill" },
        commandFiles: [],
      }],
    ]);
    session.pluginIndex = new Map([
      ["demo-plugin", {
        name: "demo-plugin",
        description: "Demo plugin",
        version: "1.0.0",
        path: "/tmp/demo-plugin/PLUGIN.md",
        frontmatter: { command: "demo-plugin", commandDescription: "Run demo plugin" },
        commandFiles: [],
        skills: [],
      }],
    ]);

    const result = await session.handleSlashCommand("/help");

    expect(result.handled).toBe(true);
    expect(result.message).toContain("## Web Slash Commands");
    expect(result.message).toContain("Use `/plugins commands` or `/skills commands`");
    expect(result.message).not.toContain("Run demo skill");
    expect(result.message).not.toContain("Run demo plugin");
  });

  test("web plugin management commands mirror CLI basics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-web-plugin-"));
    const pluginDir = path.join(tempDir, "demo");
    await fs.mkdir(pluginDir, { recursive: true });
    const pluginPath = path.join(pluginDir, "PLUGIN.md");
    await fs.writeFile(pluginPath, "---\nname: demo\nversion: 1.0.0\n---\nDemo plugin\n", "utf8");
    const session = new WebAgentSession({ workspaceDir: process.cwd(), settings: {}, settingsFile: "" });
    session.skillIndex = new Map();
    session.pluginIndex = new Map([
      ["demo", {
        name: "demo",
        description: "Demo plugin",
        version: "1.0.0",
        path: pluginPath,
        frontmatter: {},
        commandFiles: [],
        skills: [],
      }],
    ]);

    await expect(session.handleSlashCommand("/plugins list")).resolves.toMatchObject({ handled: true, message: expect.stringContaining("Demo plugin") });
    await expect(session.handleSlashCommand("/plugins commands")).resolves.toMatchObject({ handled: true, message: expect.stringContaining("No plugin commands") });
    await expect(session.handleSlashCommand("/plugins use demo")).resolves.toMatchObject({ handled: true, message: "Enabled plugin: demo" });
    expect(session.snapshot().plugins).toEqual([expect.objectContaining({ name: "demo" })]);
    await expect(session.handleSlashCommand("/plugins off demo")).resolves.toMatchObject({ handled: true, message: "Disabled plugin: demo" });
  });

  test("web /clear resets pending steers so stale guidance does not leak into later tasks", async () => {
    const session = new WebAgentSession({ workspaceDir: process.cwd(), settings: {}, settingsFile: "" });
    session.skillIndex = new Map();
    session.pendingSteers = [{ id: "steer-1", content: "old steer", at: new Date().toISOString() }];
    session.messages = [{ id: "m1", role: "user", content: "old", at: new Date().toISOString() }];
    session.timeline = [{ id: "t1", type: "message", content: "old", at: new Date().toISOString() }];
    session.todos = [{ id: "todo-1", content: "do thing", status: "pending" }];
    session.agent = { clearHistory() {} };

    const result = await session.handleSlashCommand("/clear");

    expect(result.handled).toBe(true);
    expect(session.pendingSteers).toEqual([]);
    expect(session.messages).toEqual([]);
    expect(session.timeline).toEqual([]);
    expect(session.todos).toEqual([]);
  });
});

describe("web model switching", () => {
  const makeSession = (settings = {}) => {
    const calls = [];
    const providerFactory = (options) => {
      calls.push(options);
      return {
        kind: `${options.provider || "unknown"}-openai-compatible`,
        providerId: options.provider || "",
        model: options.model || "",
        supportsNativeTools: true,
      };
    };
    const session = new WebAgentSession({
      workspaceDir: process.cwd(),
      settings,
      settingsFile: "",
      providerFactory,
    });
    return { session, calls };
  };

  test("switching to a provider-qualified model rebuilds the provider and persists the choice", async () => {
    const { session, calls } = makeSession({ providers: { deepseek: { apiKey: "k" } } });
    const provider = await session.setModel("deepseek:deepseek-reasoner");

    expect(provider.model).toBe("deepseek-reasoner");
    expect(provider.providerId).toBe("deepseek");
    expect(session.settings.model).toBe("deepseek-reasoner");
    expect(session.settings.provider).toBe("deepseek");
    expect(session.settings.providers.deepseek.model).toBe("deepseek-reasoner");
    expect(calls[calls.length - 1].provider).toBe("deepseek");
  });

  test("a bare model id resolves to its owning provider", async () => {
    const { session } = makeSession({ providers: { moonshot: { apiKey: "k" } } });
    const provider = await session.setModel("kimi-k2-turbo-preview");
    expect(provider.providerId).toBe("moonshot");
  });

  test("switching to an unconfigured provider fails with the setup step", async () => {
    const { session } = makeSession({});
    await expect(session.setModel("xai:grok-4")).rejects.toThrow(/set XAI_API_KEY/);
  });

  test("an empty model id is rejected", async () => {
    const { session } = makeSession({});
    await expect(session.setModel("   ")).rejects.toThrow(/Model id is required/);
  });

  test("listModels reports readiness, setup hints, and the active model", async () => {
    const { session } = makeSession({ providers: { deepseek: { apiKey: "k" } } });
    await session.setModel("deepseek:deepseek-chat");
    const result = await session.listModels();

    expect(result.active).toBe("deepseek:deepseek-chat");
    expect(result.models.some((row) => row.ref === "deepseek:deepseek-chat" && row.active)).toBe(true);
    expect(result.models.every((row) => row.provider === "deepseek")).toBe(true);
    expect(result.models[0].contextLabel).toBe("128k");

    const openai = result.providers.find((row) => row.id === "openai");
    expect(openai.configured).toBe(false);
    expect(openai.setupHint).toBe("set OPENAI_API_KEY");
  });
});

describe("web core helpers", () => {
  test("summarizes edit_file results with expandable diffs", () => {
    const result = parseToolResultDetails("edit_file", JSON.stringify({
      path: "src/app.js",
      changed: true,
      message: "Updated app",
      details: {
        diffStat: "1 file changed",
        diff: "diff --git a/src/app.js b/src/app.js\n+const ok = true;",
      },
    }));

    expect(result).toMatchObject({
      kind: "file_edit",
      path: "src/app.js",
      changed: true,
      message: "Updated app",
      diffStat: "1 file changed",
      expandable: true,
      preview: "Updated app",
    });
    expect(result.diff).toContain("+const ok = true;");
  });

  test("summarizes replace_in_files results without leaking huge payloads by default", () => {
    const result = parseToolResultDetails("replace_in_files", JSON.stringify({
      mode: "literal",
      matched_files: 1,
      replacements: 2,
      files: [{ path: "README.md", replacements: 2 }],
    }));

    expect(result).toMatchObject({
      kind: "bulk_replace",
      mode: "literal",
      matchedFiles: 1,
      replacements: 2,
      expandable: true,
      preview: "literal: 1 file(s), 2 replacement(s)",
    });
    expect(result.files).toEqual([{ path: "README.md", replacements: 2 }]);
  });

  test("clips large diffs and reports omitted characters", () => {
    const result = clipDiffText("a".repeat(10050), 20);

    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBe(50);
    expect(result.text).toContain("[diff truncated: 50 chars omitted]");
  });

  test("builds a session diff from staged, unstaged, and untracked git output", async () => {
    const calls = [];
    const execFile = async (_bin, args) => {
      calls.push(args.join(" "));
      const command = args.join(" ");
      if (command.startsWith("rev-parse")) return { stdout: "true\n" };
      if (command.startsWith("diff --cached")) return { stdout: "diff --git a/a.js b/a.js\n+staged\n" };
      if (command.startsWith("diff --no-ext-diff")) return { stdout: "diff --git a/b.js b/b.js\n+unstaged\n" };
      if (command.startsWith("ls-files")) return { stdout: "new.txt\n" };
      return { stdout: "" };
    };

    const result = await getSessionDiff("/workspace", { execFile });

    expect(result.ok).toBe(true);
    expect(result.diff).toContain("# Staged changes");
    expect(result.diff).toContain("+staged");
    expect(result.diff).toContain("# Unstaged changes");
    expect(result.diff).toContain("+unstaged");
    expect(result.diff).toContain("?? new.txt");
    expect(result.untrackedFiles).toEqual(["new.txt"]);
    expect(calls).toContain("rev-parse --is-inside-work-tree");
  });
});

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyShellCommand, createToolset } from "../src/lib/tools.js";

describe("tools usability", () => {
  test("exposes todo_write and todowrite aliases", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    expect(typeof tools.todo_write).toBe("function");
    expect(typeof tools.todowrite).toBe("function");
  });

  test("todo_write normalizes items and notifies callback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const writes = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      onTodoWrite: (todos) => writes.push(todos),
    });

    const result = await tools.todo_write({
      todos: [
        { content: "first", status: "pending" },
        { content: "second", status: "IN_PROGRESS" },
        { content: "done", status: "completed" },
        { content: "unknown", status: "wat" },
        { content: "   " },
      ],
    });

    expect(result).toContain("Updated 4 todos");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([
      { id: "todo-1", content: "first", status: "pending" },
      { id: "todo-2", content: "second", status: "in_progress" },
      { id: "todo-3", content: "done", status: "completed" },
      { id: "todo-4", content: "unknown", status: "pending" },
    ]);
  });

  test("todo_write skips duplicate payloads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const writes = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      onTodoWrite: (todos) => writes.push(todos),
    });

    const payload = {
      todos: [{ id: "x", content: "same", status: "pending" }],
    };
    const first = await tools.todo_write(payload);
    const second = await tools.todo_write(payload);

    expect(first).toContain("Updated 1 todos");
    expect(second).toContain("No-op");
    expect(writes).toHaveLength(1);
  });

  test("todo_write returns helpful error when payload is invalid", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.todo_write({ todos: "invalid" });
    expect(result).toContain("No valid todos were provided");
  });

  test("todowrite alias updates todos and triggers callback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const writes = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      onTodoWrite: (todos) => writes.push(todos),
    });

    const result = await tools.todowrite({
      todos: [{ content: "ship release", status: "completed" }],
    });

    expect(result).toContain("Updated 1 todos");
    expect(writes).toEqual([[{ id: "todo-1", content: "ship release", status: "completed" }]]);
  });

  test("exposes newly added editing and git/test helper tools", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    expect(typeof tools.clarify_user).toBe("function");
    expect(typeof tools.read_files).toBe("function");
    expect(typeof tools.glob_files).toBe("function");
    expect(typeof tools.find_files).toBe("function");
    expect(typeof tools.rg).toBe("function");
    expect(typeof tools.grep).toBe("function");
    expect(typeof tools.search_files).toBe("function");
    expect(typeof tools.web_search).toBe("function");
    expect(typeof tools.search_web).toBe("function");
    expect(typeof tools.subagent).toBe("function");
    expect(typeof tools.edit_file).toBe("function");
    expect(typeof tools.apply_patch).toBe("function");
    expect(typeof tools.replace_in_files).toBe("function");
    expect(typeof tools.git_status).toBe("function");
    expect(typeof tools.git_diff).toBe("function");
    expect(typeof tools.run_tests).toBe("function");
  });

  test("subagent delegates to configured runner with normalized input", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const starts = [];
    const calls = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      onToolStart: (tool, input) => starts.push({ tool, input }),
      runSubagent: async (input) => {
        calls.push(input);
        return "subagent findings";
      },
    });

    const result = await tools.subagent({
      task: " inspect providers ",
      context: "focus on auth",
      mode: "readonly",
      tool_budget: 99,
      role: "security-reviewer",
    });

    expect(result).toBe("subagent findings");
    expect(starts[0]).toMatchObject({ tool: "subagent" });
    expect(starts[0].input.tool_budget).toBe(6);
    expect(starts[0].input.role).toBe("security-reviewer");
    expect(calls).toEqual([
      {
        task: "inspect providers",
        context: "focus on auth",
        mode: "readonly",
        toolBudget: 6,
        role: "security-reviewer",
      },
    ]);
  });

  test("clarify_user delegates to harness and returns selected options", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const calls = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      askClarification: async (input) => {
        calls.push(input);
        return { selected: [input.options[1]] };
      },
    });

    const raw = await tools.clarify_user({
      question: "Pick mode",
      multiple: true,
      options: ["Fast", { label: "Safe", value: "safe", description: "More checks" }],
    });

    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe("clarification_response");
    expect(parsed.multiple).toBe(true);
    expect(parsed.selected).toEqual([{ id: "option-2", label: "Safe", value: "safe", description: "More checks" }]);
    expect(calls[0].options).toHaveLength(2);
    expect(calls[0].options[0].label).toBe("Fast");
  });

  test("clarify_user fails closed when no harness is available", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.clarify_user({
      question: "Proceed with risky change?",
      options: ["Yes", "No"],
    });

    expect(result).toContain("Clarification is unavailable");
    expect(result).toContain("No clarification option was selected");
    expect(result).not.toContain("Please reply with your selected option");
  });

  test("clarify_user validates input and handles cancelled selections", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      askClarification: async () => ({ selected: [] }),
    });

    await expect(tools.clarify_user({ question: "", options: ["A"] })).resolves.toContain(
      "clarification question is required"
    );
    await expect(tools.clarify_user({ question: "Pick", options: [] })).resolves.toContain(
      "at least one clarification option is required"
    );
    await expect(tools.clarify_user({ question: "Pick", options: ["A"] })).resolves.toBe(
      "No clarification option was selected."
    );
  });

  test("read_files reads multiple files with structured output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "a.txt"), "aaa", "utf8");
    await fs.writeFile(path.join(dir, "b.txt"), "bbb", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.read_files({ paths: ["a.txt", "b.txt"] });
    const parsed = JSON.parse(result);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].path).toBe("a.txt");
    expect(parsed.files[0].content).toContain("aaa");
    expect(parsed.files[1].path).toBe("b.txt");
    expect(parsed.files[1].content).toContain("bbb");
  });

  test("glob_files matches by glob and ignores .git by default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "x.js"), "x", "utf8");
    await fs.writeFile(path.join(dir, ".git", "hidden.js"), "x", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.glob_files({ pattern: "**/*.js" });
    expect(result).toContain("src/x.js");
    expect(result).not.toContain(".git/hidden.js");
  });

  test("list_files skips hidden and ignored directories by default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "x.js"), "x", "utf8");
    await fs.writeFile(path.join(dir, ".env"), "SECRET=1", "utf8");
    await fs.writeFile(path.join(dir, ".git", "config"), "[core]", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.list_files({ path: "." });
    expect(result).toContain("src/");
    expect(result).toContain("src/x.js");
    expect(result).not.toContain(".git/");
    expect(result).not.toContain(".env");
  });

  test("list_files can include hidden and ignored directories when requested", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, ".git", "config"), "[core]", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.list_files({
      path: ".",
      include_hidden: true,
      include_ignored: true,
    });
    expect(result).toContain(".git/");
    expect(result).toContain(".git/config");
  });

  test("find_files does fuzzy path matching", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "AGENTS.md"), "agents", "utf8");
    await fs.writeFile(path.join(dir, "docs", "README.md"), "readme", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.find_files({ query: "agent" });
    expect(result).toContain("docs/AGENTS.md");
    expect(result).not.toContain("docs/README.md");
  });

  test("apply_patch supports dry-run and apply", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "target.txt"), "hello world", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const dryRun = await tools.apply_patch({
      path: "target.txt",
      find: "world",
      replace: "pie",
      dry_run: true,
    });
    expect(dryRun).toContain("Patch can be applied");

    const applied = await tools.apply_patch({
      path: "target.txt",
      find: "world",
      replace: "pie",
    });
    expect(applied).toContain("Patched target.txt");
    const next = await fs.readFile(path.join(dir, "target.txt"), "utf8");
    expect(next).toBe("hello pie");
  });

  test("edit_file applies a unique replacement and returns diff details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "target.txt"), "alpha\nbeta world\ngamma\n", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const raw = await tools.edit_file({
      path: "target.txt",
      oldText: "beta world",
      newText: "beta pie",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.path).toBe("target.txt");
    expect(parsed.changed).toBe(true);
    expect(parsed.replacements).toBe(1);
    expect(parsed.details.diff).toContain("--- a/target.txt");
    expect(parsed.details.diff).toContain("-beta world");
    expect(parsed.details.diff).toContain("+beta pie");
    expect(parsed.details.diffStat).toBe("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(parsed.details.diffTruncated).toBe(false);

    const next = await fs.readFile(path.join(dir, "target.txt"), "utf8");
    expect(next).toContain("beta pie");
  });

  test("edit_file truncates oversized diff output for display and reports diff stat", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const oldBlock = Array.from({ length: 220 }, (_, i) => `old-line-${i}`).join("\n");
    const newBlock = Array.from({ length: 220 }, (_, i) => `new-line-${i}`).join("\n");
    await fs.writeFile(path.join(dir, "target.txt"), `header\n${oldBlock}\nfooter\n`, "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const raw = await tools.edit_file({
      path: "target.txt",
      oldText: oldBlock,
      newText: newBlock,
    });
    const parsed = JSON.parse(raw);

    expect(parsed.changed).toBe(true);
    expect(parsed.details.diffStat).toContain("1 file changed");
    expect(parsed.details.diffStat).toContain("220 insertions(+)");
    expect(parsed.details.diffStat).toContain("220 deletions(-)");
    expect(parsed.details.diffTruncated).toBe(true);
    expect(parsed.details.diff).toContain("... [truncated");
    expect(parsed.details.diffMeta.omittedLines).toBeGreaterThan(0);
  });

  test("edit_file requires a unique match", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "target.txt"), "foo\nfoo\n", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    await expect(
      tools.edit_file({
        path: "target.txt",
        oldText: "foo",
        newText: "bar",
      })
    ).rejects.toThrow("must be unique");
  });

  test("edit_file rejects whole-file replacement", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "target.txt"), "entire file body", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    await expect(
      tools.edit_file({
        path: "target.txt",
        oldText: "entire file body",
        newText: "rewritten body",
      })
    ).rejects.toThrow("Use write_file");
  });

  test("replace_in_files previews and applies replacements", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "a.js"), "foo();\nfoo();\n", "utf8");
    await fs.writeFile(path.join(dir, "src", "b.js"), "foo();\n", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const previewRaw = await tools.replace_in_files({
      path: "src",
      find: "foo()",
      replace: "bar()",
      file_pattern: "**/*.js",
      apply: false,
    });
    const preview = JSON.parse(previewRaw);
    expect(preview.mode).toBe("preview");
    expect(preview.replacements).toBe(3);

    const applyRaw = await tools.replace_in_files({
      path: "src",
      find: "foo()",
      replace: "bar()",
      file_pattern: "**/*.js",
      apply: true,
    });
    const applied = JSON.parse(applyRaw);
    expect(applied.mode).toBe("apply");
    expect(applied.replacements).toBe(3);

    const a = await fs.readFile(path.join(dir, "src", "a.js"), "utf8");
    const b = await fs.readFile(path.join(dir, "src", "b.js"), "utf8");
    expect(a).toContain("bar()");
    expect(b).toContain("bar()");
  });

  test("search_files handles very large matching files without crashing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const large = `${"logo\n".repeat(700000)}`;
    await fs.writeFile(path.join(dir, "huge.txt"), large, "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.search_files({ regex: "logo", path: "." });
    expect(result).toMatch(/Found matches in|Found \d+ matches/);
    expect(result).toContain("huge.txt");
  });

  test("search_files accepts query alias for regex", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "sample.js"), "const todo_write = true;\n", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.search_files({ query: "todo_write", path: "." });
    expect(result).toContain("sample.js");
  });

  test("search_files returns empty output when there are no matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.writeFile(path.join(dir, "sample.js"), "const present = true;\n", "utf8");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const result = await tools.search_files({ query: "definitely_absent", path: "." });
    expect(result).toBe("");
  });

  test("rg searches code with ripgrep-style aliases without shell approval", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "alpha.js"), "export function targetSymbol() {}\n", "utf8");
    await fs.writeFile(path.join(dir, "src", "beta.txt"), "targetSymbol in text\n", "utf8");
    let approvalCalls = 0;
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => {
        approvalCalls += 1;
        return false;
      },
    });

    const result = await tools.rg({
      pattern: "targetSymbol",
      path: "src",
      glob: "*.js",
      fixed_strings: true,
      max_results: 10,
    });

    expect(approvalCalls).toBe(0);
    expect(result).toContain("src/alpha.js");
    expect(result).not.toContain("src/beta.txt");
  });

  test("web_search uses Brave API and returns structured results", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      expect(String(url)).toContain("api.search.brave.com");
      expect(String(url)).toContain("q=piecode");
      expect(init?.headers?.["X-Subscription-Token"]).toBe("brave-test-key");
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "PieCode docs",
                url: "https://example.com/piecode",
                description: "A coding agent.",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => false,
      webSearch: { provider: "brave", braveApiKey: "brave-test-key" },
    });

    try {
      const raw = await tools.web_search({ query: "piecode", max_results: 1 });
      const parsed = JSON.parse(raw);
      expect(parsed.provider).toBe("brave");
      expect(parsed.results[0]).toMatchObject({
        title: "PieCode docs",
        url: "https://example.com/piecode",
        snippet: "A coding agent.",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("web_search can read Brave key from OpenClaw config fallback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-openclaw-home-"));
    const originalOpenClawConfigPath = process.env.PIECODE_OPENCLAW_CONFIG_PATH;
    const originalFetch = global.fetch;
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({
        tools: { web: { search: { provider: "brave" } } },
        plugins: { entries: { brave: { config: { webSearch: { apiKey: "openclaw-brave-key" } } } } },
      }),
      "utf8"
    );
    process.env.PIECODE_OPENCLAW_CONFIG_PATH = path.join(home, ".openclaw", "openclaw.json");
    global.fetch = async (_url, init) => {
      expect(init?.headers?.["X-Subscription-Token"]).toBe("openclaw-brave-key");
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => false,
    });

    try {
      const raw = await tools.web_search({ query: "piecode", max_results: 1 });
      const parsed = JSON.parse(raw);
      expect(parsed.provider).toBe("brave");
    } finally {
      global.fetch = originalFetch;
      if (originalOpenClawConfigPath === undefined) delete process.env.PIECODE_OPENCLAW_CONFIG_PATH;
      else process.env.PIECODE_OPENCLAW_CONFIG_PATH = originalOpenClawConfigPath;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("git_status and git_diff return graceful output outside git repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const status = await tools.git_status();
    expect(typeof status).toBe("string");
    expect(status.length).toBeGreaterThan(0);

    const diff = await tools.git_diff();
    expect(typeof diff).toBe("string");
    expect(diff.length).toBeGreaterThan(0);
  });

  test("run_tests returns structured summary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    const raw = await tools.run_tests({ command: 'node -e "process.exit(0)"' });
    const parsed = JSON.parse(raw);
    expect(parsed.command).toContain("node -e");
    expect(parsed.exit_code).toBe(0);
    expect(parsed.passed).toBe(true);
  });

  test("unclassified shell command returns non-approved message when approval is denied", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => false,
    });

    const result = await tools.shell({ command: "python3 -V" });
    expect(result).toBe("Command was not approved by the user.");
  });

  test("safe shell command is auto-approved even when auto-approve is off", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => {
        throw new Error("askApproval should not be called for safe commands");
      },
    });

    const result = await tools.shell({ command: "pwd" });
    expect(result).toContain("command: pwd");
    expect(result).not.toContain("exit_code:");
  });

  test("failed shell command includes exit_code for timeline status", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => true,
    });

    const result = await tools.shell({ command: "false" });
    expect(result).toContain("command: false");
    expect(result).toContain("exit_code: 1");
  });

  test("higher-risk shell helpers and destructive flags are not classified safe", () => {
    expect(classifyShellCommand("find . -delete").level).toBe("dangerous");
    expect(classifyShellCommand("sed -i s/a/b/ file.txt").level).toBe("dangerous");
    expect(classifyShellCommand("env").level).not.toBe("safe");
    expect(classifyShellCommand("printenv").level).not.toBe("safe");
    expect(classifyShellCommand("xargs rm").level).toBe("dangerous");
    expect(classifyShellCommand("rg foo src").level).toBe("safe");
  });

  test("read_file rejects symlink escape outside workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await fs.symlink(outside, path.join(dir, "link"), "dir");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    await expect(tools.read_file({ path: "link/secret.txt" })).rejects.toThrow(/escapes workspace/i);
  });

  test("write_file rejects writes through symlinked parent outside workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-outside-"));
    await fs.symlink(outside, path.join(dir, "out"), "dir");
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
    });

    await expect(tools.write_file({ path: "out/new.txt", content: "nope" })).rejects.toThrow(/escapes workspace/i);
    await expect(fs.readFile(path.join(outside, "new.txt"), "utf8")).rejects.toThrow();
  });

  test("git status is treated as safe and auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => {
        throw new Error("askApproval should not be called for safe git status");
      },
    });

    const result = await tools.shell({ command: "git status --short" });
    expect(result).toContain("command: git status --short");
    expect(result).toContain("exit_code:");
  });

  test("command with env executable requires approval", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const seen = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async (_tool, info) => {
        seen.push(info?.classification?.level);
        return true;
      },
    });

    const command = "env | head -n 1";
    expect(classifyShellCommand(command).level).toBe("unclassified");
    await tools.shell({ command });
    expect(seen).toEqual(["unclassified"]);
  });

  test("awk and sed pipelines require approval", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const seen = [];
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async (_tool, info) => {
        seen.push(info?.classification?.level);
        return true;
      },
    });

    const command = "echo hello | sed 's/hello/hi/' | awk '{print $1}'";
    expect(classifyShellCommand(command).level).toBe("unclassified");
    await tools.shell({ command });
    expect(seen).toEqual(["unclassified"]);
  });

  test("dangerous shell command always requires approval even when auto-approve is on", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    let asked = 0;
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => {
        asked += 1;
        return false;
      },
    });

    const result = await tools.shell({ command: "rm -rf /tmp/should-not-run" });
    expect(asked).toBe(1);
    expect(result).toBe("Command was not approved by the user.");
  });

  test("shell approval can remember an exact command for the current session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    let asked = 0;
    const shellPermissionRef = { value: {} };
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      shellPermissionRef,
      askApproval: async () => {
        asked += 1;
        return "remember_command";
      },
    });

    const first = await tools.shell({ command: "python3 -V" });
    const second = await tools.shell({ command: "python3   -V" });

    expect(first).toContain("command: python3 -V");
    expect(second).toContain("command: python3   -V");
    expect(first).not.toContain("exit_code:");
    expect(second).not.toContain("exit_code:");
    expect(asked).toBe(1);
    expect(shellPermissionRef.value.rememberedCommands.has("python3 -V")).toBe(true);
  });

  test("shell approval can allow all commands for the current session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    let asked = 0;
    const shellPermissionRef = { value: {} };
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      shellPermissionRef,
      askApproval: async () => {
        asked += 1;
        return "allow_all_session";
      },
    });

    const first = await tools.shell({ command: "python3 -V" });
    const second = await tools.shell({ command: "node -v" });

    expect(first).toContain("command: python3 -V");
    expect(second).toContain("command: node -v");
    expect(first).not.toContain("exit_code:");
    expect(second).not.toContain("exit_code:");
    expect(asked).toBe(1);
    expect(shellPermissionRef.value.allowAllSession).toBe(true);
  });

  test("git commit requires explicit approval even when auto-approve is on", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    let asked = 0;
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: true },
      askApproval: async () => {
        asked += 1;
        return false;
      },
    });

    const result = await tools.shell({ command: 'git commit -m "test"' });
    expect(asked).toBe(1);
    expect(result).toBe("Command was not approved by the user.");
  });

  test("large shell output is stored to workspace file with preview", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => true,
    });

    const result = await tools.shell({
      command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"',
      timeout: 30000,
    });

    expect(result).toContain("Result too long (chars:");
    const match = result.match(/saved to (\.piecode\/shell\/result-[^\s]+\.txt)/);
    expect(match).toBeTruthy();
    const relPath = match[1];
    const abs = path.join(dir, relPath);
    const saved = await fs.readFile(abs, "utf8");
    expect(saved).toContain("command: node -e");
    expect(saved).not.toContain("exit_code:");
    expect(saved.length).toBeGreaterThan(12000);
  });
});

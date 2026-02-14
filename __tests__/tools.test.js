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

    expect(typeof tools.read_files).toBe("function");
    expect(typeof tools.glob_files).toBe("function");
    expect(typeof tools.find_files).toBe("function");
    expect(typeof tools.apply_patch).toBe("function");
    expect(typeof tools.replace_in_files).toBe("function");
    expect(typeof tools.git_status).toBe("function");
    expect(typeof tools.git_diff).toBe("function");
    expect(typeof tools.run_tests).toBe("function");
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
    expect(result).toContain("exit_code: 0");
  });

  test("safe command with stderr redirect to /dev/null is auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-tools-"));
    const tools = createToolset({
      workspaceDir: dir,
      autoApproveRef: { value: false },
      askApproval: async () => {
        throw new Error("askApproval should not be called for safe command with /dev/null redirect");
      },
    });

    const result = await tools.shell({ command: 'find . -name "package.json" 2>/dev/null' });
    expect(result).toContain("exit_code: 0");
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
    expect(result).toContain("exit_code:");
  });

  test("command with env assignments is classified safe", async () => {
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

    const command = "FOO=bar env | head -n 1";
    expect(classifyShellCommand(command).level).toBe("safe");
    await tools.shell({ command });
    expect(seen).toEqual([]);
  });

  test("awk and sed are treated as safe commands", async () => {
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
    expect(classifyShellCommand(command).level).toBe("safe");
    await tools.shell({ command });
    expect(seen).toEqual([]);
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
    expect(saved).toContain("exit_code: 0");
    expect(saved.length).toBeGreaterThan(12000);
  });
});

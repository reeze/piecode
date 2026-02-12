import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createToolset } from "../src/lib/tools.js";

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

  test("command with env assignments is classified safe for approval", async () => {
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

    await tools.shell({ command: "FOO=bar env | head -n 1" });
    expect(seen).toContain("safe");
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

    await tools.shell({ command: "echo hello | sed 's/hello/hi/' | awk '{print $1}'" });
    expect(seen).toEqual(["safe"]);
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

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
});

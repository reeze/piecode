import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTmuxSubagentWatcher,
  formatSubagentEventLine,
  isSubagentSessionEvent,
  readSubagentEventLines,
  resolveTmuxSubagentOptions,
  sanitizeTmuxWindowName,
  shellQuote,
} from "../src/lib/tmuxSubagentWindows.js";
import { SessionEventBus } from "../src/lib/sessionProtocol.js";

describe("tmux subagent windows", () => {
  test("resolves tmux options from args/env", () => {
    expect(resolveTmuxSubagentOptions({ env: {}, workspaceDir: "/tmp/w", sessionId: "s1" }).enabled).toBe(false);

    const envEnabled = resolveTmuxSubagentOptions({
      env: { PIECODE_TMUX_SUBAGENTS: "1", TMUX: "/tmp/tmux" },
      workspaceDir: "/tmp/w",
      sessionId: "s1",
    });
    expect(envEnabled.enabled).toBe(true);
    expect(envEnabled.available).toBe(true);
    expect(envEnabled.eventsFile).toBe(path.join("/tmp/w", ".piecode", "sessions", "s1", "events.jsonl"));

    const outsideTmux = resolveTmuxSubagentOptions({
      args: { tmuxSubagents: true },
      env: {},
      workspaceDir: "/tmp/w",
      sessionId: "s1",
    });
    expect(outsideTmux.enabled).toBe(true);
    expect(outsideTmux.available).toBe(false);
    expect(outsideTmux.reason).toBe("not-in-tmux");

    const configuredFile = resolveTmuxSubagentOptions({
      args: { tmuxSubagents: true },
      env: { TMUX: "1", PIECODE_SESSION_EVENTS_FILE: "/tmp/events.jsonl" },
      workspaceDir: "/tmp/w",
      sessionId: "s1",
    });
    expect(configuredFile.eventsFile).toBe("/tmp/events.jsonl");
  });

  test("sanitizes window names and shell quotes command args", () => {
    expect(sanitizeTmuxWindowName("security reviewer!! with spaces")).toBe("pie:security-reviewer-with-s");
    expect(sanitizeTmuxWindowName("", { maxLength: 10 })).toBe("pie:agent");
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
    expect(shellQuote("")).toBe("''");
  });

  test("identifies and formats subagent session events", () => {
    const start = {
      at: "2025-01-01T00:00:00.000Z",
      type: "agent.subagent_start",
      payload: { id: "sub-1", role: "reviewer", mode: "analysis", toolBudget: 3, task: "Review auth" },
    };
    expect(isSubagentSessionEvent(start, "sub-1")).toBe(true);
    expect(isSubagentSessionEvent(start, "other")).toBe(false);
    expect(isSubagentSessionEvent({ type: "agent.tool_use", payload: {} })).toBe(false);
    expect(formatSubagentEventLine(start)).toContain("start reviewer (sub-1)");
    expect(formatSubagentEventLine(start)).toContain("task: Review auth");

    const tool = {
      at: "2025-01-01T00:00:01.000Z",
      type: "agent.subagent_event",
      payload: { id: "sub-1", event: { type: "tool_use", tool: "read_file", input: { path: "src/app.js" } } },
    };
    expect(formatSubagentEventLine(tool)).toContain("tool_use read_file");
    expect(formatSubagentEventLine(tool)).toContain("src/app.js");

    const end = {
      at: "2025-01-01T00:00:02.000Z",
      type: "agent.subagent_end",
      payload: { id: "sub-1", role: "reviewer", status: "done", tools: ["read_file"] },
    };
    expect(formatSubagentEventLine(end)).toContain("done reviewer (sub-1)");
    expect(formatSubagentEventLine(end)).toContain("tools=read_file");
  });

  test("spawns one tmux window per subagent start", () => {
    const bus = new SessionEventBus({ sessionId: "s1" });
    const calls = [];
    const spawn = (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    };
    const watcher = createTmuxSubagentWatcher({
      sessionBus: bus,
      eventsFile: "/tmp/events.jsonl",
      workspaceDir: "/tmp/work",
      cliPath: "/tmp/pie cli.js",
      spawn,
    });

    bus.emit("agent.subagent_start", { id: "sub-1", role: "security reviewer", task: "x" });
    bus.emit("agent.subagent_start", { id: "sub-1", role: "security reviewer", task: "x" });
    bus.emit("agent.subagent_event", { id: "sub-2" });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("tmux");
    expect(calls[0][1][0]).toBe("new-window");
    expect(calls[0][1][2]).toBe("pie:security-reviewer");
    expect(calls[0][1][3]).toContain("--watch-subagent-events '/tmp/events.jsonl'");
    expect(calls[0][1][3]).toContain("--subagent-id 'sub-1'");
    expect(calls[0][1][3]).not.toContain("task");
    expect(calls[0][2].cwd).toBe("/tmp/work");
    watcher.close();
  });

  test("spawn errors are non-fatal and disable future windows", () => {
    const bus = new SessionEventBus({ sessionId: "s1" });
    const logs = [];
    const children = [];
    const spawn = () => {
      const child = new EventEmitter();
      child.unref = () => {};
      children.push(child);
      return child;
    };
    createTmuxSubagentWatcher({
      sessionBus: bus,
      eventsFile: "/tmp/events.jsonl",
      workspaceDir: "/tmp/work",
      cliPath: "/tmp/cli.js",
      spawn,
      log: (line) => logs.push(line),
    });

    bus.emit("agent.subagent_start", { id: "sub-1", role: "reviewer" });
    expect(children).toHaveLength(1);
    children[0].emit("error", new Error("tmux missing"));
    bus.emit("agent.subagent_start", { id: "sub-2", role: "reviewer" });

    expect(children).toHaveLength(1);
    expect(logs.join("\n")).toContain("tmux missing");
  });

  test("reads and filters existing subagent event JSONL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "piecode-tmux-"));
    const file = path.join(dir, "events.jsonl");
    try {
      await writeFile(
        file,
        [
          JSON.stringify({ type: "agent.subagent_start", payload: { id: "sub-1", role: "a", task: "one" } }),
          "not-json",
          JSON.stringify({ type: "agent.subagent_start", payload: { id: "sub-2", role: "b", task: "two" } }),
          JSON.stringify({ type: "agent.subagent_end", payload: { id: "sub-1", role: "a", status: "done" } }),
          "",
        ].join("\n"),
        "utf8"
      );
      const lines = await readSubagentEventLines({ filePath: file, subagentId: "sub-1" });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("task: one");
      expect(lines[1]).toContain("done a (sub-1)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

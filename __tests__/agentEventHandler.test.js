import { createAgentEventHandler } from "../src/lib/agentEventHandler.js";

describe("agent event handler progress", () => {
  test("emits user-visible progress for tool_use thought without trace mode", () => {
    const lines = [];
    const handler = createAgentEventHandler({
      logLine: (line) => lines.push(line),
      summarizeForLog: (value) => String(value || ""),
      formatReadableToolRunLine: (tool) => `[run] ${tool}`,
      formatStageUpdate: (value) => String(value || "").replace(/\s+/g, " ").trim(),
      traceRef: { value: false },
      todosRef: { value: [] },
      todoAutoTrackRef: { value: false },
    });

    handler({
      type: "tool_use",
      tool: "rg",
      input: { pattern: "progress", path: "src" },
      thought: "I am checking how progress reaches the timeline.",
    });

    expect(lines).toContain("[progress] I am checking how progress reaches the timeline.");
    expect(lines.some((line) => line.startsWith("[thought]"))).toBe(false);
  });

  test("keeps tool_use thought transient in TUI instead of duplicating progress", () => {
    const lines = [];
    const liveThoughts = [];
    const handler = createAgentEventHandler({
      logLine: (line) => lines.push(line),
      summarizeForLog: (value) => String(value || ""),
      formatReadableToolRunLine: (tool) => `[run] ${tool}`,
      formatStageUpdate: (value) => String(value || "").replace(/\s+/g, " ").trim(),
      traceRef: { value: false },
      todosRef: { value: [] },
      todoAutoTrackRef: { value: false },
      tui: {
        onToolUse: () => {},
        setLiveThought: (value) => liveThoughts.push(value),
      },
    });

    handler({
      type: "tool_use",
      tool: "rg",
      input: { pattern: "progress", path: "src" },
      thought: "I am checking how progress reaches the timeline.",
    });

    expect(liveThoughts).toEqual(["I am checking how progress reaches the timeline."]);
    expect(lines).not.toContain("[progress] I am checking how progress reaches the timeline.");
  });

  test("keeps thought events transient in TUI instead of duplicating progress", () => {
    const lines = [];
    const liveThoughts = [];
    const handler = createAgentEventHandler({
      logLine: (line) => lines.push(line),
      summarizeForLog: (value) => String(value || ""),
      formatReadableToolRunLine: (tool) => `[run] ${tool}`,
      formatStageUpdate: (value) => String(value || "").replace(/\s+/g, " ").trim(),
      traceRef: { value: false },
      todosRef: { value: [] },
      todoAutoTrackRef: { value: false },
      tui: {
        setLiveThought: (value) => liveThoughts.push(value),
      },
    });

    handler({
      type: "thought",
      content: "I am checking the TUI render path now.",
    });

    expect(liveThoughts).toEqual(["I am checking the TUI render path now."]);
    expect(lines).not.toContain("[progress] I am checking the TUI render path now.");
  });

  test("does not emit progress for todo_write tool_use chatter", () => {
    const lines = [];
    const handler = createAgentEventHandler({
      logLine: (line) => lines.push(line),
      summarizeForLog: (value) => String(value || ""),
      formatReadableToolRunLine: (tool) => `[run] ${tool}`,
      formatStageUpdate: (value) => String(value || "").replace(/\s+/g, " ").trim(),
      traceRef: { value: false },
      todosRef: { value: [] },
      todoAutoTrackRef: { value: false },
    });

    handler({
      type: "tool_use",
      tool: "todo_write",
      input: { todos: [{ content: "Inspect", status: "in_progress" }] },
      thought: "I will track the task list.",
    });

    expect(lines).not.toContain("[progress] I will track the task list.");
  });
});

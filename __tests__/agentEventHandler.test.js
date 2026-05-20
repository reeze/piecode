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

  test("keeps tool_use thought live in TUI and emits one timeline update", () => {
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
    expect(lines).toContain("[progress] I am checking how progress reaches the timeline.");
  });

  test("dedupes repeated thought and tool_use progress in TUI", () => {
    const lines = [];
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
        setLiveThought: () => {},
      },
    });

    handler({ type: "thought", content: "I am checking the render path." });
    handler({
      type: "tool_use",
      tool: "read_file",
      input: { path: "src/lib/tui.js" },
      thought: "I am checking the render path.",
    });

    expect(lines.filter((line) => line === "[progress] I am checking the render path.")).toHaveLength(1);
  });

  test("keeps thought events live in TUI and emits one timeline update", () => {
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
    expect(lines).toContain("[progress] I am checking the TUI render path now.");
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

  test("collapses parallel batch tool starts into one compact tools line", () => {
    const lines = [];
    const handler = createAgentEventHandler({
      logLine: (line) => lines.push(line),
      summarizeForLog: (value) => String(value || ""),
      formatToolBatchSummary: (calls) =>
        `read_file x${calls.length} - ${calls.map((call) => `read_file(${call.input.path})`).join("; ")}`,
      formatToolCounts: (tools) => `read_file x${tools.length}`,
      formatReadableToolRunLine: (_tool, input) => `[run] read ${input.path}`,
      traceRef: { value: false },
      todosRef: { value: [] },
      todoAutoTrackRef: { value: false },
    });

    handler({
      type: "tool_batch_start",
      calls: [
        { tool: "read_file", input: { path: "README.md" } },
        { tool: "read_file", input: { path: "src/cli.js" } },
        { tool: "read_file", input: { path: "src/web/server.js" } },
      ],
    });
    handler({ type: "tool_start", tool: "read_file", input: { path: "README.md" } });
    handler({ type: "tool_start", tool: "read_file", input: { path: "src/cli.js" } });
    handler({ type: "tool_start", tool: "read_file", input: { path: "src/web/server.js" } });

    expect(lines).toEqual([
      "[tools] read_file x3 - read_file(README.md); read_file(src/cli.js); read_file(src/web/server.js)",
    ]);
  });
});

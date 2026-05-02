import {
  AgentSessionState,
  SessionEventBus,
  normalizeSessionEvent,
} from "../src/lib/sessionProtocol.js";

describe("session protocol", () => {
  test("normalizes events for GUI/remote consumers", () => {
    const event = normalizeSessionEvent("agent.tool_use", {
      tool: "shell",
      input: { command: "echo hi" },
    }, { sessionId: "s1", id: "e1", at: "2025-01-01T00:00:00.000Z" });

    expect(event).toEqual({
      schema: "piecode.session.event.v1",
      id: "e1",
      at: "2025-01-01T00:00:00.000Z",
      type: "agent.tool_use",
      sessionId: "s1",
      payload: {
        tool: "shell",
        input: { command: "echo hi" },
      },
    });
  });

  test("event bus broadcasts and stores recent events", () => {
    const bus = new SessionEventBus({ sessionId: "s2" });
    const seen = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    const emitted = bus.emit("task.start", { input: "fix bug" });

    expect(emitted.sessionId).toBe("s2");
    expect(seen).toHaveLength(1);
    expect(bus.events).toHaveLength(1);

    unsubscribe();
    bus.emit("task.done", { ok: true });
    expect(seen).toHaveLength(1);
    expect(bus.events).toHaveLength(2);
  });

  test("session state applies events into a GUI-friendly snapshot", () => {
    const state = new AgentSessionState({ sessionId: "s3" });
    state.apply(normalizeSessionEvent("task.start", { input: "inspect repo" }, { sessionId: "s3" }));
    state.apply(normalizeSessionEvent("agent.model_call", { provider: "codex", model: "gpt-5.3-codex" }, { sessionId: "s3" }));
    state.apply(normalizeSessionEvent("agent.tool_use", { tool: "read_file" }, { sessionId: "s3" }));
    state.apply(normalizeSessionEvent("todos.update", { todos: [{ id: "1", content: "read", status: "completed" }] }, { sessionId: "s3" }));

    expect(state.snapshot()).toMatchObject({
      schema: "piecode.session.state.v1",
      sessionId: "s3",
      status: "running",
      provider: "codex",
      model: "gpt-5.3-codex",
      currentTask: "inspect repo",
      activeTool: "read_file",
      timelineLength: 4,
    });
    expect(state.snapshot().todos).toHaveLength(1);

    state.apply(normalizeSessionEvent("task.done", {}, { sessionId: "s3" }));
    expect(state.snapshot().status).toBe("idle");
  });
});

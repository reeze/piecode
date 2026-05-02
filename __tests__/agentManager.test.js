import { AgentManager } from "../src/lib/agentManager.js";

describe("AgentManager", () => {
  test("tracks active and completed subagent lifecycle", () => {
    const manager = new AgentManager({ maxCompleted: 2 });

    const started = manager.start({ task: "Review providers", toolBudget: 3 });
    expect(started.id).toBe("subagent-1");
    expect(manager.snapshot().active).toHaveLength(1);

    const updated = manager.recordEvent(started.id, { type: "tool_use", tool: "rg" });
    expect(updated.lastTool).toBe("rg");
    expect(updated.tools).toEqual(["rg"]);

    const done = manager.finish(started.id, { status: "done", result: "ok" });
    expect(done.status).toBe("done");
    const snapshot = manager.snapshot();
    expect(snapshot.active).toHaveLength(0);
    expect(snapshot.completed).toHaveLength(1);
    expect(snapshot.completed[0].result).toBe("ok");
  });

  test("caps completed records", () => {
    const manager = new AgentManager({ maxCompleted: 1 });
    const first = manager.start({ task: "one" });
    manager.finish(first.id, { status: "done" });
    const second = manager.start({ task: "two" });
    manager.finish(second.id, { status: "done" });

    const snapshot = manager.snapshot();
    expect(snapshot.completed).toHaveLength(1);
    expect(snapshot.completed[0].task).toBe("two");
  });
});

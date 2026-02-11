import { Agent } from "../src/lib/agent.js";

function createAgentWithProvider(provider = {}) {
  return new Agent({
    provider: {
      kind: "test-provider",
      model: "test-model",
      async complete() {
        return "- Summary: compacted";
      },
      ...provider,
    },
    workspaceDir: process.cwd(),
    autoApproveRef: { value: false },
    askApproval: async () => true,
    activeSkillsRef: { value: [] },
    projectInstructionsRef: { value: null },
  });
}

describe("agent context controls", () => {
  test("clearHistory clears all turn history", () => {
    const agent = createAgentWithProvider();
    agent.history = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ];

    agent.clearHistory();

    expect(agent.history).toEqual([]);
  });

  test("compactHistory summarizes old turns and keeps recent turns", async () => {
    const agent = createAgentWithProvider({
      async complete() {
        return "- constraints kept\n- unresolved item kept";
      },
    });

    agent.history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a4" },
    ];

    const result = await agent.compactHistory({ preserveRecent: 3 });

    expect(result.compacted).toBe(true);
    expect(result.beforeMessages).toBe(8);
    expect(result.afterMessages).toBe(4);
    expect(agent.history[0].role).toBe("assistant");
    expect(String(agent.history[0].content)).toContain("[CONTEXT SUMMARY]");
    expect(String(agent.history[0].content)).toContain("constraints kept");
    expect(agent.history.slice(1)).toEqual([
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a4" },
    ]);
  });

  test("compactHistory skips when there is not enough history", async () => {
    const agent = createAgentWithProvider();
    agent.history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];

    const result = await agent.compactHistory({ preserveRecent: 4 });

    expect(result.compacted).toBe(false);
    expect(result.beforeMessages).toBe(2);
    expect(result.afterMessages).toBe(2);
    expect(agent.history).toHaveLength(2);
  });

  test("requestAbort interrupts an active runTurn", async () => {
    const agent = createAgentWithProvider({
      async complete({ signal }) {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('{"type":"final","message":"done"}'), 5000);
          if (signal) {
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true }
            );
          }
        });
      },
    });

    const turnPromise = agent.runTurn("hello");
    await new Promise((r) => setTimeout(r, 20));
    const requested = agent.requestAbort();
    expect(requested).toBe(true);
    await expect(turnPromise).rejects.toMatchObject({ code: "TASK_ABORTED" });
  });
});

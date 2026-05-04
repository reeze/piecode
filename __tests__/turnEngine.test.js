import { TurnEngine } from "../src/lib/turnEngine.js";

describe("TurnEngine loop handling", () => {
  function createAgent({ finalText = "Finalized from collected evidence." } = {}) {
    return {
      workspaceDir: "/tmp/work",
      history: [
        {
          role: "user",
          content: JSON.stringify({ type: "tool_result", tool: "read_file", result: "same evidence" }),
        },
      ],
      defaultToolBudget: 4,
      provider: {
        kind: "test",
        model: "test-model",
        async complete() {
          return JSON.stringify({ type: "final", message: finalText });
        },
      },
      onEvent: () => {},
      emitLlmResponse: () => {},
    };
  }

  test("repeated tool guard finalizes from evidence instead of returning a stop-loop message", async () => {
    const engine = new TurnEngine(createAgent(), { userMessage: "inspect layout" });

    const message = await engine.finalizeAfterRepeatedToolResult({ reason: "repeated_tool_result" });

    expect(message).toBe("Finalized from collected evidence.");
    expect(message).not.toContain("Stopping to avoid");
    expect(message).not.toContain("tool loop");
  });

  test("repeated tool guard fallback is user-facing and does not say it stopped", async () => {
    const engine = new TurnEngine(createAgent({ finalText: "" }), { userMessage: "inspect layout" });

    const message = await engine.finalizeAfterRepeatedToolResult({ reason: "repeated_tool_call" });

    expect(message).toContain("avoided another duplicate call");
    expect(message).toContain("finalizing from the evidence already collected");
    expect(message).not.toContain("Stopping to avoid");
    expect(message).not.toContain("tool loop");
  });
});

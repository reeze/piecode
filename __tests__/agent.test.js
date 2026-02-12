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

  test("stops when the same tool call repeats without progress", async () => {
    const agent = createAgentWithProvider({
      async complete() {
        return JSON.stringify({
          type: "tool_use",
          tool: "todo_write",
          input: {
            todos: [{ id: "t1", content: "repeat", status: "pending" }],
          },
          reason: "track work",
        });
      },
    });

    const result = await agent.runTurn("do something");
    expect(result).toContain("Todo list is already up to date");
  });

  test("duplicate normalized shell calls are eventually stopped by generic loop protection", async () => {
    const workspaceDir = process.cwd();
    let idx = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete() {
          idx += 1;
          if (idx === 1) {
            return JSON.stringify({
              type: "tool_use",
              tool: "shell",
              input: { command: "git status" },
              reason: "check status",
            });
          }
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: `cd ${workspaceDir} && git status` },
            reason: "check status again",
          });
        },
      },
      workspaceDir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("run pwd and confirm it");
    expect(result).toContain("same verified step result");
  });

  test("repo status policy forces single shell call then finalizes", async () => {
    let calls = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete() {
          calls += 1;
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "git status" },
            reason: "check repo status",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("check the status of this repo(git status)");
    expect(calls).toBe(1);
    expect(result).toContain("Ran `git status`.");
  });

  test("diff summary policy caps shell calls and finalizes after second check", async () => {
    let calls = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return JSON.stringify({
              type: "tool_use",
              tool: "shell",
              input: { command: "git status" },
              reason: "check working tree state",
            });
          }
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "git diff --stat" },
            reason: "summarize changed files",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("please summerize the diff tell me what happened");
    expect(calls).toBe(2);
    expect(result).toContain("Ran `git diff --stat`.");
  });

  test("diff summary with commit message gets a final synthesis turn", async () => {
    let calls = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return JSON.stringify({
              type: "tool_use",
              tool: "shell",
              input: { command: "git status --short" },
              reason: "check changed files",
            });
          }
          if (calls === 2) {
            return JSON.stringify({
              type: "tool_use",
              tool: "shell",
              input: { command: "git diff --stat" },
              reason: "inspect scope of changes",
            });
          }
          return JSON.stringify({
            type: "final",
            message:
              "Changed files were updated and summarized from git output.\n\nSuggested commit message:\nfeat: summarize repo diff and adjust TUI timeline rendering",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn(
      "summerize the diff tell me what happened, please generate a commit message for it."
    );
    expect(calls).toBe(3);
    expect(result.toLowerCase()).toContain("suggested commit message");
  });

  test("executes all native tool calls returned in a single response", async () => {
    let calls = 0;
    const agent = new Agent({
      provider: {
        kind: "openrouter-compatible",
        model: "moonshotai/kimi-k2.5",
        supportsNativeTools: true,
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:0",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"echo one\"}" },
                  },
                  {
                    id: "shell:1",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"echo two\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          return {
            message: {
              role: "assistant",
              content: "done",
            },
            finishReason: "stop",
          };
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("check two quick commands then summarize");
    const toolResults = agent.history.filter((m) => {
      if (m.role !== "user") return false;
      try {
        const parsed = JSON.parse(String(m.content || ""));
        return parsed?.type === "tool_result";
      } catch {
        return false;
      }
    });

    expect(calls).toBe(2);
    expect(toolResults).toHaveLength(2);
    expect(result).toContain("done");
  });

  test("forces final synthesis when model keeps asking tools after tool budget", async () => {
    let nativeTurns = 0;
    let finalizeTurns = 0;
    const agent = new Agent({
      provider: {
        kind: "openrouter-compatible",
        model: "moonshotai/kimi-k2.5",
        supportsNativeTools: true,
        async complete(args = {}) {
          if (args && args.tools) {
            nativeTurns += 1;
            if (nativeTurns === 1) {
              return {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "shell:0",
                      type: "function",
                      function: { name: "shell", arguments: "{\"command\":\"echo one\"}" },
                    },
                    {
                      id: "shell:1",
                      type: "function",
                      function: { name: "shell", arguments: "{\"command\":\"echo two\"}" },
                    },
                  ],
                },
                finishReason: "tool_calls",
              };
            }
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:2",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"echo three\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          finalizeTurns += 1;
          return "Summary from evidence.\nSuggested commit message: chore: summarize diff changes";
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn(
      "summerize the diff tell me what happened, please generate a commit message for it."
    );
    expect(nativeTurns).toBe(2);
    expect(finalizeTurns).toBe(1);
    expect(result.toLowerCase()).toContain("suggested commit message");
  });

  test("stops alternating tools when a verified outcome repeats", async () => {
    let idx = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete() {
          idx += 1;
          if (idx === 1) {
            return JSON.stringify({
              type: "tool_use",
              tool: "shell",
              input: { command: "pwd" },
              reason: "check cwd",
            });
          }
          if (idx === 2) {
            return JSON.stringify({
              type: "tool_use",
              tool: "list_files",
              input: { path: "." },
              reason: "inspect files",
            });
          }
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "pwd" },
            reason: "verify cwd again",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("do those things: inspect workspace and verify cwd");
    expect(result).toContain("same verified step result");
  });
});

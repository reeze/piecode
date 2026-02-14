import { Agent } from "../src/lib/agent.js";
import os from "os";
import path from "path";
import { mkdtemp, readFile, rm } from "fs/promises";

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

  test("plan-only mode returns a plan without executing tools", async () => {
    let completeCalls = 0;
    const agent = createAgentWithProvider({
      async complete() {
        completeCalls += 1;
        if (completeCalls === 1) {
          return JSON.stringify({
            summary: "Implement feature safely",
            steps: ["Inspect related files", "Design minimal edits", "Validate with tests"],
            toolBudget: 3,
          });
        }
        return JSON.stringify({
          type: "final",
          message:
            "Summary: Implement feature safely\nSteps:\n1. Inspect related files\n2. Design minimal edits\n3. Validate with tests\nNo files were changed.",
        });
      },
    });

    let shellCalls = 0;
    let writeCalls = 0;
    agent.tools.shell = async () => {
      shellCalls += 1;
      throw new Error("shell should not run in plan-only mode");
    };
    agent.tools.write_file = async () => {
      writeCalls += 1;
      throw new Error("write_file should not run in plan-only mode");
    };

    const result = await agent.runTurn("implement a new feature", { planOnly: true });

    expect(result).toContain("No files were changed.");
    expect(result).toContain("Summary: Implement feature safely");
    expect(result).toContain("1. Inspect related files");
    expect(completeCalls).toBe(2);
    expect(shellCalls).toBe(0);
    expect(writeCalls).toBe(0);
  });

  test("plan-only mode allows safe tool calls before finalizing plan", async () => {
    let completeCalls = 0;
    const agent = createAgentWithProvider({
      async complete() {
        completeCalls += 1;
        if (completeCalls === 1) {
          return JSON.stringify({
            summary: "Investigate then plan",
            steps: ["Inspect current state", "Draft plan"],
            toolBudget: 2,
          });
        }
        if (completeCalls === 2) {
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "pwd" },
            reason: "confirm current working directory",
          });
        }
        return JSON.stringify({
          type: "final",
          message: "Summary: Drafted plan after safe checks.\nSteps:\n1. Review files\n2. Apply minimal change\n3. Run tests",
        });
      },
    });

    let shellCalls = 0;
    let writeCalls = 0;
    agent.tools.shell = async () => {
      shellCalls += 1;
      return "Command: pwd\nOutput:\n/tmp/workspace";
    };
    agent.tools.write_file = async () => {
      writeCalls += 1;
      throw new Error("write_file should not run in plan-only mode");
    };

    const result = await agent.runTurn("fix lint", { planOnly: true });

    expect(result).toContain("Plan mode is ON");
    expect(result).toContain("Drafted plan");
    expect(completeCalls).toBe(3);
    expect(shellCalls).toBe(1);
    expect(writeCalls).toBe(0);
  });

  test("plan-only mode blocks unsafe tools", async () => {
    let completeCalls = 0;
    const agent = createAgentWithProvider({
      async complete() {
        completeCalls += 1;
        if (completeCalls === 1) {
          return JSON.stringify({
            summary: "Prepare plan",
            steps: ["Inspect", "Plan"],
            toolBudget: 2,
          });
        }
        return JSON.stringify({
          type: "tool_use",
          tool: "write_file",
          input: { path: "x.txt", content: "x" },
          reason: "apply change",
        });
      },
    });

    let writeCalls = 0;
    agent.tools.write_file = async () => {
      writeCalls += 1;
      return "should never run";
    };

    const result = await agent.runTurn("fix lint", { planOnly: true });

    expect(result).toContain("not allowed for this turn policy");
    expect(result).toContain("write_file");
    expect(completeCalls).toBe(2);
    expect(writeCalls).toBe(0);
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

  test("native llm_request logs full messages including user prompt", async () => {
    const llmRequests = [];
    const agent = new Agent({
      provider: {
        kind: "openrouter-compatible",
        model: "moonshotai/kimi-k2.5",
        supportsNativeTools: true,
        async complete() {
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
      onEvent: (evt) => {
        if (evt?.type === "llm_request" && evt?.stage === "turn") {
          llmRequests.push(String(evt.payload || ""));
        }
      },
    });

    await agent.runTurn("test prompt content");
    expect(llmRequests.length).toBeGreaterThan(0);
    const payload = llmRequests[0];
    expect(payload).toContain("MESSAGES:");
    expect(payload).toContain("TOOLS:");
    expect(payload).toContain("test prompt content");
  });

  test("openai-native mode sends tool results as role=tool messages", async () => {
    const seenMessages = [];
    let calls = 0;
    const agent = new Agent({
      provider: {
        kind: "openrouter-compatible",
        model: "moonshotai/kimi-k2.5",
        supportsNativeTools: true,
        async complete(args = {}) {
          calls += 1;
          if (Array.isArray(args.messages)) {
            seenMessages.push(args.messages);
          }
          if (calls === 1) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "read_file:0",
                    type: "function",
                    function: { name: "read_file", arguments: "{\"path\":\"AGENTS.md\"}" },
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

    const result = await agent.runTurn("take a look at AGENTS.md");
    expect(result).toContain("done");
    expect(seenMessages.length).toBeGreaterThanOrEqual(2);

    const second = seenMessages[1];
    const toolResultMessage = second.find((m) => m.role === "tool");
    expect(toolResultMessage).toBeTruthy();
    expect(toolResultMessage.tool_call_id).toBe("read_file:0");
    expect(String(toolResultMessage.content || "")).toContain("# Pie Code Agent");
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
    expect(nativeTurns).toBe(1);
    expect(finalizeTurns).toBe(1);
    expect(result.toLowerCase()).toContain("suggested commit message");
  });

  test("blocks non-read-only shell commands in diff-summary turns", async () => {
    let calls = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete(args = {}) {
          calls += 1;
          if (calls === 1) {
            return JSON.stringify({
              type: "tool_use",
              tool: "shell",
              input: { command: "git commit -m \"oops\"" },
              reason: "commit changes",
            });
          }
          if (args?.prompt && String(args.prompt).includes("Collected evidence:")) {
            return "Summary only.\nSuggested commit message: chore: summarize diff";
          }
          return JSON.stringify({ type: "final", message: "done" });
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
    const hasCommitToolResult = agent.history.some((m) => {
      if (m.role !== "user") return false;
      try {
        const parsed = JSON.parse(String(m.content || ""));
        return parsed?.type === "tool_result" && String(parsed?.result || "").includes("git commit");
      } catch {
        return false;
      }
    });
    expect(hasCommitToolResult).toBe(false);
    expect(result.toLowerCase()).toContain("suggested commit message");
  });

  test("commit request finalizes after first commit attempt to avoid repeated commits", async () => {
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
              input: { command: "git commit --dry-run -m \"test\"" },
              reason: "commit changes",
            });
          }
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "git status" },
            reason: "retry status",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("please help me commit them with the generated message");
    expect(calls).toBe(1);
    expect(result.toLowerCase()).toContain("git commit --dry-run -m \"test\"");
  });

  test("finalizes immediately after git commit even without commit-intent policy", async () => {
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
              input: { command: "git commit --dry-run -m \"test\"" },
              reason: "commit changes",
            });
          }
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "git status" },
            reason: "post-commit check",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("yes");
    expect(calls).toBe(1);
    expect(result.toLowerCase()).toContain("git commit --dry-run -m \"test\"");
  });

  test("repeated git status without commit progression is stopped by generic loop guard", async () => {
    let normalTurns = 0;
    let finalizeTurns = 0;
    const agent = new Agent({
      provider: {
        kind: "test-provider",
        model: "test-model",
        async complete(args = {}) {
          if (String(args?.prompt || "").includes("Collected evidence:")) {
            finalizeTurns += 1;
            return "Checked repository state once.\nUse: git add -A && git commit -m \"chore: commit changes\"";
          }
          normalTurns += 1;
          return JSON.stringify({
            type: "tool_use",
            tool: "shell",
            input: { command: "git status" },
            reason: "check status before commit",
          });
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("please help me commit them with the generated message");
    expect(normalTurns).toBe(2);
    expect(finalizeTurns).toBe(0);
    expect(result.toLowerCase()).toContain("same verified step result");
  });

  test("commit request with batched duplicate status continues to diff and commit", async () => {
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
                    function: { name: "shell", arguments: "{\"command\":\"git status\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          if (calls === 2) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:1",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"git status\"}" },
                  },
                  {
                    id: "shell:2",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"git diff --stat\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          if (calls === 3) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:3",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"git add -A\"}" },
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
                  id: "shell:4",
                  type: "function",
                  function: { name: "shell", arguments: "{\"command\":\"git commit --dry-run -m \\\"chore: test\\\"\"}" },
                },
              ],
            },
            finishReason: "tool_calls",
          };
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    await agent.runTurn("please help me commit the changes with a generated commit message");
    const assistantToolUses = agent.history
      .filter((m) => m.role === "assistant")
      .map((m) => {
        try {
          return JSON.parse(String(m.content || ""));
        } catch {
          return null;
        }
      })
      .filter((v) => v && v.type === "tool_use");
    const sawDiffStat = assistantToolUses.some((u) => String(u?.input?.command || "").includes("git diff --stat"));
    const sawCommit = assistantToolUses.some((u) =>
      String(u?.input?.command || "").toLowerCase().startsWith("git commit --dry-run")
    );
    expect(sawDiffStat).toBe(true);
    expect(sawCommit).toBe(true);
  });

  test("commit request can still commit after prep reaches tool cap once", async () => {
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
                    function: { name: "shell", arguments: "{\"command\":\"git status\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          if (calls === 2) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:1",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"git diff --stat\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          if (calls === 3) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:2",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"git diff --cached --stat\"}" },
                  },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          if (calls === 4) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "shell:3",
                    type: "function",
                    function: { name: "shell", arguments: "{\"command\":\"git add -A\"}" },
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
                  id: "shell:4",
                  type: "function",
                  function: { name: "shell", arguments: "{\"command\":\"git commit --dry-run -m \\\"chore: commit\\\"\"}" },
                },
              ],
            },
            finishReason: "tool_calls",
          };
        },
      },
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const result = await agent.runTurn("please commit the current changes with generated commit message");
    expect(result.toLowerCase()).toContain("git commit --dry-run -m \"chore: commit\"");
  });

  test("commit explanation question should not trigger commit-request turn contract", async () => {
    const llmRequests = [];
    const agent = new Agent({
      provider: {
        kind: "openrouter-compatible",
        model: "moonshotai/kimi-k2.5",
        supportsNativeTools: true,
        async complete() {
          return {
            message: {
              role: "assistant",
              content: "I should explain first.",
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
      onEvent: (evt) => {
        if (evt?.type === "llm_request" && evt?.stage === "turn") llmRequests.push(String(evt.payload || ""));
      },
    });

    await agent.runTurn("why don't you call git commit, which prompt disallow you?");
    expect(llmRequests.length).toBeGreaterThan(0);
    expect(llmRequests[0]).not.toContain("TURN EXECUTION CONTRACT:");
    expect(llmRequests[0]).not.toContain("Intent: repo_commit_request");
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

  test("complex prompt can generate a command-line scientific calculator", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "piecode-scicalc-"));
    const llmSystemPrompts = [];
    let calls = 0;
    const calculatorSource = [
      "#!/usr/bin/env node",
      "const [op, ...args] = process.argv.slice(2);",
      "const nums = args.map((v) => Number(v));",
      "if (!op) {",
      "  console.log('Usage: scicalc <op> <numbers...>');",
      "  process.exit(1);",
      "}",
      "const unary = (fn) => {",
      "  if (nums.length !== 1 || Number.isNaN(nums[0])) throw new Error('Expected one numeric argument');",
      "  return fn(nums[0]);",
      "};",
      "const binary = (fn) => {",
      "  if (nums.length !== 2 || Number.isNaN(nums[0]) || Number.isNaN(nums[1])) throw new Error('Expected two numeric arguments');",
      "  return fn(nums[0], nums[1]);",
      "};",
      "let result;",
      "switch (op) {",
      "  case 'add': result = nums.reduce((a, b) => a + b, 0); break;",
      "  case 'sub': result = binary((a, b) => a - b); break;",
      "  case 'mul': result = nums.reduce((a, b) => a * b, 1); break;",
      "  case 'div': result = binary((a, b) => a / b); break;",
      "  case 'pow': result = binary((a, b) => Math.pow(a, b)); break;",
      "  case 'sqrt': result = unary((a) => Math.sqrt(a)); break;",
      "  case 'sin': result = unary((a) => Math.sin(a)); break;",
      "  case 'cos': result = unary((a) => Math.cos(a)); break;",
      "  case 'tan': result = unary((a) => Math.tan(a)); break;",
      "  case 'log': result = unary((a) => Math.log(a)); break;",
      "  default:",
      "    throw new Error(`Unknown operation: ${op}`);",
      "}",
      "console.log(result);",
    ].join("\n");

    try {
      const agent = new Agent({
        provider: {
          kind: "test-provider",
          model: "test-model",
          async complete(args = {}) {
            llmSystemPrompts.push(String(args?.systemPrompt || ""));
            calls += 1;
            if (calls === 1) {
              return JSON.stringify({
                type: "tool_use",
                tool: "write_file",
                input: {
                  path: "bin/scicalc.js",
                  content: calculatorSource,
                },
                reason: "Create the scientific calculator CLI entry point",
              });
            }
            if (calls === 2) {
              return JSON.stringify({
                type: "tool_use",
                tool: "write_file",
                input: {
                  path: "README.scicalc.md",
                  content:
                    "## Scientific Calculator CLI\n\nUsage:\n- `node bin/scicalc.js add 1 2`\n- `node bin/scicalc.js sin 0.5`\n",
                },
                reason: "Add usage documentation",
              });
            }
            return JSON.stringify({
              type: "final",
              message: "Implemented `bin/scicalc.js` and added `README.scicalc.md` usage examples.",
            });
          },
        },
        workspaceDir,
        autoApproveRef: { value: true },
        askApproval: async () => true,
        activeSkillsRef: { value: [] },
        projectInstructionsRef: { value: null },
      });

      const result = await agent.runTurn(
        "Build a command-line scientific calculator with trig/log/power operations and add usage docs."
      );
      const script = await readFile(path.join(workspaceDir, "bin/scicalc.js"), "utf8");
      const readme = await readFile(path.join(workspaceDir, "README.scicalc.md"), "utf8");

      expect(result).toContain("bin/scicalc.js");
      expect(script).toContain("process.argv.slice(2)");
      expect(script).toContain("case 'sin'");
      expect(script).toContain("case 'sqrt'");
      expect(script).toContain("case 'pow'");
      expect(readme).toContain("Scientific Calculator CLI");
      expect(readme).toContain("node bin/scicalc.js");
      expect(llmSystemPrompts[0]).toContain("COMPLEX TASK EXECUTION:");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

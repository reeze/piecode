import { Agent } from "../src/lib/agent.js";
import { createEmptyLedger } from "../src/lib/taskLedger.js";

function createAgent({ complete, ledgerRef, onLedgerUpdate } = {}) {
  return new Agent({
    provider: {
      kind: "test-provider",
      model: "test-model",
      supportsNativeTools: false,
      complete: complete || (async () => JSON.stringify({ type: "final", message: "done" })),
    },
    workspaceDir: process.cwd(),
    autoApproveRef: { value: true },
    askApproval: async () => true,
    activeSkillsRef: { value: [] },
    projectInstructionsRef: { value: null },
    ledgerRef,
    onLedgerUpdate,
  });
}

describe("agent task ledger", () => {
  test("starts from an empty ledger and reports no durable state", () => {
    const agent = createAgent();
    expect(agent.hasLedgerState()).toBe(false);
    expect(agent.getLedgerPrompt()).toBe("");
  });

  test("records the first substantive request as the objective", async () => {
    const agent = createAgent();
    await agent.runTurn("Add multi-provider support to the model picker");

    expect(agent.getLedger().objective).toBe("Add multi-provider support to the model picker");
    expect(agent.getLedger().turnCount).toBe(1);
  });

  test("keeps the original objective across later turns", async () => {
    const agent = createAgent();
    await agent.runTurn("Add multi-provider support to the model picker");
    await agent.runTurn("now also update the docs");

    expect(agent.getLedger().objective).toBe("Add multi-provider support to the model picker");
    expect(agent.getLedger().turnCount).toBe(2);
  });

  test("ignores trivial one-word turns as objectives", async () => {
    const agent = createAgent();
    await agent.runTurn("hi");
    expect(agent.getLedger().objective).toBe("");
  });

  test("tool outcomes fold into the ledger and notify the host", () => {
    const saved = [];
    const agent = createAgent({ onLedgerUpdate: (ledger) => saved.push(ledger) });

    agent.recordToolInLedger({ tool: "write_file", input: { path: "src/lib/x.js" }, result: "ok" });
    agent.recordToolInLedger({ tool: "shell", input: { command: "npm test" }, result: "all good" });

    const ledger = agent.getLedger();
    expect(ledger.changedFiles).toEqual(["src/lib/x.js"]);
    expect(ledger.validations).toEqual([{ command: "npm test", result: "passed" }]);
    expect(saved).toHaveLength(2);
  });

  test("a no-op update neither mutates state nor notifies", () => {
    const saved = [];
    const agent = createAgent({ onLedgerUpdate: (ledger) => saved.push(ledger) });
    agent.updateLedger({ changedFiles: ["a.js"] });
    const afterFirst = agent.getLedger();

    expect(agent.updateLedger({ changedFiles: ["a.js"] })).toBeNull();
    expect(agent.getLedger()).toEqual(afterFirst);
    expect(saved).toHaveLength(1);
  });

  test("the ledger reaches the system prompt so it survives compaction", () => {
    const ledgerRef = { value: createEmptyLedger() };
    const agent = createAgent({ ledgerRef });
    agent.updateLedger({
      objective: "Ship the provider registry",
      todos: [{ content: "wire the cli", status: "in_progress" }],
      nextStep: "run the suite",
    });

    const prompt = agent.getCachedSystemPrompt({
      workspaceDir: agent.workspaceDir,
      autoApprove: false,
      taskLedger: agent.getLedgerPrompt(),
    });

    expect(prompt).toContain("TASK LEDGER");
    expect(prompt).toContain("Ship the provider registry");
    expect(prompt).toContain("[~] wire the cli");
    expect(prompt).toContain("next step: run the suite");
  });

  test("updating the ledger invalidates the cached system prompt", () => {
    const agent = createAgent();
    const options = { workspaceDir: agent.workspaceDir, autoApprove: false };

    agent.updateLedger({ objective: "first objective" });
    const before = agent.getCachedSystemPrompt({ ...options, taskLedger: agent.getLedgerPrompt() });
    expect(before).toContain("first objective");

    agent.updateLedger({ nextStep: "second step" });
    const after = agent.getCachedSystemPrompt({ ...options, taskLedger: agent.getLedgerPrompt() });
    expect(after).toContain("second step");
  });

  test("subagents read the parent ledger but cannot write to it", async () => {
    const agent = createAgent();
    agent.updateLedger({ objective: "parent objective" });

    const prompt = agent.buildSubagentPrompt({ task: "inspect something" });
    expect(prompt).toContain("Parent task state:");
    expect(prompt).toContain("parent objective");

    const result = await agent.runSubagent({ task: "inspect something" });
    expect(typeof result).toBe("string");
    // The child kept its own snapshot, so the parent objective is untouched.
    expect(agent.getLedger().objective).toBe("parent objective");
  });
});

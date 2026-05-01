import { TaskExecutor, TaskPlanner, TaskType } from "../src/lib/taskPlanner.js";

describe("task planner", () => {
  function createPlanner() {
    return new TaskPlanner({
      provider: {
        async complete() {
          return JSON.stringify({
            type: "analysis_result",
            taskType: "analysis",
            difficulty: "simple",
            goal: "analyze project",
            subTasks: [],
            requiredTools: ["list_files"],
            challenges: [],
          });
        },
      },
    });
  }

  test("uses deterministic analysis for obvious tasks without calling the model", async () => {
    let calls = 0;
    const planner = new TaskPlanner({
      provider: {
        async complete() {
          calls += 1;
          return "{}";
        },
      },
    });

    const analysis = await planner.analyzeTask("fix the crash when opening the agent view");

    expect(analysis.taskType).toBe(TaskType.DEBUGGING);
    expect(analysis.requiredTools).toEqual(["git_status", "search_files", "run_tests"]);
    expect(calls).toBe(0);
  });

  test("uses model refinement for ambiguous multi-intent requests", async () => {
    let calls = 0;
    const planner = new TaskPlanner({
      provider: {
        async complete() {
          calls += 1;
          return JSON.stringify({
            type: "analysis_result",
            taskType: "implementation",
            difficulty: "complex",
            goal: "implement and document a larger feature",
            subTasks: [{ id: "step1", description: "inspect the system" }],
            requiredTools: ["list_files", "read_file"],
            challenges: ["cross-cutting changes"],
          });
        },
      },
    });

    const analysis = await planner.analyzeTask(
      "First inspect the architecture, then implement the new feature, and finally document the rollout plan."
    );

    expect(analysis.taskType).toBe(TaskType.IMPLEMENTATION);
    expect(analysis.difficulty).toBe("complex");
    expect(analysis.challenges).toEqual(["cross-cutting changes"]);
    expect(calls).toBe(1);
  });

  test("debugging plan uses native tools instead of shell pipelines", async () => {
    const planner = createPlanner();
    const plan = await planner.createExecutionPlan({ taskType: TaskType.DEBUGGING });

    expect(plan.map((step) => step.tool)).toEqual([
      "git_status",
      "run_tests",
      "search_files",
      "git_diff",
    ]);
  });

  test("testing plan points at __tests__ and coverage discovery helpers", async () => {
    const planner = createPlanner();
    const plan = await planner.createExecutionPlan({ taskType: TaskType.TESTING });

    expect(plan[2].tool).toBe("list_files");
    expect(plan[2].input.path).toBe("__tests__");
    expect(plan[3].tool).toBe("find_files");
    expect(plan[3].input.query).toBe("coverage");
  });
});

describe("task executor", () => {
  test("dispatches non-shell tools through the shared tool registry", async () => {
    const calls = [];
    const executor = new TaskExecutor(
      {
        autoApproveRef: { value: false },
        tools: {
          git_status: async (input) => {
            calls.push(["git_status", input]);
            return "clean";
          },
          run_tests: async (input) => {
            calls.push(["run_tests", input]);
            return "passed";
          },
        },
      },
      []
    );

    const statusStep = { id: "status", description: "Check repo", tool: "git_status", input: { porcelain: false } };
    const testsStep = { id: "tests", description: "Run tests", tool: "run_tests", input: { command: "npm test" } };

    await executor.executeStep(statusStep);
    await executor.executeStep(testsStep);

    expect(statusStep.status).toBe("completed");
    expect(statusStep.result).toBe("clean");
    expect(testsStep.status).toBe("completed");
    expect(testsStep.result).toBe("passed");
    expect(calls).toEqual([
      ["git_status", { porcelain: false }],
      ["run_tests", { command: "npm test" }],
    ]);
  });

  test("records skipped critical steps as not successful", async () => {
    const executor = new TaskExecutor(
      {
        autoApproveRef: { value: false },
        tools: {
          write_file: async () => {
            throw new Error("write_file should be skipped");
          },
        },
      },
      [
        {
          id: "write",
          description: "Write generated file",
          tool: "write_file",
          input: { path: "out.txt", content: "x" },
        },
      ]
    );

    const results = await executor.executePlan();

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].skipped).toBe(true);
    expect(results[0].step.status).toBe("skipped");
  });
});

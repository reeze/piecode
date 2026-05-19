import {
  buildGoalContinuationPrompt,
  buildGoalPrompt,
  createGoalRun,
  parseGoalStatus,
  resolveGoalMaxTurns,
  summarizeGoalOutput,
} from "../src/lib/goalMode.js";

describe("goal mode helpers", () => {
  test("builds a prompt for long-running work with acceptance audit requirements", () => {
    const prompt = buildGoalPrompt("implement durable sessions");

    expect(prompt).toContain("implement durable sessions");
    expect(prompt).toContain("durable, multi-turn goal loop");
    expect(prompt).toContain("Build a prompt-to-artifact acceptance checklist");
    expect(prompt).toContain("Do not mark the goal complete from intent, effort, or passing proxy checks alone");
    expect(prompt).toContain("GOAL_STATUS: complete");
  });

  test("continuation prompt carries the prior status without unbounded output growth", () => {
    const prompt = buildGoalContinuationPrompt("ship the feature", 7, "x".repeat(3000), { maxIterations: 9 });

    expect(prompt).toContain("Goal supervisor loop iteration 7/9");
    expect(prompt).toContain("Goal: ship the feature");
    expect(prompt.length).toBeLessThan(1900);
    expect(prompt).toContain("Previous goal-mode checkpoint:");
    expect(prompt).toContain("status: continue");
  });

  test("goal output summary keeps high-value evidence and status compact", () => {
    const summary = summarizeGoalOutput([
      "Long narrative ".repeat(300),
      "Changed files: src/lib/goalMode.js, src/lib/tui.js",
      "Validation: npm test -- --runTestsByPath __tests__/goalMode.test.js",
      "GOAL_STATUS: complete",
    ].join("\n"));

    expect(summary).toContain("status: complete");
    expect(summary).toContain("Changed files: src/lib/goalMode.js");
    expect(summary).toContain("Validation: npm test");
    expect(summary.length).toBeLessThan(1100);
  });

  test("continuation prompt can reuse a precomputed checkpoint", () => {
    const prompt = buildGoalContinuationPrompt("ship the feature", 2, "raw output that should be ignored", {
      maxIterations: 5,
      checkpoint: "status: continue\nsummary: cached checkpoint",
    });

    expect(prompt).toContain("Goal supervisor loop iteration 2/5");
    expect(prompt).toContain("summary: cached checkpoint");
    expect(prompt).not.toContain("raw output that should be ignored");
  });

  test("parses the last explicit status line", () => {
    const output = [
      "GOAL_STATUS: continue",
      "details",
      "GOAL_STATUS: blocked",
    ].join("\n");

    expect(parseGoalStatus(output)).toBe("blocked");
    expect(parseGoalStatus("no status")).toBe("continue");
  });

  test("uses a long-job default turn limit with bounded env overrides", () => {
    expect(resolveGoalMaxTurns({})).toBe(50);
    expect(resolveGoalMaxTurns({ PIECODE_GOAL_MAX_TURNS: "2" })).toBe(2);
    expect(resolveGoalMaxTurns({ PIECODE_GOAL_MAX_TURNS: "0" })).toBe(1);
    expect(resolveGoalMaxTurns({ PIECODE_GOAL_MAX_TURNS: "1000" })).toBe(200);
    expect(resolveGoalMaxTurns({ PIECODE_GOAL_MAX_TURNS: "nope" })).toBe(50);
  });

  test("goal runs execute even when normal plan mode is enabled", () => {
    const run = createGoalRun("fix the repo", { env: { PIECODE_GOAL_MAX_TURNS: "9" }, planModeEnabled: true });

    expect(run).toMatchObject({
      goal: "fix the repo",
      iteration: 1,
      maxIterations: 9,
      lastCheckpoint: "",
      status: "continue",
      planOnly: false,
    });
  });
});

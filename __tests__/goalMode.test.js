import {
  buildGoalContinuationPrompt,
  buildGoalPrompt,
  createGoalRun,
  parseGoalStatus,
  resolveGoalMaxTurns,
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
    const prompt = buildGoalContinuationPrompt("ship the feature", 7, "x".repeat(3000));

    expect(prompt).toContain("Goal supervisor loop iteration 7");
    expect(prompt).toContain("Goal: ship the feature");
    expect(prompt.length).toBeLessThan(2200);
    expect(prompt).toContain("Previous goal-mode response summary:");
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
      status: "continue",
      planOnly: false,
    });
  });
});

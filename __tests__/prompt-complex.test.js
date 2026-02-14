import { buildSystemPrompt } from "../src/lib/prompt.js";

describe("prompt complex-task refinements", () => {
  test("includes explicit complex-task execution guidance", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: false,
    });

    expect(prompt).toContain("COMPLEX TASK EXECUTION:");
    expect(prompt).toContain("3-7 step plan");
    expect(prompt).toContain("switch strategy using new evidence");
    expect(prompt).toContain("mention validation status");
  });

  test("renders object active plan with structured summary, steps, and budget", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: true,
      activePlan: {
        summary: "Stabilize onboarding flow",
        steps: ["Inspect current flow", "Patch validation bug", "Add regression test"],
        toolBudget: 5,
      },
    });

    expect(prompt).toContain("ACTIVE PLAN:");
    expect(prompt).toContain("Summary: Stabilize onboarding flow");
    expect(prompt).toContain("1. Inspect current flow");
    expect(prompt).toContain("3. Add regression test");
    expect(prompt).toContain("Tool budget: 5");
    expect(prompt).not.toContain("[object Object]");
  });

  test("renders object-based active skills with guidance excerpt", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: false,
      activeSkills: [
        {
          name: "demo-skill",
          path: "/skills/demo/SKILL.md",
          content: "# Demo\nUse strict typing.\nWrite tests for edge cases.",
        },
      ],
    });

    expect(prompt).toContain("ACTIVE SKILLS:");
    expect(prompt).toContain("demo-skill (/skills/demo/SKILL.md)");
    expect(prompt).toContain("Use strict typing.");
    expect(prompt).toContain("Write tests for edge cases.");
  });

  test("renders string active plan content", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: false,
      activePlan: "1. Inspect current errors\n2. Patch parser logic\n3. Re-run tests",
    });

    expect(prompt).toContain("ACTIVE PLAN:");
    expect(prompt).toContain("1. Inspect current errors");
    expect(prompt).toContain("Follow this plan unless tool evidence requires an adjustment.");
  });

  test("does not render active plan section for empty plan object", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: false,
      activePlan: {},
    });

    expect(prompt).not.toContain("ACTIVE PLAN:");
  });

  test("caps active plan steps to first eight entries", () => {
    const steps = Array.from({ length: 10 }, (_v, i) => `Step ${i + 1}`);
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: false,
      activePlan: {
        summary: "Long plan",
        steps,
      },
    });

    expect(prompt).toContain("8. Step 8");
    expect(prompt).not.toContain("9. Step 9");
    expect(prompt).not.toContain("10. Step 10");
  });

  test("renders mixed active skills formats without object leakage", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: false,
      activeSkills: [
        "string-skill",
        {
          id: "skill-with-id",
          content: "Use narrow diffs.\nAvoid broad rewrites.",
        },
      ],
    });

    expect(prompt).toContain("ACTIVE SKILLS:");
    expect(prompt).toContain("- string-skill");
    expect(prompt).toContain("- skill-with-id");
    expect(prompt).toContain("Use narrow diffs.");
    expect(prompt).not.toContain("[object Object]");
  });

  test("preserves turn execution contract while using complex guidance", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test/workspace",
      autoApprove: true,
      turnPolicy: {
        name: "repo_diff_summary",
        maxToolCalls: 2,
        forceFinalizeAfterTool: true,
        disableTodos: true,
        allowedTools: ["shell"],
        note: "Use only read-only git checks.",
        requireCommitMessage: true,
      },
    });

    expect(prompt).toContain("COMPLEX TASK EXECUTION:");
    expect(prompt).toContain("TURN EXECUTION CONTRACT:");
    expect(prompt).toContain("Intent: repo_diff_summary");
    expect(prompt).toContain("Maximum tool calls this turn: 2");
    expect(prompt).toContain("Allowed tools for this turn: shell");
    expect(prompt).toContain("Final answer must include a suggested commit message.");
  });
});

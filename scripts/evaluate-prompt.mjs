#!/usr/bin/env node
import { buildSystemPrompt } from "../src/lib/prompt.js";

const workspaceDir = process.cwd();

const scenarios = [
  {
    name: "native-base",
    options: { workspaceDir, autoApprove: false, nativeTools: true },
  },
  {
    name: "text-base",
    options: { workspaceDir, autoApprove: false, nativeTools: false },
  },
  {
    name: "native-rich-context",
    options: {
      workspaceDir,
      autoApprove: false,
      nativeTools: true,
      mcpEnabled: true,
      mcpServerNames: ["context7", "playwright"],
      activePlan: {
        summary: "Implement and validate a cross-cutting feature.",
        steps: ["Inspect", "Edit", "Validate", "Summarize"],
        toolBudget: 8,
      },
      memory: "- User prefers concise final answers with validation status.",
      projectInstructions: { source: "AGENTS.md", content: "Run relevant tests before finalizing." },
      agentDefinitions: [
        { name: "correctness-reviewer", description: "Review correctness and edge cases" },
        { name: "test-reviewer", description: "Review tests and validation" },
      ],
    },
  },
];

const checks = [
  {
    name: "autonomy",
    patterns: [/Keep going until the user's request is resolved/i, /do not simply stop unless you are truly blocked/i],
  },
  {
    name: "tool-grounding",
    patterns: [/do not guess about file contents, APIs, or repo structure/i, /Verify repository facts/i],
  },
  {
    name: "efficiency",
    patterns: [/avoid repeated identical read-only calls/i, /Start with the smallest targeted search\/read/i],
  },
  {
    name: "long-task-state",
    patterns: [/LONG TASK LOOP/i, /goal, constraints, repo facts, changed files, validation, blockers, and next step/i],
  },
  {
    name: "validation",
    patterns: [/VALIDATION LADDER/i, /tests\/lint\/typecheck\/build/i, /do not claim success unless validation or evidence supports it/i],
  },
  {
    name: "worktree-safety",
    patterns: [/WORKTREE SAFETY/i, /Treat uncommitted changes as user-owned/i],
  },
  {
    name: "done-criteria",
    patterns: [/DONE CRITERIA/i, /Avoid unrelated improvements unless asked/i],
  },
  {
    name: "memory-safety",
    patterns: [/never store secrets/i, /do not re-read them unless exact quotes are needed/i],
  },
];

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function scorePrompt(prompt) {
  const results = checks.map((check) => {
    const passed = check.patterns.every((pattern) => pattern.test(prompt));
    return { name: check.name, passed };
  });
  return {
    passed: results.filter((item) => item.passed).length,
    total: results.length,
    results,
  };
}

let failed = false;
for (const scenario of scenarios) {
  const prompt = buildSystemPrompt(scenario.options);
  const score = scorePrompt(prompt);
  const chars = prompt.length;
  const tokens = estimateTokens(prompt);
  const budgetWarn = scenario.name.includes("base") && chars > (scenario.name.startsWith("native") ? 4200 : 6200);
  if (score.passed !== score.total || budgetWarn) failed = true;
  console.log(`\n## ${scenario.name}`);
  console.log(`chars=${chars} estimated_tokens=${tokens} checks=${score.passed}/${score.total}${budgetWarn ? " budget=warn" : ""}`);
  for (const item of score.results) {
    console.log(`${item.passed ? "✓" : "✗"} ${item.name}`);
  }
}

if (failed) {
  console.error("\nPrompt evaluation failed or exceeded budget warning threshold.");
  process.exit(1);
}

console.log("\nPrompt evaluation passed.");

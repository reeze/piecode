const DEFAULT_GOAL_MAX_TURNS = 50;
const MAX_GOAL_MAX_TURNS = 200;
const PREVIOUS_OUTPUT_SUMMARY_CHARS = 1200;

function clampInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function summarizeText(value, maxChars = PREVIOUS_OUTPUT_SUMMARY_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function resolveGoalMaxTurns(env = process.env) {
  return clampInteger(env?.PIECODE_GOAL_MAX_TURNS, {
    min: 1,
    max: MAX_GOAL_MAX_TURNS,
    fallback: DEFAULT_GOAL_MAX_TURNS,
  });
}

export function buildGoalPrompt(goal) {
  const task = String(goal || "").trim();
  return [
    "You are running in PieCode goal mode for the following long-running user goal:",
    task,
    "",
    "Goal-mode requirements:",
    "1. Treat this as a durable, multi-turn goal loop, not a short single response.",
    "2. Understand the goal before acting. Restate it as concrete deliverables and infer explicit acceptance criteria.",
    "3. If the request is blocked, unsafe, or critically ambiguous, ask exactly one clarifying question and mark the goal blocked; otherwise proceed.",
    "4. Create and maintain a concise TODO plan for multi-step work, updating statuses as evidence changes.",
    "5. Inspect the repository/context before editing; do not guess file contents, APIs, tests, or current state.",
    "6. Implement focused changes in coherent slices, then reassess global progress toward the acceptance criteria.",
    "7. Verify acceptance with the most relevant practical tests, lint, typecheck, build, smoke checks, or direct artifact inspection.",
    "8. Keep a compact working state: goal, constraints, decisions, changed files, validation, blockers, and next step.",
    "9. Before claiming completion, run a completion audit against actual evidence.",
    "10. Build a prompt-to-artifact acceptance checklist that maps each explicit requirement, named file, command, test, gate, and deliverable to concrete evidence.",
    "11. Do not accept proxy signals by themselves. Passing tests or substantial implementation effort count only if they cover the goal requirements.",
    "12. Do not mark the goal complete from intent, effort, or passing proxy checks alone; if any requirement is missing or weakly verified, continue.",
    "13. Keep driving the task until acceptance is satisfied, blocked by the user/environment, or the controller asks you to stop.",
    "",
    "At the end of every goal-mode response, include exactly one status line:",
    "GOAL_STATUS: continue  # more work remains and you can keep driving it",
    "GOAL_STATUS: complete  # acceptance criteria are satisfied and validation was attempted",
    "GOAL_STATUS: blocked   # cannot safely continue without user input or external unblocker",
    "",
    "If GOAL_STATUS is complete or blocked, include a concise final summary with validation and remaining risks.",
  ].join("\n");
}

export function buildGoalContinuationPrompt(goal, iteration, previousOutput) {
  const task = String(goal || "").trim();
  const last = summarizeText(previousOutput, PREVIOUS_OUTPUT_SUMMARY_CHARS);
  return [
    `Goal supervisor loop iteration ${iteration}: continue driving the long-running goal until accepted.`,
    `Goal: ${task}`,
    "",
    "Use the conversation history, current TODO state, compact working state, and repository state as the source of truth.",
    "Reassess global progress against the acceptance checklist, pick the next highest-value action, execute it, and verify when appropriate.",
    "Do not repeat completed work. Update TODOs when the plan changes or evidence invalidates an assumption.",
    "If acceptance is now satisfied, perform the completion audit and finish with GOAL_STATUS: complete.",
    "If you cannot safely continue without user input or an external blocker, finish with GOAL_STATUS: blocked.",
    "Otherwise finish with GOAL_STATUS: continue.",
    "",
    `Previous goal-mode response summary: ${last}`,
  ].join("\n");
}

export function parseGoalStatus(output) {
  const text = String(output || "");
  const matches = [...text.matchAll(/^\s*GOAL_STATUS\s*:\s*(complete|continue|blocked)\b/gim)];
  if (matches.length === 0) return "continue";
  return String(matches[matches.length - 1][1] || "continue").toLowerCase();
}

export function createGoalRun(goal, { env = process.env } = {}) {
  return {
    goal: String(goal || "").trim(),
    iteration: 1,
    maxIterations: resolveGoalMaxTurns(env),
    lastOutput: "",
    status: "continue",
    planOnly: false,
  };
}

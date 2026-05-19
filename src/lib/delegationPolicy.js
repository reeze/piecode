const DEFAULT_MAX_ACTIVE_ASSIGNMENTS = 3;

const TRIVIAL_PATTERNS = [
  /\bread\s+(the\s+)?(file|one file)\b/i,
  /\bopen\s+(the\s+)?file\b/i,
  /\bcat\s+\S+/i,
  /\bgrep\b/i,
  /\brg\b/i,
  /\bsearch\s+for\b/i,
  /\bfind\s+(where|symbol|references?)\b/i,
  /\bsummarize\s+(this|the)\s+file\b/i,
  /\brun\s+(one\s+)?test\b/i,
  /\bfix\s+(a\s+)?typo\b/i,
];

const TEAM_REQUEST_PATTERNS = [
  /\bteam\b/i,
  /\bagents?\b/i,
  /\bchief\b/i,
  /\breviewer\b/i,
  /\bspecialist\b/i,
  /\bsecurity-reviewer\b/i,
  /\bcorrectness-reviewer\b/i,
  /\barchitecture-reviewer\b/i,
  /\bmaintainability-reviewer\b/i,
  /\btest-reviewer\b/i,
];

const SUBSTANTIAL_PATTERNS = [
  /\breview\b/i,
  /\bsecurity\b/i,
  /\bcorrectness\b/i,
  /\barchitecture\b/i,
  /\bmaintainability\b/i,
  /\btests?\b/i,
  /\binvestigate\b/i,
  /\bacross\b/i,
  /\bimpact\b/i,
  /\bregression\b/i,
  /\bcall\s+sites?\b/i,
  /\ball\s+(usages|references)\b/i,
  /\bdesign\b/i,
  /\bimplementation\s+plan\b/i,
];

function includesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

export function userRequestedTeam(text = "") {
  return includesAny(TEAM_REQUEST_PATTERNS, String(text || ""));
}

export function evaluateDelegation({
  task = "",
  context = "",
  role = "",
  agent = "",
  name = "",
  reason = "",
  activeAssignments = 0,
  maxActiveAssignments = DEFAULT_MAX_ACTIVE_ASSIGNMENTS,
  userExplicitlyRequestedTeam = false,
} = {}) {
  const normalizedTask = String(task || "").replace(/\s+/g, " ").trim();
  const normalizedReason = String(reason || "").replace(/\s+/g, " ").trim();
  const normalizedContext = String(context || "").replace(/\s+/g, " ").trim();
  const requestedRole = String(role || agent || name || "").trim();
  const combined = [normalizedTask, normalizedReason, normalizedContext, requestedRole].filter(Boolean).join("\n");
  const explicitTeam = Boolean(userExplicitlyRequestedTeam) || userRequestedTeam(combined);

  if (!normalizedTask) {
    return {
      allowed: false,
      reason: "missing_task",
      message: "Team assignment skipped: missing task. Provide a concrete objective and expected output.",
    };
  }

  if (normalizedTask.length < 18 && !explicitTeam) {
    return {
      allowed: false,
      reason: "task_too_short",
      message: "Team assignment skipped: this task is too small for delegation; handle it directly.",
    };
  }

  const activeCount = Math.max(0, Number(activeAssignments) || 0);
  const maxActive = Math.max(1, Number(maxActiveAssignments) || DEFAULT_MAX_ACTIVE_ASSIGNMENTS);
  if (activeCount >= maxActive) {
    return {
      allowed: false,
      reason: "too_many_active_assignments",
      message: `Team assignment skipped: ${activeCount} team assignments are already active (limit ${maxActive}).`,
    };
  }

  const trivial = includesAny(TRIVIAL_PATTERNS, combined);
  const substantial = includesAny(SUBSTANTIAL_PATTERNS, combined);
  if (trivial && !explicitTeam && !substantial) {
    return {
      allowed: false,
      reason: "too_trivial",
      message: "Team assignment skipped: this looks like a simple local read/search/test task; handle it directly with normal tools.",
    };
  }

  if (!normalizedReason && !requestedRole && !explicitTeam && !substantial) {
    return {
      allowed: false,
      reason: "insufficient_justification",
      message: "Team assignment skipped: delegation needs a role, reason, or substantial independent scope.",
    };
  }

  return {
    allowed: true,
    reason: substantial ? "substantial_independent_work" : explicitTeam ? "explicit_team_request" : "justified_delegation",
    message: "Team assignment allowed.",
  };
}

export { DEFAULT_MAX_ACTIVE_ASSIGNMENTS };

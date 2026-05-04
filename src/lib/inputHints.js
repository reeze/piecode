export const DEFAULT_INPUT_HINTS = [
  "继续描述你想改什么…",
  "输入 /help 查看命令",
  "让 PieCode 解释刚才的改动",
  "让 PieCode review 当前改动",
  "让 PieCode 运行或补充测试",
];

const MAX_HINTS = 5;
const MAX_HINT_CHARS = 72;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function normalizeHint(value) {
  return String(value || "")
    .replace(ANSI_PATTERN, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateHint(value, maxChars = MAX_HINT_CHARS) {
  const text = normalizeHint(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function addHint(out, seen, value) {
  const hint = truncateHint(value);
  if (!hint) return;
  const key = hint.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(hint);
}

export function sanitizeInputHints(hints = [], { fallback = DEFAULT_INPUT_HINTS, maxHints = MAX_HINTS } = {}) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(hints) ? hints : [];
  for (const item of list) {
    addHint(out, seen, item);
    if (out.length >= maxHints) return out;
  }
  if (out.length > 0) return out;
  for (const item of Array.isArray(fallback) ? fallback : DEFAULT_INPUT_HINTS) {
    addHint(out, seen, item);
    if (out.length >= maxHints) break;
  }
  return out;
}

function textHasQuestion(text) {
  const value = String(text || "").trim();
  return /[?？]\s*$/.test(value) || /(which|what|should i|do you want|would you like|要不要|是否|需要我|你想)/i.test(value);
}

function textMentionsTests(text) {
  return /\b(test|tests|jest|vitest|npm test|failing|failed|failure)\b|测试|失败|报错/i.test(String(text || ""));
}

function textMentionsDiffOrChanges(text) {
  return /\b(diff|changed|modified|updated|edited|created|wrote)\b|改动|修改|变更|已更新/i.test(String(text || ""));
}

export function buildInputHints({
  lastUserMessage = "",
  assistantText = "",
  toolCalls = [],
  toolResults = [],
  changedFiles = [],
  hadError = false,
  testsFailed = false,
} = {}) {
  const hints = [];
  const seen = new Set();
  const assistant = String(assistantText || "");
  const combinedToolResults = Array.isArray(toolResults) ? toolResults.join("\n") : String(toolResults || "");
  const combined = `${assistant}\n${combinedToolResults}`;
  const toolNames = new Set((Array.isArray(toolCalls) ? toolCalls : []).map((item) => String(item?.tool || item || "").toLowerCase()));
  const hasChangedFiles = Array.isArray(changedFiles) && changedFiles.length > 0;
  const hasError = Boolean(hadError) || /\b(error|failed|failure|exception|exit\s+1)\b|报错|失败/i.test(combined);
  const hasTestFailure = Boolean(testsFailed) || (/\b(test|tests|jest|vitest|npm test)\b|测试/i.test(combined) && /\b(fail|failed|failure)\b|失败/i.test(combined));
  const usedWriteTool = ["write_file", "edit_file", "apply_patch", "replace_in_files"].some((name) => toolNames.has(name));
  const usedTestTool = toolNames.has("run_tests") || /\bnpm test\b|\bjest\b|测试/i.test(combined);

  if (hasTestFailure) {
    addHint(hints, seen, "修复失败的测试");
    addHint(hints, seen, "解释测试失败的原因");
  } else if (hasError) {
    addHint(hints, seen, "修复刚才的报错并重试");
    addHint(hints, seen, "解释为什么会失败");
  }

  if (hasChangedFiles || usedWriteTool || textMentionsDiffOrChanges(combined)) {
    addHint(hints, seen, "review 当前改动");
    if (!usedTestTool) addHint(hints, seen, "运行相关测试");
    addHint(hints, seen, "总结修改了哪些文件");
  }

  if (textHasQuestion(assistant)) {
    addHint(hints, seen, "回答上面的问题");
  }

  if (usedTestTool && !hasTestFailure) {
    addHint(hints, seen, "继续检查是否还有遗漏");
  }

  if (/\b(todo|next step|follow[- ]?up)\b|下一步|待办/i.test(`${lastUserMessage}\n${combined}`)) {
    addHint(hints, seen, "继续执行下一步");
  }

  for (const item of DEFAULT_INPUT_HINTS) {
    if (hints.length >= MAX_HINTS) break;
    addHint(hints, seen, item);
  }
  return sanitizeInputHints(hints);
}

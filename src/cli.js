#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import * as readlineCore from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { Agent } from "./lib/agent.js";
import { getProvider } from "./lib/providers.js";
import {
  addSkillByName,
  discoverSkills,
  loadActiveSkills,
  removeSkillByName,
  resolveRequestedSkills,
  resolveSkillRoots,
} from "./lib/skills.js";
import { createSkillInteractive } from "./lib/skillCreator.js";
import { SimpleTui } from "./lib/tui.js";
import { Display } from "./lib/display.js";

const HISTORY_MAX = 500;
const SLASH_COMMANDS = [
  "/help",
  "/exit",
  "/quit",
  "/clear",
  "/approve",
  "/model",
  "/skills",
  "/skills list",
  "/skills use",
  "/skills off",
  "/skills clear",
  "/use",
  "/skill-creator",
  "/workspace",
];

function createMutedTtyOutput(baseOut) {
  const muted = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  Object.defineProperty(muted, "isTTY", { value: true });
  Object.defineProperty(muted, "columns", {
    get() {
      return baseOut.columns || 100;
    },
  });
  Object.defineProperty(muted, "rows", {
    get() {
      return baseOut.rows || 30;
    },
  });
  return muted;
}

function getSettingsFilePath() {
  const configured = process.env.PIECODE_SETTINGS_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode", "settings.json");
}

async function loadSettings(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function resolveProviderOptions(args, settings) {
  const provider = args.provider || settings.provider || null;
  const providerSettings = 
    provider && settings.providers && typeof settings.providers === "object"
      ? settings.providers[provider] || {}
      : {};

  const model = 
    args.model ||
    settings.model ||
    providerSettings.model ||
    null;

  const endpoint = 
    args.baseUrl ||
    settings.endpoint ||
    settings.baseUrl ||
    providerSettings.endpoint ||
    providerSettings.baseUrl ||
    null;

  const apiKey = 
    args.apiKey ||
    settings.apiKey ||
    providerSettings.apiKey ||
    null;

  return {
    provider,
    apiKey,
    model,
    baseUrl: endpoint,
    endpoint,
  };
}

function getHistoryFilePath() {
  const configured = process.env.PIECODE_HISTORY_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode_history");
}

async function loadProjectInstructions(workspaceDir) {
  const candidates = ["AGENTS.md", "AGENT.md"];
  for (const name of candidates) {
    const filePath = path.join(workspaceDir, name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const trimmed = String(content || "").trim();
      if (trimmed) {
        return {
          source: name,
          path: filePath,
          content: trimmed,
        };
      }
    } catch {
      // ignore missing/unreadable file and try next candidate
    }
  }
  return null;
}

async function loadHistory(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const deduped = [];
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const item = lines[i];
      if (!seen.has(item)) {
        seen.add(item);
        deduped.push(item);
      }
      if (deduped.length >= HISTORY_MAX) break;
    }
    return deduped;
  } catch {
    return [];
  }
}

async function saveHistory(filePath, history) {
  const normalized = Array.isArray(history)
    ? history.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const oldestToNewest = [...normalized].reverse().slice(-HISTORY_MAX);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${oldestToNewest.join("\n")}\n`, "utf8");
  } catch {
    // History persistence is best-effort and should never crash the CLI.
  }
}

function printHelp() {
  console.log(`Piecode - CLI coding agent

Usage:
  piecode
  piecode --prompt "fix failing test"
  piecode --provider anthropic --api-key "sk-ant-..." --model "claude-3-5-sonnet-latest"
  piecode --help

Options:
  --prompt, -p         One-shot prompt to run
  --help, -h           Show this help
  --provider, -P       Model provider: anthropic, openai, codex, seed
  --api-key, -K        API key for the provider
  --model, -M          Model name to use
  --base-url, -B       Base URL for OpenAI-compatible endpoints (default: https://api.openai.com/v1)
  --skill, -S          Enable skill by name (repeatable)
  --list-skills        List discovered skills and exit
  --tui                Start simple full-screen TUI mode
  --disable-codex      Disable Codex CLI and auth file fallback (equivalent to PIECODE_DISABLE_CODEX_CLI=1)

Environment:
  ANTHROPIC_API_KEY    Preferred provider
  ANTHROPIC_MODEL      Optional (default claude-3-5-sonnet-latest)

  OPENAI_API_KEY       OpenAI-compatible fallback
  OPENAI_BASE_URL      Optional (default https://api.openai.com/v1)
  OPENAI_MODEL         Optional (default gpt-4.1-mini)

  SEED_API_KEY         Seed/Volcengine provider API key
  ARK_API_KEY          Alias for SEED_API_KEY
  SEED_BASE_URL        Optional (default https://ark.cn-beijing.volces.com/api/coding)
  SEED_MODEL           Optional (default doubao-seed-code-preview-latest)

  CODEX_HOME           Optional (default ~/.codex)
  CODEX_MODEL          Optional for codex token mode (default gpt-5-codex)
  PIECODE_DISABLE_CODEX_CLI Optional (set 1 to disable codex CLI session backend)
  PIECODE_ENABLE_PLANNER  Optional (set 1 to enable experimental task planner)
  PIECODE_PLAN_FIRST      Optional (default on; set 0 to disable lightweight pre-plan)
  PIECODE_TOOL_BUDGET     Optional (default 6, range 1-12)
  PIECODE_SETTINGS_FILE Optional (default ~/.piecode/settings.json)
  PIECODE_SKILLS_DIR Optional (comma-separated skill root directories)
  PIECODE_HISTORY_FILE Optional (default ~/.piecode_history)

Auth fallback order:
  1) Command line arguments --provider/--api-key/--model
  2) ~/.piecode/settings.json
  3) Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY)
  4) Codex CLI session (codex login)
  5) Codex auth file (~/.codex/auth.json)
  Note: Codex OAuth tokens can be scope-limited.

Slash commands in interactive mode:
  /help                Show commands
  /exit                Quit
  /quit                Quit (alias)
  /clear               Clear conversation history
  /approve on|off      Toggle shell auto-approval
  /model               Show active provider/model
  /skills              Show active skills
  /skills list         List discovered skills
  /skills use <name>   Enable a skill
  /skills off <name>   Disable a skill
  /skills clear        Disable all skills
  /use <name>          Alias for /skills use <name>
  /skill-creator       Interactive skill creation tool
  /workspace           Return to workspace timeline view
  CTRL+D               Press twice on empty input to exit (TUI mode)
  CTRL+L               Toggle event log panel (TUI mode)
  CTRL+T               Toggle TODO panel (TUI mode)
  CTRL+O               Toggle LLM request/response debug panel (TUI mode)

Skill invocation:
  Mention $skill-name in a prompt to auto-enable that skill.
`);
}

function parseArgs(argv) {
  const args = {
    prompt: null,
    help: false,
    provider: null,
    apiKey: null,
    model: null,
    baseUrl: null,
    disableCodex: false,
    skills: [],
    listSkills: false,
    tui: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--prompt" || a === "-p") {
      args.prompt = argv[i + 1] || "";
      i += 1;
    } else if (a === "--provider" || a === "-P") {
      args.provider = argv[i + 1] || "";
      i += 1;
    } else if (a === "--api-key" || a === "-K") {
      args.apiKey = argv[i + 1] || "";
      i += 1;
    } else if (a === "--model" || a === "-M") {
      args.model = argv[i + 1] || "";
      i += 1;
    } else if (a === "--base-url" || a === "-B") {
      args.baseUrl = argv[i + 1] || "";
      i += 1;
    } else if (a === "--disable-codex") {
      args.disableCodex = true;
    } else if (a === "--skill" || a === "-S") {
      args.skills.push(argv[i + 1] || "");
      i += 1;
    } else if (a === "--list-skills") {
      args.listSkills = true;
    } else if (a === "--tui") {
      args.tui = true;
    }
  }
  return args;
}

function extractMentionedSkills(input) {
  const text = String(input || "");
  const mentions = [...text.matchAll(/\$([A-Za-z0-9._-]+)/g)]
    .map((match) => match[1])
    .filter(Boolean);
  return [...new Set(mentions)];
}

async function autoEnableMentionedSkills(input, activeSkillsRef, skillIndex) {
  const mentioned = extractMentionedSkills(input);
  const enabled = [];
  const missing = [];

  for (const name of mentioned) {
    const result = await addSkillByName(activeSkillsRef.value, skillIndex, name);
    if (result.added) {
      activeSkillsRef.value = result.active;
      enabled.push(name);
    } else if (result.reason === "not-found") {
      missing.push(name);
    }
  }

  return { enabled, missing };
}

function createLogger(tui, display, getInput = () => "") {
  return (line) => {
    if (tui) {
      tui.event(line);
      tui.render(getInput());
      return;
    }
    if (display) {
      // Display handles its own rendering; suppress raw log output
      return;
    }
    console.log(line);
  };
}

function summarizeForLog(value, maxLen = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "<empty>";
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function estimateTokenCount(text) {
  const s = String(text || "");
  if (!s) return 0;
  // Heuristic: average ~4 chars/token for mixed code + English prompts.
  return Math.max(1, Math.round(s.length / 4));
}

function inferContextWindow(modelName) {
  const model = String(modelName || "").toLowerCase();
  if (!model) return 128000;
  if (model.includes("gpt-5")) return 256000;
  if (model.includes("gpt-4.1")) return 128000;
  if (model.includes("gpt-4o")) return 128000;
  if (model.includes("claude-3.7")) return 200000;
  if (model.includes("claude-3.5")) return 200000;
  if (model.includes("claude-3")) return 200000;
  if (model.includes("doubao-seed")) return 128000;
  if (model.includes("deepseek")) return 128000;
  return 128000;
}

async function waitForTuiApproval({ stdinStream, defaultYes }) {
  return new Promise((resolve) => {
    const handler = (_str, key = {}) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") {
        stdinStream.off("keypress", handler);
        resolve(Boolean(defaultYes));
        return;
      }
      if (key.name === "y") {
        stdinStream.off("keypress", handler);
        resolve(true);
        return;
      }
      if (key.name === "n") {
        stdinStream.off("keypress", handler);
        resolve(false);
      }
    };
    stdinStream.on("keypress", handler);
  });
}

function normalizeTodos(items) {
  const allowed = new Set(["pending", "in_progress", "completed"]);
  if (!Array.isArray(items)) return [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw || typeof raw !== "object") continue;
    const content = String(raw.content || "").trim();
    if (!content) continue;
    const status = allowed.has(String(raw.status || "").toLowerCase())
      ? String(raw.status).toLowerCase()
      : "pending";
    const id = String(raw.id || `todo-${i + 1}`);
    out.push({ id, content, status });
  }
  return out;
}

function seedTodosFromPlan(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps.map((s) => String(s || "").trim()).filter(Boolean) : [];
  if (steps.length === 0) return [];
  return steps.map((content, index) => ({
    id: `plan-${index + 1}`,
    content,
    status: index === 0 ? "in_progress" : "pending",
  }));
}

function advanceTodosOnToolStart(todos) {
  const next = normalizeTodos(todos);
  if (next.length === 0) return next;
  if (next.some((t) => t.status === "in_progress")) return next;
  const target = next.find((t) => t.status === "pending");
  if (target) target.status = "in_progress";
  return next;
}

function advanceTodosOnTurnDone(todos) {
  const next = normalizeTodos(todos);
  if (next.length === 0) return next;
  const current = next.find((t) => t.status === "in_progress");
  if (current) current.status = "completed";
  const pending = next.find((t) => t.status === "pending");
  if (pending) pending.status = "in_progress";
  return next;
}

function formatSkillLabel(activeSkillsRef) {
  const skills = activeSkillsRef.value.map((s) => s.name);
  return skills.length > 0 ? skills.join(",") : "none";
}

function printSkillList(skillIndex, logLine) {
  const skills = [...skillIndex.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) {
    logLine("no skills discovered");
    return;
  }
  for (const skill of skills) {
    logLine(`${skill.name}${skill.description ? ` - ${skill.description}` : ""}`);
  }
}

function createCompleter(getSkillIndex) {
  return (line) => {
    const input = String(line || "");
    const trimmed = input.trimStart();

    if (!trimmed.startsWith("/")) {
      return [[], line];
    }

    const skillIndex = typeof getSkillIndex === "function" ? getSkillIndex() : getSkillIndex;
    const skillNames = [...skillIndex.keys()].sort((a, b) => a.localeCompare(b));
    const tryComplete = (candidates, fragment) => {
      const hits = candidates.filter((item) => item.startsWith(fragment));
      return [hits.length ? hits : candidates, fragment];
    };

    if (/^\/skills\s+use(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/skills\s+use(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      return tryComplete(skillNames, fragment);
    }
    if (/^\/skills\s+off(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/skills\s+off(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      return tryComplete(skillNames, fragment);
    }
    if (/^\/use(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/use(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      return tryComplete(skillNames, fragment);
    }

    return tryComplete(SLASH_COMMANDS, trimmed);
  };
}

function getSuggestionsForInput(line, getSkillIndex) {
  const input = String(line || "");
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];

  const skillIndex = typeof getSkillIndex === "function" ? getSkillIndex() : getSkillIndex;
  const skillNames = [...skillIndex.keys()].sort((a, b) => a.localeCompare(b));

  const filterByPrefix = (candidates, fragment) => {
    const hits = candidates.filter((item) => item.startsWith(fragment));
    return hits.length > 0 ? hits : candidates;
  };

  if (/^\/skills\s+use(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/skills\s+use(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(skillNames, fragment);
  }
  if (/^\/skills\s+off(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/skills\s+off(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(skillNames, fragment);
  }
  if (/^\/use(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/use(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(skillNames, fragment);
  }

  return filterByPrefix(SLASH_COMMANDS, trimmed);
}

async function enableSkillByName(target, activeSkillsRef, skillIndex, logLine) {
  const result = await addSkillByName(activeSkillsRef.value, skillIndex, target);
  if (result.added) {
    activeSkillsRef.value = result.active;
    logLine(`enabled skill: ${target}`);
    return;
  }
  if (result.reason === "already-enabled") logLine(`skill already enabled: ${target}`);
  else if (result.reason === "not-found") logLine(`skill not found: ${target}`);
  else if (result.reason === "unreadable") logLine(`skill unreadable: ${target}`);
  else logLine("unable to enable skill");
}

function disableSkillByName(target, activeSkillsRef, logLine) {
  const result = removeSkillByName(activeSkillsRef.value, target);
  activeSkillsRef.value = result.active;
  logLine(result.removed ? `disabled skill: ${target}` : `skill not active: ${target}`);
}

async function maybeAutoEnableSkills(input, activeSkillsRef, skillIndex, logLine) {
  const mentionResult = await autoEnableMentionedSkills(input, activeSkillsRef, skillIndex);
  if (mentionResult.enabled.length > 0) {
    logLine(`auto-enabled skills: ${mentionResult.enabled.join(", ")}`);
  }
  if (mentionResult.missing.length > 0) {
    logLine(`mentioned skills not found: ${mentionResult.missing.join(", ")}`);
  }
}

async function runAgentTurn(agent, input, tui, logLine, display) {
  const startedAt = Date.now();
  try {
    const result = await agent.runTurn(input);
    if (tui) tui.onTurnSuccess(Date.now() - startedAt);
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (tui) {
      logLine(`[response] ${output}`);
      logLine(`[result] done in ${Date.now() - startedAt}ms`);
      tui.render("", "done");
    } else if (display) {
      display.onResponse(output);
    } else {
      console.log(`\n${output}`);
    }
  } catch (err) {
    if (tui) tui.onTurnError(err.message, Date.now() - startedAt);
    if (tui) {
      tui.event(`error: ${err.message}`);
      tui.render("", "error");
    } else if (display) {
      display.onError(err.message);
    } else {
      console.error(`error: ${err.message}`);
    }
  }
}

async function handleSlashCommand(input, ctx) {
  const {
    agent,
    autoApproveRef,
    provider,
    skillIndex,
    activeSkillsRef,
    logLine,
    rl,
    skillRoots,
    refreshSkillIndex,
    tui,
  } = ctx;

  const raw = String(input || "").trim();
  if (!raw.startsWith("/")) return { done: false, handled: false };
  const normalized = raw.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (lower === "/exit" || lower === "/quit") return { done: true, handled: true };
  if (lower === "/help") {
    if (tui) {
      const helpLines = [
        "commands:",
        "/help",
        "/exit | /quit",
        "/clear",
        "/approve on|off",
        "/model",
        "/skills",
        "/skills list",
        "/skills use <name>",
        "/skills off <name>",
        "/skills clear",
        "/use <name>",
        "/skill-creator",
      ];
      for (const line of helpLines) logLine(line);
    } else {
      printHelp();
    }
    return { done: false, handled: true };
  }
  if (lower === "/clear") {
    agent.clearHistory();
    logLine("history cleared");
    return { done: false, handled: true };
  }
  if (lower.startsWith("/approve")) {
    const mode = normalized.split(/\s+/)[1]?.toLowerCase();
    if (mode === "on" || mode === "off") {
      autoApproveRef.value = mode === "on";
      logLine(`shell auto-approval ${mode}`);
    } else {
      logLine("usage: /approve on|off");
    }
    return { done: false, handled: true };
  }
  if (lower === "/model") {
    logLine(`${provider.kind}:${provider.model}`);
    return { done: false, handled: true };
  }
  if (lower === "/skills") {
    const names = activeSkillsRef.value.map((skill) => skill.name);
    logLine(names.length > 0 ? `active skills: ${names.join(", ")}` : "active skills: none");
    return { done: false, handled: true };
  }
  if (lower === "/skills list") {
    printSkillList(skillIndex, logLine);
    return { done: false, handled: true };
  }
  if (lower === "/skills clear") {
    activeSkillsRef.value = [];
    logLine("all skills disabled");
    return { done: false, handled: true };
  }
  if (lower.startsWith("/use ")) {
    await enableSkillByName(normalized.slice("/use ".length).trim(), activeSkillsRef, skillIndex, logLine);
    return { done: false, handled: true };
  }
  if (lower.startsWith("/skills use ")) {
    await enableSkillByName(
      normalized.slice("/skills use ".length).trim(),
      activeSkillsRef,
      skillIndex,
      logLine
    );
    return { done: false, handled: true };
  }
  if (lower.startsWith("/skills off ")) {
    disableSkillByName(normalized.slice("/skills off ".length).trim(), activeSkillsRef, logLine);
    return { done: false, handled: true };
  }
  if (lower === "/skill-creator") {
    if (tui) tui.stop();
    const createdPath = await createSkillInteractive(rl, skillRoots);
    if (createdPath) {
      await refreshSkillIndex();
    }
    if (tui) {
      tui.start();
      logLine("skill index refreshed");
    }
    return { done: false, handled: true };
  }
  if (lower === "/workspace") {
    if (tui) tui.setRawLogsVisible(false);
    logLine("workspace timeline view");
    return { done: false, handled: true };
  }

  if (raw.startsWith("/")) {
    logLine(`unknown command: ${raw} (try /help)`);
    return { done: false, handled: true };
  }
  return { done: false, handled: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Handle --disable-codex option
  if (args.disableCodex) {
    process.env.PIECODE_DISABLE_CODEX_CLI = "1";
  }

  const settingsFile = getSettingsFilePath();
  const settings = await loadSettings(settingsFile);
  const skillRoots = resolveSkillRoots(settings);
  let skillIndex = await discoverSkills(skillRoots);
  const refreshSkillIndex = async () => {
    skillIndex = await discoverSkills(skillRoots);
  };
  const requestedSkills = resolveRequestedSkills(args.skills, settings);
  const { active: activeSkillsInitial, missing: missingSkills } = await loadActiveSkills(
    skillIndex,
    requestedSkills
  );
  const activeSkillsRef = { value: activeSkillsInitial };

  if (missingSkills.length > 0) {
    console.error(`warning: missing skills: ${missingSkills.join(", ")}`);
  }

  if (args.listSkills) {
    printSkillList(skillIndex, console.log);
    return;
  }

  const provider = getProvider(resolveProviderOptions(args, settings));
  const workspaceDir = process.cwd();
  const projectInstructionsRef = { value: await loadProjectInstructions(workspaceDir) };
  const autoApproveRef = { value: false };
  const historyFile = getHistoryFilePath();
  const initialHistory = await loadHistory(historyFile);
  const useTui = args.tui || process.env.PIECODE_TUI === "1";
  const display = useTui ? null : new Display();
  const llmDebugRef = { value: false };
  const currentInputRef = { value: "" };
  const todosRef = { value: [] };
  const readlineOutput = useTui ? createMutedTtyOutput(stdout) : stdout;

  const createReadline = (history = []) => {
    const next = createInterface({
      input: stdin,
      output: readlineOutput,
      terminal: true,
      historySize: HISTORY_MAX,
      removeHistoryDuplicates: true,
      completer: createCompleter(() => skillIndex),
    });
    next.history = Array.isArray(history) ? [...history] : [];
    return next;
  };
  let rl = createReadline(initialHistory);

  let tui = null;
  if (useTui) {
    tui = new SimpleTui({
      out: stdout,
      workspaceDir,
      providerLabel: () => `${provider.kind}:${provider.model}`,
      getSkillsLabel: () => formatSkillLabel(activeSkillsRef),
      getApprovalLabel: () => (autoApproveRef.value ? "on" : "off"),
    });
    tui.setLlmDebugEnabled(llmDebugRef.value);
    tui.setTodos(todosRef.value);
  }

  const logLine = createLogger(tui, display, () => currentInputRef.value);
  const exitArmedRef = { value: false };
  const approvalActiveRef = { value: false };
  let onKeypress = null;
  if (tui) {
    readlineCore.emitKeypressEvents(stdin);
    let lastSuggestionKey = "";
    onKeypress = (_str, key = {}) => {
      if (approvalActiveRef.value) return;
      const currentLine = String(rl.line || "");
      const emptyInput = currentLine.trim().length === 0;

      if (exitArmedRef.value && (!emptyInput || (key.name && key.name !== "d"))) {
        exitArmedRef.value = false;
      }

      if (key.ctrl && key.name === "o") {
        llmDebugRef.value = !llmDebugRef.value;
        tui.setLlmDebugEnabled(llmDebugRef.value);
        return;
      }
      if (key.ctrl && key.name === "l") {
        tui.toggleLogPanel();
        return;
      }
      if (key.ctrl && key.name === "t") {
        tui.toggleTodoPanel();
        return;
      }
      currentInputRef.value = currentLine;
      tui.renderInput(currentInputRef.value);
      if (!currentLine.trimStart().startsWith("/")) return;

      const shouldSuggestNow =
        currentLine.trim() === "/" || key.name === "tab";
      if (!shouldSuggestNow) return;

      const suggestions = getSuggestionsForInput(currentLine, () => skillIndex).slice(0, 8);
      if (suggestions.length === 0) return;
      const suggestionKey = `${currentLine}::${suggestions.join(",")}`;
      if (suggestionKey === lastSuggestionKey) return;
      lastSuggestionKey = suggestionKey;
      logLine(`[suggest] ${suggestions.join("  ")}`);
      if (key.name !== "tab") {
        tui.render(currentInputRef.value, "slash command suggestions");
      }
    };
    stdin.on("keypress", onKeypress);
  }

  const askApproval = async (q) => {
    let ans = "";
    const defaultYes = /\[Y\/n\]/.test(q);
    if (tui) {
      const compactPrompt = q.replace(/\s+/g, " ").trim();
      approvalActiveRef.value = true;
      tui.setApprovalPrompt(compactPrompt, defaultYes);
      const approved = await waitForTuiApproval({ stdinStream: stdin, defaultYes });
      approvalActiveRef.value = false;
      tui.clearApprovalPrompt();
      tui.event(`approval: ${approved ? "yes" : "no"}`);
      tui.render(currentInputRef.value, "approval handled");
      return approved;
    } else {
      ans = (await rl.question(q)).trim().toLowerCase();
      if (rl.history?.[0] === ans) rl.history.shift();
    }
    if (!ans && defaultYes) return true;
    return ans === "y" || ans === "yes";
  };

  const agent = new Agent({
    provider,
    workspaceDir,
    autoApproveRef,
    askApproval,
    activeSkillsRef,
    projectInstructionsRef,
    onTodoWrite: (nextTodos) => {
      todosRef.value = normalizeTodos(nextTodos);
      if (tui) tui.setTodos(todosRef.value);
      logLine(`updated todos: ${todosRef.value.length}`);
    },
    onEvent: (evt) => {
      if (evt.type === "model_call") {
        if (tui) tui.onModelCall(`${evt.provider}:${evt.model}`);
        logLine(`[model] ${evt.provider}:${evt.model}`);
      }
      if (evt.type === "planning_call") {
        if (tui) tui.onModelCall(`${evt.provider}:${evt.model}`);
        logLine(`[plan] creating plan`);
      }
      if (evt.type === "replanning_call") {
        if (tui) tui.onModelCall(`${evt.provider}:${evt.model}`);
        logLine(`[plan] revising plan`);
      }
      if (evt.type === "plan") {
        if (display) display.onPlan(evt.plan);
        const budget = evt.plan?.toolBudget ?? "-";
        const summary = evt.plan?.summary ? ` - ${evt.plan.summary}` : "";
        logLine(`[plan] budget=${budget}${summary}`);
        if (todosRef.value.length === 0) {
          const seeded = seedTodosFromPlan(evt.plan);
          if (seeded.length > 0) {
            todosRef.value = seeded;
            if (tui) tui.setTodos(todosRef.value);
            logLine(`seeded todos from plan: ${seeded.length}`);
          }
        }
      }
      if (evt.type === "replan") {
        if (display) display.onPlan(evt.plan);
        const budget = evt.plan?.toolBudget ?? "-";
        const summary = evt.plan?.summary ? ` - ${evt.plan.summary}` : "";
        logLine(`[plan] updated budget=${budget}${summary}`);
      }
      if (evt.type === "plan_progress") {
        logLine(`[plan] ${evt.message}`);
      }
      if (evt.type === "llm_request") {
        if (tui) tui.onThinking(evt.stage);
        if (display) display.onThinking(evt.stage);
        if (tui) {
          const used = estimateTokenCount(evt.payload);
          const limit = inferContextWindow(provider.model);
          tui.setContextUsage(used, limit);
        }
        logLine(`[thinking] request:${evt.stage} ${summarizeForLog(evt.payload)}`);
        if (tui && llmDebugRef.value) {
          tui.setLlmRequest(`[${evt.stage}] ${evt.payload}`);
        }
      }
      if (evt.type === "llm_response") {
        logLine(`[thinking] response:${evt.stage} ${summarizeForLog(evt.payload)}`);
        if (tui && llmDebugRef.value) {
          tui.setLlmResponse(`[${evt.stage}] ${evt.payload}`);
        }
      }
      if (evt.type === "thinking_done") {
        if (display) display.onThinkingDone();
      }
      if (evt.type === "thought") {
        if (display) display.onThought(evt.content);
        logLine(`[thinking] ${evt.content}`);
      }
      if (evt.type === "tool_use") {
        if (tui) tui.onToolUse(evt.tool);
        if (display) display.onToolUse(evt.tool, evt.input, evt.reason);
        const details = Object.entries(evt.input || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        logLine(`[tool] ${evt.tool}${evt.reason ? ` - ${evt.reason}` : ""}${details ? ` (${details})` : ""}`);
      }
      if (evt.type === "tool_start") {
        if (display) display.onToolStart(evt.tool, evt.input);
        const details = Object.entries(evt.input || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        logLine(`[run] ${evt.tool}${details ? ` ${details}` : ""}`);
        if (evt.tool !== "todo_write") {
          const advanced = advanceTodosOnToolStart(todosRef.value);
          if (advanced.length > 0) {
            todosRef.value = advanced;
            if (tui) tui.setTodos(todosRef.value);
          }
        }
      }
      if (evt.type === "tool_end") {
        if (display) display.onToolEnd(evt.tool, evt.result, evt.error);
      }
    },
  });

  if (args.prompt !== null) {
    const mentionResult = await autoEnableMentionedSkills(args.prompt, activeSkillsRef, skillIndex);
    if (mentionResult.enabled.length > 0) {
      console.log(`auto-enabled skills: ${mentionResult.enabled.join(", ")}`);
    }
    if (mentionResult.missing.length > 0) {
      console.error(`warning: mentioned skills not found: ${mentionResult.missing.join(", ")}`);
    }

    const result = await agent.runTurn(args.prompt);
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (display) {
      display.onResponse(output);
    } else {
      console.log(`\n${output}`);
    }
    await saveHistory(historyFile, rl.history);
    rl.close();
    return;
  }

  if (tui) {
    tui.start();
    tui.event(`ready in ${path.basename(workspaceDir)}`);
    if (projectInstructionsRef.value?.source) {
      tui.event(`loaded project instructions: ${projectInstructionsRef.value.source}`);
    }
    if (activeSkillsRef.value.length > 0) {
      tui.event(`skills: ${activeSkillsRef.value.map((s) => s.name).join(", ")}`);
    }
    tui.render(currentInputRef.value, "Type /help for commands");
  } else {
    console.log(`Piecode ready in ${path.basename(workspaceDir)} (${provider.kind}:${provider.model})`);
    if (projectInstructionsRef.value?.source) {
      console.log(`loaded project instructions: ${projectInstructionsRef.value.source}`);
    }
    if (activeSkillsRef.value.length > 0) {
      console.log(`skills: ${activeSkillsRef.value.map((s) => s.name).join(", ")}`);
    }
    console.log("Type /help for commands.");
  }

  while (true) {
    currentInputRef.value = "";
    if (tui) tui.render(currentInputRef.value, "waiting for input");
    let rawInput = "";
    try {
      rawInput = await rl.question(tui ? "" : "\n> ");
    } catch (err) {
      const message = String(err?.message || "");
      const isEof = message.includes("Ctrl+D") || message.includes("EOT");
      const isClosed = message.includes("readline was closed");
      const isInputAbort = isEof || isClosed;
      if (!isInputAbort) throw err;

      if (tui) {
        if (!exitArmedRef.value && String(rl.line || "").trim().length === 0) {
          exitArmedRef.value = true;
          logLine("Press CTRL+D again to exit.");
          const prevHistory = Array.isArray(rl.history) ? [...rl.history] : [];
          try {
            rl.close();
          } catch {
            // no-op
          }
          rl = createReadline(prevHistory);
          continue;
        }
        break;
      }
      break;
    }

    const input = rawInput.trim();
    if (!input) continue;
    exitArmedRef.value = false;
    const isSlash = input.startsWith("/");
    if (!isSlash) {
      logLine(`[task] ${input}`);
    }
    currentInputRef.value = "";
    if (tui) tui.render(currentInputRef.value, isSlash ? "handling command" : "processing task");

    const slash = await handleSlashCommand(input, {
      agent,
      autoApproveRef,
      provider,
      skillIndex,
      activeSkillsRef,
      logLine,
      rl,
      skillRoots,
      refreshSkillIndex,
      tui,
    });
    if (slash.done) break;
    if (slash.handled) {
      currentInputRef.value = "";
      continue;
    }

    await maybeAutoEnableSkills(input, activeSkillsRef, skillIndex, logLine);
    await runAgentTurn(agent, input, tui, logLine, display);
    const advancedAfterTurn = advanceTodosOnTurnDone(todosRef.value);
    if (advancedAfterTurn.length > 0) {
      todosRef.value = advancedAfterTurn;
      if (tui) tui.setTodos(todosRef.value);
    }
    currentInputRef.value = "";
  }

  try {
    await saveHistory(historyFile, rl.history);
  } finally {
    if (onKeypress) stdin.off("keypress", onKeypress);
    if (tui) tui.stop();
    rl.close();
  }
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});

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

const MODEL_SUGGESTIONS = [
  "seed:doubao-seed-code-preview-latest",
  "openrouter:moonshotai/kimi-k2.5",
  "openrouter:google/gemini-3-flash-preview",
  "openrouter:anthropic/claude-sonnet-4.5",
  "openrouter:deepseek/deepseek-v3.2",
  "openrouter:minimax/minimax-m2.1",
  "openrouter:anthropic/claude-opus-4.5",
  "openrouter:anthropic/claude-opus-4.6",
  "openrouter:z-ai/glm-4.7",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1",
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.7-sonnet",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.1-70b-instruct",
  "qwen/qwen-2.5-coder-32b-instruct",
  "deepseek/deepseek-chat",
  "doubao-seed-code-preview-latest",
  "gpt-5-codex",
];

const OPENROUTER_ALLOWED_MODELS = [
  "moonshotai/kimi-k2.5",
  "google/gemini-3-flash-preview",
  "anthropic/claude-sonnet-4.5",
  "deepseek/deepseek-v3.2",
  "minimax/minimax-m2.1",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-opus-4.6",
  "z-ai/glm-4.7",
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

async function saveSettings(filePath, settings) {
  const next = settings && typeof settings === "object" ? settings : {};
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function resolveProviderOptions(args, settings) {
  const provider = args.provider || settings.provider || null;
  const providerSettings = 
    provider && settings.providers && typeof settings.providers === "object"
      ? settings.providers[provider] || {}
      : {};

  const model = 
    args.model ||
    providerSettings.model ||
    settings.model ||
    null;

  const endpoint = 
    args.baseUrl ||
    providerSettings.endpoint ||
    providerSettings.baseUrl ||
    settings.endpoint ||
    settings.baseUrl ||
    null;

  const apiKey = 
    args.apiKey ||
    providerSettings.apiKey ||
    settings.apiKey ||
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
  const candidates = ["AGENTS.md"];
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
  --provider, -P       Model provider: anthropic, openai, openrouter, codex, seed
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

  OPENROUTER_API_KEY   OpenRouter API key (OpenAI-compatible)
  OPENROUTER_BASE_URL  Optional (default https://openrouter.ai/api/v1)
  OPENROUTER_MODEL     Optional (default openai/gpt-4.1-mini)
  OPENROUTER_SITE_URL  Optional Referer header for OpenRouter
  OPENROUTER_APP_NAME  Optional app title header for OpenRouter

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
  3) Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY)
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
  SHIFT+ENTER / CTRL+J Insert newline in prompt (TUI mode)

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

function shouldAutoTrackTodosFromPlan(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps.map((s) => String(s || "").trim()).filter(Boolean) : [];
  return steps.length >= 3;
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

function providerPrefix(kind) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("openrouter")) return "openrouter";
  if (k.includes("seed")) return "seed";
  if (k.includes("anthropic")) return "anthropic";
  if (k.includes("openai")) return "openai";
  if (k.includes("codex")) return "codex";
  return k || "model";
}

function formatProviderModel(provider) {
  const prefix = providerPrefix(provider?.kind);
  const model = String(provider?.model || "").trim() || "unknown";
  return `${prefix}/${model}`;
}

function emitStartupLogo(tui, provider, workspaceDir, terminalWidth = 100) {
  const width = Math.max(40, Number(terminalWidth) || 100);
  const center = (text) => {
    const raw = String(text || "");
    const clipped = raw.length > width ? raw.slice(0, Math.max(0, width - 3)) + "..." : raw;
    const left = Math.max(0, Math.floor((width - clipped.length) / 2));
    return `${" ".repeat(left)}${clipped}`;
  };
  const shortWorkspace = workspaceDir.length > 64 ? `...${workspaceDir.slice(-61)}` : workspaceDir;
  const logoLines = [
    `[banner-1] ${center("██████   ██  ███████")}`,
    `[banner-2] ${center("██   ██  ██  ██")}`,
    `[banner-3] ${center("██████   ██  █████")}`,
    `[banner-4] ${center("██       ██  ██")}`,
    `[banner-5] ${center("██       ██  ███████")}`,
    `[banner-meta] ${center(`model: ${formatProviderModel(provider)}`)}`,
    `[banner-meta] ${center(`workspace: ${shortWorkspace}`)}`,
    `[banner-hint] ${center("keys: CTRL+L logs | CTRL+O llm i/o | CTRL+T todos")}`,
  ];
  for (const line of logoLines) {
    tui.event(line);
  }
}

function createCompleter(getSkillIndex) {
  return (line, callback) => {
    const input = String(line || "");
    const trimmed = input.trimStart();

    if (!trimmed.startsWith("/")) {
      callback(null, [[], line]);
      return;
    }

    const skillIndex = typeof getSkillIndex === "function" ? getSkillIndex() : getSkillIndex;
    const skillNames = [...skillIndex.keys()].sort((a, b) => a.localeCompare(b));
    const tryComplete = (candidates, fragment) => {
      const hits = candidates.filter((item) => item.startsWith(fragment));
      callback(null, [hits.length ? hits : candidates, fragment]);
    };

    if (/^\/skills\s+use(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/skills\s+use(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(skillNames, fragment);
      return;
    }
    if (/^\/skills\s+off(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/skills\s+off(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(skillNames, fragment);
      return;
    }
    if (/^\/use(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/use(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(skillNames, fragment);
      return;
    }

    tryComplete(SLASH_COMMANDS, trimmed);
  };
}

function isMultilineShortcut(str, key = {}) {
  const name = String(key?.name || "").toLowerCase();
  if ((name === "return" || name === "enter") && key.shift) return true;
  // Common fallback for newline insertion in terminals.
  if (key.ctrl && name === "j") return true;
  // xterm/kitty-like modified Enter escape sequences.
  if (str === "\x1b[13;2u" || str === "\x1b[27;2;13~") return true;
  return false;
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

  if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
    const fragment = trimmed.replace(/^\/model\s*/i, "");
    const candidates = ["/model", "/model list", ...MODEL_SUGGESTIONS];
    if (!fragment) return candidates;
    return filterByPrefix(candidates, fragment);
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
    providerRef,
    skillIndex,
    activeSkillsRef,
    logLine,
    rl,
    skillRoots,
    refreshSkillIndex,
    tui,
    setModel,
    settings,
    modelCatalogRef,
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
    const p = providerRef.value;
    logLine(`active model: ${formatProviderModel(p)}`);
    logLine("usage: /model list | /model <model-id>");
    return { done: false, handled: true };
  }
  if (lower === "/model list") {
    const p = providerRef.value;
    logLine(`active model: ${formatProviderModel(p)}`);
    let listed = false;
    try {
      const groups = await fetchOpenRouterModelGroups({ settings });
      if (groups.popular.length > 0) {
        listed = true;
        logLine("popular (openrouter):");
        for (const id of groups.popular) logLine(`- openrouter:${id}`);
      }
      if (groups.latest.length > 0) {
        listed = true;
        logLine("latest (openrouter):");
        for (const id of groups.latest) logLine(`- openrouter:${id}`);
      }
      modelCatalogRef.value = mergeModelCatalog(MODEL_SUGGESTIONS, groups.popular, groups.latest);
    } catch {
      // keep static fallback catalog
    }
    if (!listed) {
      for (const modelId of modelCatalogRef.value) logLine(`- ${modelId}`);
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/model ")) {
    const targetModel = normalized.slice("/model ".length).trim();
    if (!targetModel || targetModel.toLowerCase() === "list") {
      logLine("usage: /model list | /model <model-id>");
      return { done: false, handled: true };
    }
    try {
      const nextProvider = await setModel(targetModel);
      logLine(`model switched: ${formatProviderModel(nextProvider)}`);
    } catch (err) {
      logLine(`unable to switch model: ${err.message}`);
      if (
        /openrouter/i.test(String(err?.message || "")) &&
        /api key/i.test(String(err?.message || ""))
      ) {
        logLine("hint: set OPENROUTER_API_KEY or add providers.openrouter.apiKey in ~/.piecode/settings.json");
      }
    }
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

function getModelQueryFromInput(line) {
  const raw = String(line || "").trimStart();
  if (!raw.startsWith("/model")) return null;
  const rest = raw.slice("/model".length).trim();
  if (!rest) return "";
  if (rest.toLowerCase() === "list") return null;
  return rest;
}

function getFilteredModelSuggestions(query, catalog = MODEL_SUGGESTIONS) {
  const source = Array.isArray(catalog) && catalog.length > 0 ? catalog : MODEL_SUGGESTIONS;
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [...source];
  const starts = source.filter((m) => m.toLowerCase().startsWith(q));
  const contains = source.filter((m) => !starts.includes(m) && m.toLowerCase().includes(q));
  return [...starts, ...contains];
}

async function fetchOpenRouterModelGroups({ settings }) {
  const providerSettings =
    settings?.providers && typeof settings.providers === "object"
      ? settings.providers.openrouter || {}
      : {};
  const apiKey = providerSettings.apiKey || process.env.OPENROUTER_API_KEY || "";
  const endpoint =
    providerSettings.endpoint ||
    providerSettings.baseUrl ||
    process.env.OPENROUTER_BASE_URL ||
    "https://openrouter.ai/api/v1";
  const base = String(endpoint || "").replace(/\/$/, "");
  const res = await fetch(`${base}/models`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`OpenRouter models request failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  const rows = Array.isArray(data?.data) ? data.data : [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    byId.set(id, { id, created: Number(row?.created) || 0 });
  }
  const popular = OPENROUTER_ALLOWED_MODELS.filter((id) => byId.has(id)).slice(0, 10);
  const latest = [];
  return { popular, latest };
}

function mergeModelCatalog(baseCatalog, popular, latest) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const id of popular || []) push(`openrouter:${id}`);
  for (const id of latest || []) push(`openrouter:${id}`);
  for (const id of baseCatalog || []) push(id);
  return out;
}

function parseModelTarget(target) {
  const raw = String(target || "").trim();
  const m = raw.match(/^(anthropic|openai|openrouter|codex|seed)\s*:\s*(.+)$/i);
  if (m) {
    return {
      provider: m[1].toLowerCase(),
      model: m[2].trim(),
    };
  }
  return { provider: "", model: raw };
}

function isAllowedOpenRouterModel(modelId) {
  const model = String(modelId || "").trim().toLowerCase();
  return OPENROUTER_ALLOWED_MODELS.some((m) => m.toLowerCase() === model);
}

function inferEndpointForProvider(providerOptions, provider) {
  const explicit =
    providerOptions?.endpoint ||
    providerOptions?.baseUrl ||
    null;
  if (explicit) return String(explicit);
  const kind = String(provider?.kind || "").toLowerCase();
  if (kind.includes("openrouter")) return "https://openrouter.ai/api/v1";
  if (kind.includes("seed")) return "https://ark.cn-beijing.volces.com/api/coding";
  if (kind.includes("openai") || kind.includes("codex")) return "https://api.openai.com/v1";
  if (kind.includes("anthropic")) return "https://api.anthropic.com/v1/messages";
  return "unknown";
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
  const modelCatalogRef = { value: [...MODEL_SUGGESTIONS] };
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

  const providerOptionsRef = { value: resolveProviderOptions(args, settings) };
  const providerRef = { value: getProvider(providerOptionsRef.value) };
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
  const todoAutoTrackRef = { value: false };
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
  let onResize = null;
  if (useTui) {
    tui = new SimpleTui({
      out: stdout,
      workspaceDir,
      providerLabel: () => formatProviderModel(providerRef.value),
      getSkillsLabel: () => formatSkillLabel(activeSkillsRef),
      getApprovalLabel: () => (autoApproveRef.value ? "on" : "off"),
    });
    tui.setLlmDebugEnabled(llmDebugRef.value);
    tui.setTodos(todosRef.value);
    onResize = () => {
      tui.render(currentInputRef.value);
    };
    stdout.on("resize", onResize);
    process.on("SIGWINCH", onResize);
  }

  const logLine = createLogger(tui, display, () => currentInputRef.value);
  const exitArmedRef = { value: false };
  const approvalActiveRef = { value: false };
  const multilineBufferRef = { value: "" };
  const multilineCommitRef = { value: false };
  const suppressNextSubmitRef = { value: false };
  const pendingCommandSubmitRef = { value: "" };
  const modelPickerRef = { active: false, query: "", options: [], index: 0 };
  const commandPickerRef = { active: false, options: [], index: 0 };
  let onKeypress = null;
  if (tui || display) {
    readlineCore.emitKeypressEvents(stdin);
    onKeypress = (str, key = {}) => {
      if (approvalActiveRef.value) return;
      const currentLine = String(rl.line || "");
      const emptyInput = currentLine.trim().length === 0 && !multilineBufferRef.value.trim();

      if (exitArmedRef.value && (!emptyInput || (key.name && key.name !== "d"))) {
        exitArmedRef.value = false;
        if (tui) tui.clearInputHint();
      }

      if (tui) {
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

        const pickerQuery = getModelQueryFromInput(currentLine);
        if (pickerQuery !== null) {
          const nextOptions = getFilteredModelSuggestions(pickerQuery, modelCatalogRef.value);
          if (nextOptions.length > 0) {
            modelPickerRef.active = true;
            commandPickerRef.active = false;
            commandPickerRef.options = [];
            commandPickerRef.index = 0;
            tui.clearCommandSuggestions();
            if (modelPickerRef.query !== pickerQuery) {
              modelPickerRef.query = pickerQuery;
              modelPickerRef.options = nextOptions;
              modelPickerRef.index = 0;
            } else {
              modelPickerRef.options = nextOptions;
              if (modelPickerRef.index >= modelPickerRef.options.length) modelPickerRef.index = 0;
            }
            tui.setModelSuggestions(modelPickerRef.options, modelPickerRef.index);
          } else {
            modelPickerRef.active = false;
            modelPickerRef.options = [];
            modelPickerRef.index = 0;
            tui.clearModelSuggestions();
          }
        } else {
          if (modelPickerRef.active) {
            modelPickerRef.active = false;
            modelPickerRef.query = "";
            modelPickerRef.options = [];
            modelPickerRef.index = 0;
            tui.clearModelSuggestions();
          }
          const trimmed = currentLine.trimStart();
          if (trimmed.startsWith("/")) {
            const commandOptions = getSuggestionsForInput(currentLine, () => skillIndex).slice(0, 8);
            if (commandOptions.length > 0) {
              commandPickerRef.active = true;
              commandPickerRef.options = commandOptions;
              if (commandPickerRef.index >= commandOptions.length) commandPickerRef.index = 0;
              tui.setCommandSuggestions(commandPickerRef.options, commandPickerRef.index);
            } else {
              commandPickerRef.active = false;
              commandPickerRef.options = [];
              commandPickerRef.index = 0;
              tui.clearCommandSuggestions();
            }
          } else if (commandPickerRef.active) {
            commandPickerRef.active = false;
            commandPickerRef.options = [];
            commandPickerRef.index = 0;
            tui.clearCommandSuggestions();
          }
        }

        if (modelPickerRef.active) {
          if (key.name === "tab") {
            const delta = key.shift ? -1 : 1;
            const len = modelPickerRef.options.length;
            modelPickerRef.index = (modelPickerRef.index + delta + len) % len;
            const selectedModel = modelPickerRef.options[modelPickerRef.index];
            const nextLine = `/model ${selectedModel}`;
            rl.write(null, { ctrl: true, name: "u" });
            rl.write(nextLine);
            currentInputRef.value = nextLine;
            tui.setModelSuggestions(modelPickerRef.options, modelPickerRef.index);
            tui.renderInput(currentInputRef.value);
            return;
          }
          if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            const len = modelPickerRef.options.length;
            modelPickerRef.index = (modelPickerRef.index + delta + len) % len;
            tui.setModelSuggestions(modelPickerRef.options, modelPickerRef.index);
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            const selectedModel = modelPickerRef.options[modelPickerRef.index];
            suppressNextSubmitRef.value = true;
            pendingCommandSubmitRef.value = `/model ${selectedModel}`;
            modelPickerRef.active = false;
            modelPickerRef.query = "";
            modelPickerRef.options = [];
            modelPickerRef.index = 0;
            tui.clearModelSuggestions();
            rl.write(null, { ctrl: true, name: "u" });
            rl.write(`/model ${selectedModel}`);
            currentInputRef.value = `/model ${selectedModel}`;
            tui.renderInput(currentInputRef.value);
            return;
          }
        }

        if (commandPickerRef.active) {
          if (key.name === "tab") {
            const delta = key.shift ? -1 : 1;
            const len = commandPickerRef.options.length;
            commandPickerRef.index = (commandPickerRef.index + delta + len) % len;
            const selectedCommand = commandPickerRef.options[commandPickerRef.index];
            rl.write(null, { ctrl: true, name: "u" });
            rl.write(selectedCommand);
            currentInputRef.value = selectedCommand;
            tui.setCommandSuggestions(commandPickerRef.options, commandPickerRef.index);
            tui.renderInput(currentInputRef.value);
            return;
          }
          if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            const len = commandPickerRef.options.length;
            commandPickerRef.index = (commandPickerRef.index + delta + len) % len;
            tui.setCommandSuggestions(commandPickerRef.options, commandPickerRef.index);
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            const selectedCommand = commandPickerRef.options[commandPickerRef.index];
            suppressNextSubmitRef.value = true;
            pendingCommandSubmitRef.value = selectedCommand;
            commandPickerRef.active = false;
            commandPickerRef.options = [];
            commandPickerRef.index = 0;
            tui.clearCommandSuggestions();
            rl.write(null, { ctrl: true, name: "u" });
            rl.write(selectedCommand);
            currentInputRef.value = selectedCommand;
            tui.renderInput(currentInputRef.value);
            return;
          }
        }

        if (isMultilineShortcut(str, key)) {
          multilineBufferRef.value = `${multilineBufferRef.value}${currentLine}\n`;
          multilineCommitRef.value = true;
          // Clear current readline line so Shift+Enter does not submit content.
          rl.write(null, { ctrl: true, name: "u" });
          currentInputRef.value = multilineBufferRef.value;
          tui.renderInput(currentInputRef.value);
          return;
        }

        currentInputRef.value = `${multilineBufferRef.value}${currentLine}`;
        tui.renderInput(currentInputRef.value);
      }

      if (tui) return;

      if (!currentLine.trimStart().startsWith("/")) {
        if (display) display.clearSuggestions();
        return;
      }

      const suggestions = getSuggestionsForInput(currentLine, () => skillIndex).slice(0, 8);
      if (suggestions.length === 0) {
        if (display) display.clearSuggestions();
        return;
      }
      if (display) {
        display.showSuggestions(suggestions);
      }
    };
    stdin.on("keypress", onKeypress);
  }

  const switchModel = async (modelId) => {
    const parsed = parseModelTarget(modelId);
    const selectedModel = parsed.model;
    if (!selectedModel) throw new Error("Model id is required");
    const seedConfigured =
      Boolean(settings?.providers?.seed?.apiKey) || Boolean(process.env.SEED_API_KEY) || Boolean(process.env.ARK_API_KEY);
    const seedConfiguredModel = String(settings?.providers?.seed?.model || "").trim();
    const looksLikeSeedModel =
      selectedModel.toLowerCase().includes("doubao-seed") ||
      (seedConfiguredModel && selectedModel === seedConfiguredModel);
    const openRouterConfigured =
      Boolean(process.env.OPENROUTER_API_KEY) ||
      Boolean(settings?.providers?.openrouter?.apiKey) ||
      Boolean(settings?.apiKey && String(settings?.provider || "").toLowerCase() === "openrouter");
    const inferredProvider =
      parsed.provider ||
      (
        looksLikeSeedModel &&
        providerOptionsRef.value.provider !== "seed" &&
        seedConfigured
      ? "seed"
      : ""
      ) ||
      (
        selectedModel.includes("/") &&
        providerOptionsRef.value.provider !== "openrouter" &&
        openRouterConfigured
      ? "openrouter"
      : "");
    const nextProviderName = inferredProvider || providerOptionsRef.value.provider || settings.provider || null;
    if (nextProviderName === "openrouter" && !isAllowedOpenRouterModel(selectedModel)) {
      throw new Error(
        `Unsupported OpenRouter model: ${selectedModel}. Allowed: ${OPENROUTER_ALLOWED_MODELS.join(", ")}`
      );
    }

    providerOptionsRef.value = {
      ...providerOptionsRef.value,
      provider: nextProviderName,
      model: selectedModel,
    };
    if (inferredProvider) {
      const providerSettings =
        settings?.providers && typeof settings.providers === "object"
          ? settings.providers[inferredProvider] || {}
          : {};
      providerOptionsRef.value.apiKey =
        providerSettings.apiKey ||
        (inferredProvider === "openrouter" ? process.env.OPENROUTER_API_KEY || null : providerOptionsRef.value.apiKey);
      providerOptionsRef.value.baseUrl = providerSettings.endpoint || providerSettings.baseUrl || providerOptionsRef.value.baseUrl || null;
      providerOptionsRef.value.endpoint = providerOptionsRef.value.baseUrl;
    }
    const nextProvider = getProvider(providerOptionsRef.value);
    providerRef.value = nextProvider;
    agent.provider = nextProvider;
    settings.model = selectedModel;
    if (nextProviderName) settings.provider = nextProviderName;
    try {
      await saveSettings(settingsFile, settings);
    } catch {
      // best effort
    }
    if (tui) tui.onModelCall(formatProviderModel(nextProvider));
    return nextProvider;
  };

  const askApproval = async (q) => {
    let ans = "";
    const defaultYes = false;
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
    provider: providerRef.value,
    workspaceDir,
    autoApproveRef,
    askApproval,
    activeSkillsRef,
    projectInstructionsRef,
    onTodoWrite: (nextTodos) => {
      todosRef.value = normalizeTodos(nextTodos);
      todoAutoTrackRef.value = false;
      if (tui) tui.setTodos(todosRef.value);
      logLine(`updated todos: ${todosRef.value.length}`);
    },
    onEvent: (evt) => {
      if (evt.type === "model_call") {
        const label = formatProviderModel({ kind: evt.provider, model: evt.model });
        if (tui) tui.onModelCall(label);
        logLine(`[model] ${label}`);
      }
      if (evt.type === "planning_call") {
        if (tui) tui.onModelCall(formatProviderModel({ kind: evt.provider, model: evt.model }));
        logLine(`[plan] creating plan`);
      }
      if (evt.type === "replanning_call") {
        if (tui) tui.onModelCall(formatProviderModel({ kind: evt.provider, model: evt.model }));
        logLine(`[plan] revising plan`);
      }
      if (evt.type === "plan") {
        if (display) display.onPlan(evt.plan);
        const budget = evt.plan?.toolBudget ?? "-";
        const summary = evt.plan?.summary ? ` - ${evt.plan.summary}` : "";
        logLine(`[plan] budget=${budget}${summary}`);
        if (todosRef.value.length === 0 && shouldAutoTrackTodosFromPlan(evt.plan)) {
          const seeded = seedTodosFromPlan(evt.plan);
          if (seeded.length > 0) {
            todosRef.value = seeded;
            todoAutoTrackRef.value = true;
            if (tui) tui.setTodos(todosRef.value);
            logLine(`seeded todos from plan: ${seeded.length}`);
          }
        } else {
          todoAutoTrackRef.value = false;
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
        const endpoint = inferEndpointForProvider(providerOptionsRef.value, providerRef.value);
        if (tui) {
          const used = estimateTokenCount(evt.payload);
          const limit = inferContextWindow(providerRef.value.model);
          tui.setContextUsage(used, limit);
        }
        logLine(`[thinking] request:${evt.stage} endpoint:${endpoint} ${summarizeForLog(evt.payload)}`);
        if (tui && llmDebugRef.value) {
          tui.setLlmRequest(`[${evt.stage}] endpoint=${endpoint}\n${evt.payload}`);
        }
      }
      if (evt.type === "llm_response") {
        logLine(`[thinking] response:${evt.stage} ${summarizeForLog(evt.payload)}`);
        if (tui && llmDebugRef.value) {
          tui.setLlmResponse(`[${evt.stage}] ${evt.payload}`);
        }
      }
      if (evt.type === "thinking_done") {
        if (tui) tui.onThinkingDone();
        if (display) display.onThinkingDone();
      }
      if (evt.type === "thought") {
        if (display) display.onThought(evt.content);
        logLine(`[thought] ${evt.content}`);
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
        if (todoAutoTrackRef.value && evt.tool !== "todo_write" && evt.tool !== "todowrite") {
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
    emitStartupLogo(tui, providerRef.value, workspaceDir, stdout.columns || 100);
    if (projectInstructionsRef.value?.source) {
      tui.event(`loaded project instructions: ${projectInstructionsRef.value.source}`);
    }
    if (activeSkillsRef.value.length > 0) {
      tui.event(`skills: ${activeSkillsRef.value.map((s) => s.name).join(", ")}`);
    }
    tui.render(currentInputRef.value, "Type /help for commands");
  } else {
    console.log(`Piecode (${formatProviderModel(providerRef.value)})`);
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
        if (!exitArmedRef.value && String(rl.line || "").trim().length === 0 && !multilineBufferRef.value.trim()) {
          exitArmedRef.value = true;
          tui.setInputHint("Press CTRL+D again to exit.");
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

    if (suppressNextSubmitRef.value) {
      suppressNextSubmitRef.value = false;
      if (pendingCommandSubmitRef.value) {
        rawInput = pendingCommandSubmitRef.value;
        pendingCommandSubmitRef.value = "";
      } else {
        currentInputRef.value = "";
        continue;
      }
    }

    if (multilineCommitRef.value) {
      multilineCommitRef.value = false;
      currentInputRef.value = multilineBufferRef.value;
      if (tui) tui.renderInput(currentInputRef.value);
      continue;
    }

    const combinedInput = `${multilineBufferRef.value}${rawInput}`;
    multilineBufferRef.value = "";
    const finalInput = combinedInput.trim();
    if (!finalInput) continue;
    if (display) display.clearSuggestions();
    exitArmedRef.value = false;
    if (tui) tui.clearInputHint();
    const isSlash = finalInput.startsWith("/");
    if (!isSlash) {
      logLine(`[task] ${finalInput}`);
    }
    currentInputRef.value = "";
    if (tui) tui.render(currentInputRef.value, isSlash ? "handling command" : "processing task");

    const slash = await handleSlashCommand(finalInput, {
      agent,
      autoApproveRef,
      providerRef,
      skillIndex,
      activeSkillsRef,
      logLine,
      rl,
      skillRoots,
      refreshSkillIndex,
      tui,
      setModel: switchModel,
      settings,
      modelCatalogRef,
    });
    if (slash.done) break;
    if (slash.handled) {
      if (display) display.clearSuggestions();
      currentInputRef.value = "";
      continue;
    }

    await maybeAutoEnableSkills(finalInput, activeSkillsRef, skillIndex, logLine);
    await runAgentTurn(agent, finalInput, tui, logLine, display);
    if (todoAutoTrackRef.value) {
      const advancedAfterTurn = advanceTodosOnTurnDone(todosRef.value);
      if (advancedAfterTurn.length > 0) {
        todosRef.value = advancedAfterTurn;
        if (tui) tui.setTodos(todosRef.value);
      }
    }
    currentInputRef.value = "";
  }

  try {
    await saveHistory(historyFile, rl.history);
  } finally {
    if (onKeypress) stdin.off("keypress", onKeypress);
    if (onResize) {
      stdout.off("resize", onResize);
      process.off("SIGWINCH", onResize);
    }
    if (tui) tui.stop();
    rl.close();
  }
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});

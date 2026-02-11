#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import * as readlineCore from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable, Transform } from "node:stream";
import { stdin, stdout } from "node:process";
import { Agent } from "./lib/agent.js";
import { getProvider } from "./lib/providers.js";
import {
  addSkillByName,
  autoEnableSkills,
  autoLoadSkillsFromInstructions,
  discoverSkills,
  loadActiveSkills,
  removeSkillByName,
  resolveRequestedSkills,
  resolveSkillRoots,
} from "./lib/skills.js";
import { createSkillInteractive } from "./lib/skillCreator.js";
import { SimpleTui } from "./lib/tui.js";
import { Display } from "./lib/display.js";
import { consumeMouseWheelDeltas, stripMouseInputNoise } from "./lib/mouse.js";
import { TuiLineEditor } from "./lib/tuiLineEditor.js";

const HISTORY_MAX = 500;
const execAsync = promisify(execCb);
const DIRECT_SHELL_MAX_OUTPUT = 12000;
const SLASH_COMMANDS = [
  "/help",
  "/exit",
  "/quit",
  "/clear",
  "/compact",
  "/approve",
  "/trace",
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
  "codex:gpt-5.3-codex",
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
  "gpt-5.3-codex",
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
    settings.model ||
    providerSettings.model ||
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

function makeSessionId() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `session-${stamp}`;
}

function clipText(value, max = 12000) {
  const text = String(value || "");
  const cap = Math.max(200, Number(max) || 12000);
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[clipped ${text.length - cap} chars]`;
}

async function ensureSessionStoreDir(workspaceDir, sessionId) {
  const root = path.join(workspaceDir, ".piecode", "sessions", sessionId);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function startTaskTrace(taskTraceRef, { input, kind }) {
  taskTraceRef.seq += 1;
  const id = `turn-${String(taskTraceRef.seq).padStart(3, "0")}`;
  const nowIso = new Date().toISOString();
  taskTraceRef.current = {
    id,
    kind: String(kind || "task"),
    input: String(input || ""),
    startedAt: nowIso,
    finishedAt: "",
    durationMs: 0,
    status: "running",
    error: "",
    logs: [],
    events: [],
  };
  return id;
}

function recordTaskLog(taskTraceRef, line) {
  if (!taskTraceRef?.current) return;
  taskTraceRef.current.logs.push({
    at: new Date().toISOString(),
    line: String(line || ""),
  });
}

function recordTaskEvent(taskTraceRef, evt) {
  if (!taskTraceRef?.current || !evt || typeof evt !== "object") return;
  const e = { ...evt };
  if (typeof e.payload === "string") e.payload = clipText(e.payload, 16000);
  if (typeof e.delta === "string") e.delta = clipText(e.delta, 4000);
  if (typeof e.content === "string") e.content = clipText(e.content, 8000);
  taskTraceRef.current.events.push({
    at: new Date().toISOString(),
    event: e,
  });
}

async function finishTaskTrace(taskTraceRef, workspaceDir, { status = "done", error = "" } = {}) {
  const current = taskTraceRef?.current;
  if (!current) return null;
  current.finishedAt = new Date().toISOString();
  const startedMs = Date.parse(current.startedAt);
  const finishedMs = Date.parse(current.finishedAt);
  current.durationMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : 0;
  current.status = String(status || "done");
  current.error = String(error || "");

  try {
    const sessionDir =
      taskTraceRef.sessionDir ||
      (await ensureSessionStoreDir(workspaceDir, taskTraceRef.sessionId));
    taskTraceRef.sessionDir = sessionDir;
    const trajectoryPath = path.join(sessionDir, "trajectory.jsonl");
    const logsPath = path.join(sessionDir, "logs.log");
    const logsText = current.logs.map((entry) => `[${entry.at}] ${entry.line}`).join("\n");
    await fs.appendFile(trajectoryPath, `${JSON.stringify(current)}\n`, "utf8");
    if (logsText) {
      await fs.appendFile(logsPath, `\n[${current.id}] ${current.input}\n${logsText}\n`, "utf8");
    }
    taskTraceRef.current = null;
    return {
      id: current.id,
      sessionId: taskTraceRef.sessionId,
      dir: sessionDir,
      trajectoryPath,
      logsPath,
    };
  } catch {
    taskTraceRef.current = null;
    return null;
  }
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
  console.log(`Pie Code - Coding agent

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
  CODEX_MODEL          Optional for codex token mode (default gpt-5.3-codex)
  PIECODE_DISABLE_CODEX_CLI Optional (set 1 to disable codex CLI session backend)
  PIECODE_ENABLE_PLANNER  Optional (set 1 to enable experimental task planner)
  PIECODE_PLAN_FIRST      Optional (default off; set 1 to enable lightweight pre-plan)
  PIECODE_TOOL_BUDGET     Optional (default 6, range 1-12)
  PIECODE_VERBOSE_TOOL_LOGS Optional (set 1 for full tool input details in logs)
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
  /clear               Clear all turn context (history + todos)
  /compact             Compact older context and keep recent turns
  /approve on|off      Toggle shell auto-approval
  /trace on|off        Toggle runtime trace logs (timings/stages)
  /model               Show active provider/model
                       Tip: use /model codex:gpt-5.3-codex to force Codex provider
  /skills              Show active skills
  /skills list         List discovered skills
  /skills use <name>   Enable a skill
  /skills off <name>   Disable a skill
  /skills clear        Disable all skills
  /use <name>          Alias for /skills use <name>
  /skill-creator       Interactive skill creation tool
  /workspace           Return to workspace timeline view
  CTRL+D               Press twice on empty input to exit (TUI mode)
  CTRL+C               Clear current input (TUI mode)
  UP/DOWN              Scroll timeline when input is empty (TUI mode)
  SHIFT+UP/DOWN        Scroll timeline line-by-line (TUI mode)
  PAGEUP/PAGEDOWN      Scroll timeline by page (TUI mode)
  HOME/END             Jump to oldest/newest timeline content (TUI mode)
  CTRL+L               Toggle event log panel (TUI mode)
  CTRL+T               Toggle TODO panel (TUI mode)
  CTRL+O               Toggle LLM request/response debug panel (TUI mode)
  CTRL+A / CTRL+E      Move cursor to start/end of input (TUI mode)
  ESC (twice)          Abort current running task (TUI mode)
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

let neoBlessedProbe = null;
async function hasNeoBlessedInstalled() {
  if (neoBlessedProbe !== null) return neoBlessedProbe;
  try {
    await import("neo-blessed");
    neoBlessedProbe = true;
  } catch {
    neoBlessedProbe = false;
  }
  return neoBlessedProbe;
}

async function createNeoBlessedKeypressSource({ input, output }) {
  const loaded = await import("neo-blessed");
  const blessed = loaded?.default || loaded;
  const programFactory =
    (blessed && typeof blessed.program === "function" && blessed.program) ||
    (loaded && typeof loaded.program === "function" && loaded.program) ||
    null;
  if (!programFactory) {
    return { source: input, destroy: () => {}, blessed: null, program: null };
  }
  const rawTerm = String(process.env.TERM || "").toLowerCase();
  const terminal = rawTerm.includes("ghostty") ? "xterm-256color" : (process.env.TERM || "xterm-256color");
  const program = programFactory({
    input,
    output,
    terminal,
  });
  return {
    source: program || input,
    blessed,
    program,
    destroy: () => {
      try {
        if (program && typeof program.destroy === "function") program.destroy();
      } catch {
        // best effort
      }
    },
  };
}

function createLogger(tui, display, getInput = () => "", onLogLine = null) {
  return (line) => {
    if (typeof onLogLine === "function") onLogLine(line);
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

function formatToolInputSummary(tool, input, maxLen = 120) {
  const safe = input && typeof input === "object" ? input : {};
  if (tool === "shell") {
    return summarizeForLog(safe.command || "", maxLen);
  }
  if (tool === "read_file" || tool === "write_file") {
    return summarizeForLog(safe.path || "", maxLen);
  }
  if (tool === "list_files") {
    return summarizeForLog(safe.path || ".", maxLen);
  }
  if (tool === "todo_write" || tool === "todowrite") {
    const count = Array.isArray(safe.todos) ? safe.todos.length : 0;
    return `${count} todos`;
  }
  return summarizeForLog(JSON.stringify(safe), maxLen);
}

function estimateTokenCount(text) {
  const s = String(text || "");
  if (!s) return 0;
  // Heuristic: average ~4 chars/token for mixed code + English prompts.
  return Math.max(1, Math.round(s.length / 4));
}

function formatReadableDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSec = Math.round(value / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hour}h ${remMin}m` : `${hour}h`;
}

function formatDirectShellOutput(stdoutText, stderrText) {
  const out = String(stdoutText || "").trimEnd();
  const err = String(stderrText || "").trimEnd();
  if (!out && !err) return "";
  const joined = [out, err].filter(Boolean).join("\n");
  if (joined.length <= DIRECT_SHELL_MAX_OUTPUT) return joined;
  const trimmed = joined.slice(0, Math.max(0, DIRECT_SHELL_MAX_OUTPUT - 3));
  return `${trimmed}...`;
}

async function runDirectShellCommand(command, { workspaceDir, logLine, tui, display } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) {
    logLine("usage: ! <shell command>");
    return { ok: false, error: "missing-command" };
  }

  const startedAt = Date.now();
  if (tui) tui.onThinkingDone();
  logLine(`[run] shell ${cmd}`);
  if (display) display.onToolStart("shell", { command: cmd });
  if (tui) tui.onToolUse("shell");

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    const preview = formatDirectShellOutput(stdout, stderr);
    if (preview) logLine(`[response] ${preview}`);
    const durationMs = Date.now() - startedAt;
    logLine(`[result] shell done | time: ${formatReadableDuration(durationMs)}`);
    if (tui) tui.onThinkingDone();
    if (display) display.onToolEnd("shell", preview || "<empty>", null);
    return { ok: true };
  } catch (err) {
    const stdout = String(err?.stdout || "");
    const stderr = String(err?.stderr || "");
    const preview = formatDirectShellOutput(stdout, stderr);
    if (preview) logLine(`[response] ${preview}`);
    const durationMs = Date.now() - startedAt;
    logLine(`[result] shell failed | time: ${formatReadableDuration(durationMs)}`);
    if (tui) tui.onThinkingDone();
    if (display) display.onToolEnd("shell", preview || "<empty>", String(err?.message || "shell command failed"));
    return { ok: false, error: String(err?.message || "shell command failed") };
  }
}

function maybeHandleLocalInfoTask(input, { logLine, tui, display } = {}) {
  const text = String(input || "").trim().toLowerCase();
  const askTools =
    /^(what|which)\s+tools?\s+(do\s+you\s+have|are\s+available)/i.test(text) ||
    /^(list|show)\s+(your\s+)?tools?$/i.test(text) ||
    /^tools?$/i.test(text);
  if (!askTools) return { handled: false };

  const lines = [
    "## Available Tools",
    "- `shell`: Run a shell command in the workspace",
    "- `read_file`: Read a file",
    "- `write_file`: Write a file",
    "- `list_files`: List files/directories",
    "- `search_files`: Search file contents (ripgrep/grep/native)",
    "- `todo_write` / `todowrite`: Update task todo list",
  ];
  const message = lines.join("\n");
  logLine(`[response] ${message}`);
  logLine("[result] done | time: 0ms | tok ↑0 ↓0");
  if (tui) tui.render("", "done");
  if (display) display.onResponse(message);
  return { handled: true };
}

function extractThoughtContentFromPartialJson(raw) {
  const source = String(raw || "");
  const hasThoughtType =
    /"type"\s*:\s*"thought/i.test(source) || /"type"\s*:\s*"tho/i.test(source);
  if (!hasThoughtType) return null;

  const contentKey = source.search(/"content"\s*:\s*"/i);
  if (contentKey < 0) return "";
  let i = contentKey;
  while (i < source.length && source[i] !== ":") i += 1;
  if (i >= source.length) return "";
  i += 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== "\"") return "";
  i += 1;

  let out = "";
  let escaped = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      if (ch === "n") out += "\n";
      else if (ch === "t") out += "\t";
      else out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") break;
    out += ch;
  }
  return out.trim();
}

function extractReadableThinkingPreview(raw) {
  const source = String(raw || "");
  const thought = extractThoughtContentFromPartialJson(source);
  if (thought) return thought;

  const compact = source.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  const reasonMatch = compact.match(
    /"(reason|analysis|summary|thought|rationale)"\s*:\s*"((?:[^"\\]|\\.)*)"/i
  );
  if (reasonMatch?.[2]) {
    return reasonMatch[2]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .trim();
  }

  const toolMatch = compact.match(/"tool"\s*:\s*"([^"\\]+)"/i);
  if (toolMatch?.[1]) {
    return `Preparing tool: ${toolMatch[1]}`;
  }

  // If output is raw JSON/tool schema and we cannot extract a readable field yet, avoid noise.
  if (compact.startsWith("{") || compact.startsWith("[")) return "";

  return compact;
}

function extractJsonObject(raw) {
  const source = String(raw || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function extractThinkingFromFinalModelPayload(raw) {
  const objText = extractJsonObject(raw);
  if (!objText) return "";
  try {
    const parsed = JSON.parse(objText);
    if (String(parsed?.type || "").toLowerCase() === "thought") {
      return String(parsed?.content || "").trim();
    }
    if (String(parsed?.type || "").toLowerCase() === "tool_use") {
      const reason = String(parsed?.reason || "").trim();
      if (reason) return reason;
      const tool = String(parsed?.tool || "").trim();
      if (tool) return `Preparing to use tool: ${tool}`;
    }
  } catch {
    // ignore parse failures
  }
  return "";
}

function formatCompactNumber(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const v = (value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1);
    return `${v.replace(/\.0$/, "")}m`;
  }
  if (abs >= 1_000) {
    const v = (value / 1_000).toFixed(abs >= 10_000 ? 0 : 1);
    return `${v.replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
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

function isTaskAbortError(err) {
  const message = String(err?.message || "");
  return (
    err?.code === "TASK_ABORTED" ||
    err?.code === "ABORT_ERR" ||
    err?.name === "AbortError" ||
    /task aborted by user/i.test(message)
  );
}

function getGitChangedFileSet(workspaceDir) {
  try {
    const out = spawnSync("git", ["status", "--porcelain"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 5000,
    });
    if (out.status !== 0) return null;
    const files = new Set();
    for (const raw of String(out.stdout || "").split("\n")) {
      const line = raw.trimEnd();
      if (!line) continue;
      const body = line.slice(3).trim();
      if (!body) continue;
      const renamed = body.split(" -> ");
      files.add((renamed[renamed.length - 1] || body).trim());
    }
    return files;
  } catch {
    return null;
  }
}

function parseNumstatOutput(raw, targetMap) {
  const map = targetMap || new Map();
  for (const lineRaw of String(raw || "").split("\n")) {
    const line = lineRaw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addRaw = parts[0];
    const delRaw = parts[1];
    const fileRaw = parts.slice(2).join("\t").trim();
    const file = fileRaw.split(" -> ").pop().trim();
    const add = Number.isFinite(Number(addRaw)) ? Number(addRaw) : 0;
    const del = Number.isFinite(Number(delRaw)) ? Number(delRaw) : 0;
    const prev = map.get(file) || { add: 0, del: 0 };
    map.set(file, { add: prev.add + add, del: prev.del + del });
  }
  return map;
}

function getGitNumstatMap(workspaceDir) {
  try {
    const map = new Map();
    const unstaged = spawnSync("git", ["diff", "--numstat"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 5000,
    });
    if (unstaged.status === 0) parseNumstatOutput(unstaged.stdout, map);

    const staged = spawnSync("git", ["diff", "--cached", "--numstat"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 5000,
    });
    if (staged.status === 0) parseNumstatOutput(staged.stdout, map);
    return map;
  } catch {
    return null;
  }
}

function diffGitNumstat(beforeMap, afterMap) {
  const out = [];
  if (!(beforeMap instanceof Map) || !(afterMap instanceof Map)) return out;
  const files = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const file of files) {
    const before = beforeMap.get(file) || { add: 0, del: 0 };
    const after = afterMap.get(file) || { add: 0, del: 0 };
    const add = Math.max(0, after.add - before.add);
    const del = Math.max(0, after.del - before.del);
    if (add > 0 || del > 0) out.push({ file, add, del });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

function formatToolCounts(tools) {
  const counts = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    const key = String(t || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, n]) => `${k} x${n}`)
    .join(", ");
}

function buildTurnSummary({ tools = [], filesChanged = [], fileStats = [], useColor = false } = {}) {
  const toolText = formatToolCounts(tools) || "none";
  const files = Array.isArray(filesChanged)
    ? filesChanged.map((f) => String(f || "").trim()).filter(Boolean)
    : [];
  const filesText = files.length > 0 ? files.join(", ") : "none";
  const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
  const statsLines = Array.isArray(fileStats)
    ? fileStats.map((s) => {
        const file = String(s?.file || "").trim();
        if (!file) return null;
        const add = Number(s?.add || 0);
        const del = Number(s?.del || 0);
        return `  - ${file} ${green(`+${add}`)} ${red(`-${del}`)}`;
      }).filter(Boolean)
    : [];
  return [
    "Summary:",
    `- Actions: ${toolText}`,
    `- Files changed: ${filesText}`,
    ...(statsLines.length > 0 ? ["- Diff stat:", ...statsLines] : []),
  ].join("\n");
}

function shouldShowTurnSummary({ tools = [], filesChanged = [] } = {}) {
  const files = Array.isArray(filesChanged)
    ? filesChanged.map((f) => String(f || "").trim()).filter(Boolean)
    : [];
  if (files.length > 0) return true;

  const list = Array.isArray(tools) ? tools.map((t) => String(t || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return false;

  // Show summary only for materially active turns.
  const significantTools = new Set(["write_file", "shell", "todo_write", "todowrite"]);
  if (list.some((t) => significantTools.has(t))) return true;
  if (list.length >= 3) return true;

  return false;
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
  logLine("## Skills");
  for (const skill of skills) {
    logLine(`- **${skill.name}**${skill.description ? `: ${skill.description}` : ""}`);
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
    `[banner-title-inline] ${center(" Pie Code  simple like pie")}`,
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

/**
 * Regex matching terminal escape sequences that encode Shift+Enter / modified Enter.
 * These are not understood by Node's readline emitKeypressEvents and would leak as
 * literal text (e.g. "13~") into the input buffer.
 *
 * We replace them with a private sentinel control char and handle that sentinel inside
 * isMultilineShortcut(). This avoids translating modified enter to plain "\n", which
 * can be interpreted as submit by readline in some terminals.
 *
 * Matched sequences:
 *   \x1b[13;2u        – CSI u  (Shift+Enter, xterm/foot/WezTerm)
 *   \x1b[13;Nu        – CSI u  with any modifier mask
 *   \x1b[13;N~        – CSI ~  variant used by some terminal stacks
 *   \x1b[27;2;13~     – xterm modifyOtherKeys (Shift+Enter)
 *   \x1b[27;N;13~     – xterm modifyOtherKeys with any modifier
 *   \x1b[13u          – kitty keyboard protocol (bare Enter, fixup layout)
 */
const MULTILINE_ENTER_SENTINEL = "\x1f";
const MODIFIED_ENTER_RE = /\x1b\[13(?:;\d+)?[u~]|\x1b\[27;\d+;13~/g;

function createStdinFilter() {
  let buf = "";
  let flushTimer = null;
  const self = new Transform({
    decodeStrings: false,
    transform(chunk, _enc, cb) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      // If buffer ends mid-escape, hold bytes until next chunk (up to a short limit).
      if (buf.includes("\x1b") && buf.length < 32 && /\x1b(?:\[[\d;]*)?$/.test(buf)) {
        // Flush after a short timeout so a lone ESC keypress isn't delayed forever.
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (buf) {
            const out = buf.replace(MODIFIED_ENTER_RE, MULTILINE_ENTER_SENTINEL);
            buf = "";
            self.push(out);
          }
        }, 50);
        cb();
        return;
      }
      const out = buf.replace(MODIFIED_ENTER_RE, MULTILINE_ENTER_SENTINEL);
      buf = "";
      cb(null, out);
    },
    flush(cb) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (buf) {
        cb(null, buf.replace(MODIFIED_ENTER_RE, MULTILINE_ENTER_SENTINEL));
        buf = "";
      } else {
        cb();
      }
    },
  });
  return self;
}

function isMultilineShortcut(str, key = {}) {
  const name = String(key?.name || "").toLowerCase();
  if (str === MULTILINE_ENTER_SENTINEL) return true;
  if (str === "↩" || str === "↵") return true;
  // Alt+Enter / Option+Enter (meta modifier).
  if ((name === "return" || name === "enter") && key.meta && str !== "\r" && str !== "\n") return true;
  // Some terminals can set shift=true on plain Enter; don't treat that as multiline.
  if ((name === "return" || name === "enter") && key.shift && str !== "\r" && str !== "\n") return true;
  // Common fallback for newline insertion in terminals.
  if (key.ctrl && name === "j") return true;
  // xterm/kitty-like modified Enter escape sequences (CSI u and xterm modifyOtherKeys).
  if (str === "\x1b[13;2u" || str === "\x1b[27;2;13~") return true;
  // Kitty keyboard protocol variants.
  if (str === "\x1b[13u") return true;
  // Raw escape + CR/LF from terminals that don't parse modifiers.
  if (str === "\x1b\r" || str === "\x1b\n") return true;
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
  const result = await autoEnableSkills(input, activeSkillsRef, skillIndex);
  if (result.enabled.length > 0) {
    const sections = [];
    if (result.byTrigger.length > 0) sections.push(`trigger: ${result.byTrigger.join(", ")}`);
    if (result.byMention.length > 0) sections.push(`mention: ${result.byMention.join(", ")}`);
    const details = sections.length > 0 ? ` (${sections.join(" | ")})` : "";
    logLine(`auto-enabled skills: ${result.enabled.join(", ")}${details}`);
  }
}

async function runAgentTurn(agent, input, tui, logLine, display, turnSummaryRef, workspaceDir) {
  const startedAt = Date.now();
  if (tui) tui.beginTurn();
  const beforeGitSet = getGitChangedFileSet(workspaceDir);
  const beforeGitNumstat = getGitNumstatMap(workspaceDir);
  if (turnSummaryRef?.value) {
    turnSummaryRef.value.active = true;
    turnSummaryRef.value.tools = [];
    turnSummaryRef.value.filesChanged = new Set();
    turnSummaryRef.value.beforeGitSet = beforeGitSet;
    turnSummaryRef.value.beforeGitNumstat = beforeGitNumstat;
  }
  try {
    const result = await agent.runTurn(input);
    const durationMs = Date.now() - startedAt;
    if (tui) tui.onTurnSuccess(durationMs);
    const afterGitSet = getGitChangedFileSet(workspaceDir);
    const afterGitNumstat = getGitNumstatMap(workspaceDir);
    const filesChangedSet = new Set([...(turnSummaryRef?.value?.filesChanged || [])]);
    if (beforeGitSet && afterGitSet) {
      for (const file of afterGitSet) {
        if (!beforeGitSet.has(file)) filesChangedSet.add(file);
      }
    }
    const fileStats = diffGitNumstat(beforeGitNumstat, afterGitNumstat);
    for (const stat of fileStats) filesChangedSet.add(stat.file);
    const turnSummary = buildTurnSummary({
      tools: turnSummaryRef?.value?.tools || [],
      filesChanged: [...filesChangedSet],
      fileStats,
      useColor: Boolean(tui),
    });
    const baseOutput = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const output = shouldShowTurnSummary({
      tools: turnSummaryRef?.value?.tools || [],
      filesChanged: [...filesChangedSet],
    })
      ? `${baseOutput}\n\n${turnSummary}`
      : baseOutput;
    if (tui) {
      const usage = tui.getTurnTokenUsage();
      logLine(`[response] ${output}`);
      logLine(
        `[result] done | time: ${formatReadableDuration(durationMs)} | tok ↑${formatCompactNumber(usage.sent)} ↓${formatCompactNumber(usage.received)}`
      );
      tui.clearLiveThought();
      tui.render("", "done");
    } else if (display) {
      display.onResponse(output);
    } else {
      console.log(`\n${output}`);
    }
    return { ok: true, aborted: false, error: "" };
  } catch (err) {
    const aborted = isTaskAbortError(err);
    if (tui) {
      if (aborted) tui.onTurnSuccess(Date.now() - startedAt);
      else tui.onTurnError(err.message, Date.now() - startedAt);
    }
    if (tui) {
      tui.clearLiveThought();
      if (aborted) {
        logLine("[result] aborted by user");
        tui.render("", "aborted");
      } else {
        tui.event(`error: ${err.message}`);
        tui.render("", "error");
      }
    } else if (display) {
      display.onError(aborted ? "Task aborted by user." : err.message);
    } else {
      console.error(`error: ${aborted ? "Task aborted by user." : err.message}`);
    }
    return { ok: false, aborted, error: aborted ? "aborted" : String(err?.message || "error") };
  } finally {
    if (turnSummaryRef?.value) {
      turnSummaryRef.value.active = false;
    }
  }
}

async function handleSlashCommand(input, ctx) {
  const {
    agent,
    autoApproveRef,
    traceRef,
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
        "/compact",
        "/approve on|off",
        "/trace on|off",
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
    if (ctx.todosRef) {
      ctx.todosRef.value = [];
      if (ctx.tui) ctx.tui.setTodos([]);
    }
    if (ctx.todoAutoTrackRef) ctx.todoAutoTrackRef.value = false;
    if (ctx.tui) {
      ctx.tui.resetContextUsage();
      ctx.tui.render("", "context cleared");
    }
    logLine("all context cleared");
    return { done: false, handled: true };
  }
  if (lower === "/compact") {
    const result = await agent.compactHistory();
    if (!result.compacted) {
      logLine(`compact skipped: ${result.summary}`);
      return { done: false, handled: true };
    }
    logLine(
      `context compacted: ${result.beforeMessages} -> ${result.afterMessages} messages (removed ${result.removedMessages})`
    );
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
  if (lower.startsWith("/trace")) {
    const mode = normalized.split(/\s+/)[1]?.toLowerCase();
    if (mode === "on" || mode === "off") {
      traceRef.value = mode === "on";
      logLine(`trace ${mode}`);
    } else {
      logLine("usage: /trace on|off");
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
    if (names.length === 0) {
      logLine("active skills: none");
    } else {
      logLine("## Active Skills");
      for (const name of names) {
        logLine(`- **${name}**`);
      }
    }
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
  const startupAutoSkills = await autoLoadSkillsFromInstructions(
    projectInstructionsRef.value,
    activeSkillsRef,
    skillIndex
  );
  const autoApproveRef = { value: false };
  const historyFile = getHistoryFilePath();
  const initialHistory = await loadHistory(historyFile);
  const useTui = args.tui || process.env.PIECODE_TUI === "1";
  if (useTui) {
    const neoBlessedAvailable = await hasNeoBlessedInstalled();
    if (!neoBlessedAvailable) {
      throw new Error("neo-blessed is required for TUI mode. Please run: npm install");
    }
  }
  const display = useTui ? null : new Display();
  const llmDebugRef = { value: false };
  const traceRef = { value: process.env.PIECODE_TRACE === "1" };
  const verboseToolLogs = process.env.PIECODE_VERBOSE_TOOL_LOGS === "1";
  const llmStreamRef = { value: { turn: "", planning: "", replanning: "" } };
  const traceStateRef = { value: { turnId: 0, turnStartedAt: 0, llmStageStart: {}, toolStartByName: {} } };
  const turnSummaryRef = {
    value: { active: false, tools: [], filesChanged: new Set(), beforeGitSet: null },
  };
  const taskTraceRef = { seq: 0, current: null, sessionId: makeSessionId(), sessionDir: "" };
  const currentInputRef = { value: "" };
  const todosRef = { value: [] };
  const todoAutoTrackRef = { value: false };
  const readlineOutput = useTui ? createMutedTtyOutput(stdout) : stdout;

  // Filter stdin through a Transform that converts terminal-specific Shift+Enter
  // escape sequences into plain \n (Ctrl+J) so Node's readline doesn't choke on them.
  const stdinFilter = createStdinFilter();
  stdin.pipe(stdinFilter);
  // Carry over TTY properties so readline treats the stream as a terminal.
  stdinFilter.isTTY = stdin.isTTY;
  stdinFilter.isRaw = stdin.isRaw;
  stdinFilter.setRawMode = (mode) => {
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(mode);
    }
  };
  const filteredInput = stdinFilter;

  // In non-TUI mode, normalize keypress events directly from stdin.
  // In TUI mode, neo-blessed provides its own key event stream.
  if (!useTui) {
    readlineCore.emitKeypressEvents(filteredInput);
  }
  let keypressSource = filteredInput;
  let destroyKeypressSource = () => {};
  if (useTui) {
    const keypressHub = await createNeoBlessedKeypressSource({
      input: filteredInput,
      output: readlineOutput,
    });
    keypressSource = keypressHub.source || filteredInput;
    destroyKeypressSource = typeof keypressHub.destroy === "function" ? keypressHub.destroy : () => {};
  }

  const createReadline = (history = []) => {
    if (useTui) {
      return new TuiLineEditor({
        keypressSource,
        history,
        historySize: HISTORY_MAX,
        removeHistoryDuplicates: true,
      });
    }
    const next = createInterface({
      input: filteredInput,
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
  const isReadlineClosed = () => {
    if (!rl) return true;
    if (rl.closed === true) return true;
    if (rl.input && rl.input.destroyed) return true;
    return false;
  };
  const safeRlWrite = (...args) => {
    if (isReadlineClosed()) return false;
    try {
      rl.write(...args);
      return true;
    } catch (err) {
      if (err && (err.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(String(err.message || "")))) {
        return false;
      }
      throw err;
    }
  };

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

  const logLine = createLogger(tui, display, () => currentInputRef.value, (line) =>
    recordTaskLog(taskTraceRef, line)
  );
  const exitArmedRef = { value: false };
  const approvalActiveRef = { value: false };
  const suppressNextSubmitRef = { value: false };
  const pendingCommandSubmitRef = { value: "" };
  const modelPickerRef = { active: false, query: "", options: [], index: 0 };
  const commandPickerRef = { active: false, options: [], index: 0 };
  const taskRunningRef = { value: false };
  const escAbortArmedRef = { value: false };
  let escAbortTimer = null;
  let onKeypress = null;
  let onMouseData = null;
  let renderLiveInput = () => {};
  if (tui || display) {
    renderLiveInput = () => {
      if (!tui || isReadlineClosed()) return;
      const lineNow = String(rl.line || "");
      const cleanedLineNow = stripMouseInputNoise(lineNow);
      if (cleanedLineNow !== lineNow) {
        safeRlWrite(null, { ctrl: true, name: "u" });
        if (cleanedLineNow) safeRlWrite(cleanedLineNow);
      }
      const stableLine = cleanedLineNow;
      const cursorNow = Number.isFinite(rl.cursor) ? Math.max(0, Math.floor(rl.cursor)) : lineNow.length;
      const safeCursor = Math.min(cursorNow, stableLine.length);
      const inputNow = stableLine;
      currentInputRef.value = inputNow;
      tui.renderInput(inputNow, safeCursor);
    };
    onKeypress = (str, key = {}) => {
      if (isReadlineClosed()) return;
      if (approvalActiveRef.value) return;
      const currentLineRaw = String(rl.line || "");
      const currentLine = stripMouseInputNoise(currentLineRaw);
      if (currentLine !== currentLineRaw) {
        safeRlWrite(null, { ctrl: true, name: "u" });
        if (currentLine) safeRlWrite(currentLine);
      }
      const emptyInput = currentLine.trim().length === 0;

      if (exitArmedRef.value && (!emptyInput || (key.name && key.name !== "d"))) {
        exitArmedRef.value = false;
        if (tui) tui.clearInputHint();
      }
      if (escAbortArmedRef.value && key.name !== "escape") {
        escAbortArmedRef.value = false;
        if (escAbortTimer) {
          clearTimeout(escAbortTimer);
          escAbortTimer = null;
        }
      }

      if (isMultilineShortcut(str, key)) {
        // Insert a newline at cursor without submitting.
        safeRlWrite("\n");
        currentInputRef.value = String(rl.line || "");
        if (tui) tui.renderInput(currentInputRef.value);
        return;
      }

      if (tui) {
        if (key.name === "escape" && taskRunningRef.value) {
          if (escAbortArmedRef.value) {
            escAbortArmedRef.value = false;
            if (escAbortTimer) {
              clearTimeout(escAbortTimer);
              escAbortTimer = null;
            }
            const requested = agent.requestAbort();
            tui.clearInputHint();
            tui.render(currentInputRef.value, requested ? "aborting task..." : "no active task to abort");
            return;
          }
          escAbortArmedRef.value = true;
          tui.setInputHint("Press ESC again to abort current task.");
          if (escAbortTimer) clearTimeout(escAbortTimer);
          escAbortTimer = setTimeout(() => {
            escAbortArmedRef.value = false;
            escAbortTimer = null;
            tui.clearInputHint();
          }, 1200);
          return;
        }
        if (key.ctrl && key.name === "c") {
          exitArmedRef.value = false;
          suppressNextSubmitRef.value = false;
          pendingCommandSubmitRef.value = "";
          modelPickerRef.active = false;
          modelPickerRef.query = "";
          modelPickerRef.options = [];
          modelPickerRef.index = 0;
          commandPickerRef.active = false;
          commandPickerRef.options = [];
          commandPickerRef.index = 0;
          tui.clearModelSuggestions();
          tui.clearCommandSuggestions();
          tui.clearInputHint();
          safeRlWrite(null, { ctrl: true, name: "u" });
          currentInputRef.value = "";
          tui.renderInput("");
          tui.render("", "input cleared");
          return;
        }
        if (key.ctrl && key.name === "o") {
          llmDebugRef.value = !llmDebugRef.value;
          tui.setLlmDebugEnabled(llmDebugRef.value);
          tui.setRawLogsVisible(llmDebugRef.value);
          tui.render(currentInputRef.value, llmDebugRef.value ? "LLM I/O panel ON" : "LLM I/O panel OFF");
          return;
        }
        if (key.ctrl && (key.name === "a" || key.name === "e")) {
          setImmediate(renderLiveInput);
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
        if (key.shift && key.name === "up") {
          tui.scrollLines(1);
          return;
        }
        if (key.shift && key.name === "down") {
          tui.scrollLines(-1);
          return;
        }
        if (key.name === "pageup") {
          tui.scrollPage(1);
          return;
        }
        if (key.name === "pagedown") {
          tui.scrollPage(-1);
          return;
        }
        if (key.name === "home") {
          tui.scrollToTop();
          return;
        }
        if (key.name === "end") {
          tui.scrollToBottom();
          return;
        }
        if (
          (key.name === "up" || key.name === "down") &&
          !modelPickerRef.active &&
          !commandPickerRef.active &&
          currentLine.trim().length === 0
        ) {
          tui.scrollLines(key.name === "up" ? 1 : -1);
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
            safeRlWrite(null, { ctrl: true, name: "u" });
            safeRlWrite(nextLine);
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
            safeRlWrite(null, { ctrl: true, name: "u" });
            safeRlWrite(`/model ${selectedModel}`);
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
            safeRlWrite(null, { ctrl: true, name: "u" });
            safeRlWrite(selectedCommand);
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
            safeRlWrite(null, { ctrl: true, name: "u" });
            safeRlWrite(selectedCommand);
            currentInputRef.value = selectedCommand;
            tui.renderInput(currentInputRef.value);
            return;
          }
        }

        setImmediate(renderLiveInput);
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
    keypressSource.on("keypress", onKeypress);
  }
  if (tui) {
    let mouseRemainder = "";
    onMouseData = (chunk) => {
      if (isReadlineClosed()) return;
      const parsed = consumeMouseWheelDeltas(chunk, mouseRemainder);
      mouseRemainder = parsed.remainder;
      const lineNow = String(rl.line || "");
      const cleanedLine = stripMouseInputNoise(lineNow);
      if (cleanedLine !== lineNow) {
        safeRlWrite(null, { ctrl: true, name: "u" });
        if (cleanedLine) safeRlWrite(cleanedLine);
        renderLiveInput();
      }
      if (approvalActiveRef.value) return;
      if (!Array.isArray(parsed.deltas) || parsed.deltas.length === 0) return;
      for (const delta of parsed.deltas) tui.scrollLines(delta);
    };
    filteredInput.on("data", onMouseData);
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
    const looksLikeCodexModel =
      selectedModel.toLowerCase().includes("codex") ||
      selectedModel.toLowerCase().startsWith("gpt-5");
    const openRouterConfigured =
      Boolean(process.env.OPENROUTER_API_KEY) ||
      Boolean(settings?.providers?.openrouter?.apiKey) ||
      Boolean(settings?.apiKey && String(settings?.provider || "").toLowerCase() === "openrouter");
    const inferredProvider =
      parsed.provider ||
      (
        looksLikeCodexModel &&
        providerOptionsRef.value.provider !== "codex"
      ? "codex"
      : ""
      ) ||
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
    if (nextProviderName) {
      if (!settings.providers || typeof settings.providers !== "object") {
        settings.providers = {};
      }
      const existingProviderSettings =
        settings.providers[nextProviderName] &&
        typeof settings.providers[nextProviderName] === "object"
          ? settings.providers[nextProviderName]
          : {};
      settings.providers[nextProviderName] = {
        ...existingProviderSettings,
        model: selectedModel,
      };
    }
    try {
      await saveSettings(settingsFile, settings);
    } catch {
      // best effort
    }
    if (tui) {
      tui.onModelCall(formatProviderModel(nextProvider));
      tui.onThinkingDone();
    }
    return nextProvider;
  };

  const askApproval = async (q) => {
    let ans = "";
    const defaultYes = false;
    if (tui) {
      const compactPrompt = q.replace(/\s+/g, " ").trim();
      approvalActiveRef.value = true;
      tui.setApprovalPrompt(compactPrompt, defaultYes);
      const approved = await waitForTuiApproval({ stdinStream: keypressSource, defaultYes });
      approvalActiveRef.value = false;
      tui.clearApprovalPrompt();
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
        recordTaskEvent(taskTraceRef, evt);
        const label = formatProviderModel({ kind: evt.provider, model: evt.model });
        if (tui) tui.onModelCall(label);
        logLine(`[model] ${label}`);
      }
      if (evt.type === "planning_call") {
        recordTaskEvent(taskTraceRef, evt);
        if (tui) tui.onModelCall(formatProviderModel({ kind: evt.provider, model: evt.model }));
        logLine(`[plan] creating plan`);
      }
      if (evt.type === "replanning_call") {
        recordTaskEvent(taskTraceRef, evt);
        if (tui) tui.onModelCall(formatProviderModel({ kind: evt.provider, model: evt.model }));
        logLine(`[plan] revising plan`);
      }
      if (evt.type === "plan") {
        recordTaskEvent(taskTraceRef, evt);
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
        recordTaskEvent(taskTraceRef, evt);
        if (display) display.onPlan(evt.plan);
        const budget = evt.plan?.toolBudget ?? "-";
        const summary = evt.plan?.summary ? ` - ${evt.plan.summary}` : "";
        logLine(`[plan] updated budget=${budget}${summary}`);
      }
      if (evt.type === "plan_progress") {
        recordTaskEvent(taskTraceRef, evt);
        logLine(`[plan] ${evt.message}`);
      }
      if (evt.type === "llm_request") {
        recordTaskEvent(taskTraceRef, evt);
        if (traceRef.value) {
          traceStateRef.value.llmStageStart[evt.stage] = Date.now();
          const chars = String(evt.payload || "").length;
          logLine(`[trace] llm_request stage=${evt.stage} chars=${chars}`);
        }
        if (tui) tui.onThinking(evt.stage);
        if (display) display.onThinking(evt.stage);
        if (llmStreamRef.value && Object.prototype.hasOwnProperty.call(llmStreamRef.value, evt.stage)) {
          llmStreamRef.value[evt.stage] = "";
        }
        if (tui && evt.stage === "turn") {
          tui.setLiveThought("Analyzing request...");
        }
        const endpoint = inferEndpointForProvider(providerOptionsRef.value, providerRef.value);
        const sentTokens = estimateTokenCount(evt.payload);
        if (tui) {
          const used = sentTokens;
          const limit = inferContextWindow(providerRef.value.model);
          tui.setContextUsage(used, limit);
          tui.addTokenUsage({ sent: sentTokens, received: 0 });
        }
        logLine(`[thinking] request:${evt.stage} endpoint:${endpoint} ${summarizeForLog(evt.payload)}`);
        if (tui && llmDebugRef.value) {
          tui.setLlmRequest(`[${evt.stage}] endpoint=${endpoint}\n${evt.payload}`);
        }
      }
      if (evt.type === "llm_response_delta") {
        recordTaskEvent(taskTraceRef, evt);
        if (llmStreamRef.value && Object.prototype.hasOwnProperty.call(llmStreamRef.value, evt.stage)) {
          llmStreamRef.value[evt.stage] += String(evt.delta || "");
        }
        if (tui && evt.stage === "turn") {
          const preview =
            extractReadableThinkingPreview(llmStreamRef.value.turn) ||
            extractReadableThinkingPreview(evt.delta);
          if (preview) {
            tui.setLiveThought(preview);
          }
        }
      }
      if (evt.type === "llm_response") {
        recordTaskEvent(taskTraceRef, evt);
        if (traceRef.value) {
          const startedAt = Number(traceStateRef.value.llmStageStart[evt.stage] || 0);
          const durationMs = startedAt > 0 ? Date.now() - startedAt : 0;
          const chars = String(evt.payload || "").length;
          logLine(`[trace] llm_response stage=${evt.stage} chars=${chars} duration=${durationMs}ms`);
        }
        if (llmStreamRef.value && Object.prototype.hasOwnProperty.call(llmStreamRef.value, evt.stage)) {
          llmStreamRef.value[evt.stage] = String(evt.payload || "");
        }
        if (tui && evt.stage === "turn") {
          const preview =
            extractThinkingFromFinalModelPayload(llmStreamRef.value.turn) ||
            extractReadableThinkingPreview(llmStreamRef.value.turn);
          if (preview) {
            tui.setLiveThought(preview);
          }
        }
        const receivedTokens = estimateTokenCount(evt.payload);
        if (tui) tui.addTokenUsage({ sent: 0, received: receivedTokens });
        logLine(`[thinking] response:${evt.stage} ${summarizeForLog(evt.payload)}`);
        if (tui && llmDebugRef.value) {
          tui.setLlmResponse(`[${evt.stage}] ${evt.payload}`);
        }
      }
      if (evt.type === "thinking_done") {
        recordTaskEvent(taskTraceRef, evt);
        if (tui) tui.onThinkingDone();
        if (display) display.onThinkingDone();
      }
      if (evt.type === "thought") {
        recordTaskEvent(taskTraceRef, evt);
        if (tui) tui.clearLiveThought();
        if (display) display.onThought(evt.content);
        logLine(`[thought] ${evt.content}`);
      }
      if (evt.type === "tool_use") {
        recordTaskEvent(taskTraceRef, evt);
        if (turnSummaryRef.value.active) {
          turnSummaryRef.value.tools.push(evt.tool);
          if (evt.tool === "write_file" && evt.input?.path) {
            turnSummaryRef.value.filesChanged.add(String(evt.input.path));
          }
        }
        if (tui) tui.onToolUse(evt.tool);
        if (tui && evt.reason) {
          tui.setLiveThought(String(evt.reason));
        }
        if (display) display.onToolUse(evt.tool, evt.input, evt.reason);
        const summary = formatToolInputSummary(evt.tool, evt.input, 100);
        if (verboseToolLogs) {
          const details = Object.entries(evt.input || {})
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ");
          logLine(
            `[tool] ${evt.tool}${evt.reason ? ` - ${summarizeForLog(evt.reason, 120)}` : ""}${details ? ` (${details})` : ""}`
          );
        } else {
          const reason = evt.reason ? ` - ${summarizeForLog(evt.reason, 120)}` : "";
          const inputSummary = summary ? ` (${summary})` : "";
          logLine(`[tool] ${evt.tool}${reason}${inputSummary}`);
        }
      }
      if (evt.type === "tool_start") {
        recordTaskEvent(taskTraceRef, evt);
        if (traceRef.value) {
          traceStateRef.value.toolStartByName[evt.tool] = Date.now();
          logLine(`[trace] tool_start name=${evt.tool}`);
        }
        if (display) display.onToolStart(evt.tool, evt.input);
        if (verboseToolLogs) {
          const details = Object.entries(evt.input || {})
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ");
          logLine(`[run] ${evt.tool}${details ? ` ${details}` : ""}`);
        } else {
          const summary = formatToolInputSummary(evt.tool, evt.input, 120);
          logLine(`[run] ${evt.tool}${summary ? ` ${summary}` : ""}`);
        }
        if (todoAutoTrackRef.value && evt.tool !== "todo_write" && evt.tool !== "todowrite") {
          const advanced = advanceTodosOnToolStart(todosRef.value);
          if (advanced.length > 0) {
            todosRef.value = advanced;
            if (tui) tui.setTodos(todosRef.value);
          }
        }
      }
      if (evt.type === "tool_end") {
        recordTaskEvent(taskTraceRef, evt);
        if (traceRef.value) {
          const startedAt = Number(traceStateRef.value.toolStartByName[evt.tool] || 0);
          const durationMs = startedAt > 0 ? Date.now() - startedAt : 0;
          const err = evt.error ? "yes" : "no";
          logLine(`[trace] tool_end name=${evt.tool} duration=${durationMs}ms error=${err}`);
        }
        if (display) display.onToolEnd(evt.tool, evt.result, evt.error);
      }
    },
  });

  if (args.prompt !== null) {
    startTaskTrace(taskTraceRef, { input: args.prompt, kind: "agent" });
    if (startupAutoSkills.enabled.length > 0) {
      console.log(`auto-loaded skills: ${startupAutoSkills.enabled.join(", ")}`);
    }
    if (startupAutoSkills.missing.length > 0) {
      console.error(`warning: auto-load skills missing: ${startupAutoSkills.missing.join(", ")}`);
    }

    const autoSkillResult = await autoEnableSkills(args.prompt, activeSkillsRef, skillIndex);
    if (autoSkillResult.enabled.length > 0) {
      console.log(`auto-enabled skills: ${autoSkillResult.enabled.join(", ")}`);
    }

    try {
      const result = await agent.runTurn(args.prompt);
      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      if (display) {
        display.onResponse(output);
      } else {
        console.log(`\n${output}`);
      }
      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, { status: "done" });
      if (saved) console.log(`session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
    } catch (err) {
      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, {
        status: "error",
        error: String(err?.message || "error"),
      });
      if (saved) console.error(`session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
      throw err;
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
    if (startupAutoSkills.enabled.length > 0) {
      tui.event(`auto-loaded skills: ${startupAutoSkills.enabled.join(", ")}`);
    }
    if (startupAutoSkills.missing.length > 0) {
      tui.event(`warning: auto-load skills missing: ${startupAutoSkills.missing.join(", ")}`);
    }
    tui.render(currentInputRef.value, "Type /help for commands");
  } else {
    console.log(`Pie Code (${formatProviderModel(providerRef.value)})`);
    if (projectInstructionsRef.value?.source) {
      console.log(`loaded project instructions: ${projectInstructionsRef.value.source}`);
    }
    if (activeSkillsRef.value.length > 0) {
      console.log(`skills: ${activeSkillsRef.value.map((s) => s.name).join(", ")}`);
    }
    if (startupAutoSkills.enabled.length > 0) {
      console.log(`auto-loaded skills: ${startupAutoSkills.enabled.join(", ")}`);
    }
    if (startupAutoSkills.missing.length > 0) {
      console.error(`warning: auto-load skills missing: ${startupAutoSkills.missing.join(", ")}`);
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
      const isSigint =
        err?.code === "ABORT_ERR" ||
        message.includes("SIGINT") ||
        message.includes("The operation was aborted");
      if (isSigint) {
        suppressNextSubmitRef.value = false;
        pendingCommandSubmitRef.value = "";
        modelPickerRef.active = false;
        modelPickerRef.query = "";
        modelPickerRef.options = [];
        modelPickerRef.index = 0;
        commandPickerRef.active = false;
        commandPickerRef.options = [];
        commandPickerRef.index = 0;
        if (tui) {
          tui.clearModelSuggestions();
          tui.clearCommandSuggestions();
          tui.clearInputHint();
        }
        safeRlWrite(null, { ctrl: true, name: "u" });
        currentInputRef.value = "";
        if (tui) tui.renderInput("");
        if (tui) tui.render("", "input cleared");
        else process.stdout.write("\n");
        continue;
      }
      const isEof = message.includes("Ctrl+D") || message.includes("EOT");
      const isClosed = message.includes("readline was closed");
      const isInputAbort = isEof || isClosed;
      if (!isInputAbort) throw err;

      if (tui) {
        if (!exitArmedRef.value && String(rl.line || "").trim().length === 0) {
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

    const combinedInput = `${rawInput}`;
    const finalInput = stripMouseInputNoise(combinedInput).trim();
    if (!finalInput) continue;
    if (display) display.clearSuggestions();
    exitArmedRef.value = false;
    if (tui) tui.clearInputHint();
    if (finalInput.startsWith("!")) {
      startTaskTrace(taskTraceRef, { input: finalInput, kind: "shell" });
      currentInputRef.value = "";
      if (tui) tui.render(currentInputRef.value, "running shell command");
      const shellResult = await runDirectShellCommand(finalInput.slice(1), {
        workspaceDir,
        logLine,
        tui,
        display,
      });
      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, {
        status: shellResult?.ok ? "done" : "error",
        error: shellResult?.ok ? "" : String(shellResult?.error || ""),
      });
      if (saved) logLine(`[trace] session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
      continue;
    }
    const isSlash = finalInput.startsWith("/");
    if (!isSlash) {
      startTaskTrace(taskTraceRef, { input: finalInput, kind: "agent" });
      logLine(`[task] ${finalInput}`);
    }
    currentInputRef.value = "";
    if (tui) tui.render(currentInputRef.value, isSlash ? "handling command" : "processing task");
    if (!isSlash) {
      traceStateRef.value.turnId += 1;
      traceStateRef.value.turnStartedAt = Date.now();
      traceStateRef.value.llmStageStart = {};
      traceStateRef.value.toolStartByName = {};
      if (traceRef.value) {
        logLine(`[trace] turn_start id=${traceStateRef.value.turnId} input_chars=${finalInput.length}`);
      }
    }

    const slash = await handleSlashCommand(finalInput, {
      agent,
      autoApproveRef,
      traceRef,
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
      todosRef,
      todoAutoTrackRef,
    });
    if (slash.done) break;
    if (slash.handled) {
      if (display) display.clearSuggestions();
      currentInputRef.value = "";
      continue;
    }

    const localTask = maybeHandleLocalInfoTask(finalInput, { logLine, tui, display });
    if (localTask.handled) {
      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, { status: "done" });
      if (saved) logLine(`[trace] session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
      if (display) display.clearSuggestions();
      currentInputRef.value = "";
      continue;
    }

    await maybeAutoEnableSkills(finalInput, activeSkillsRef, skillIndex, logLine);
    taskRunningRef.value = true;
    try {
      const turnResult = await runAgentTurn(agent, finalInput, tui, logLine, display, turnSummaryRef, workspaceDir);
      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, {
        status: turnResult?.ok ? "done" : turnResult?.aborted ? "aborted" : "error",
        error: turnResult?.ok ? "" : String(turnResult?.error || ""),
      });
      if (saved) logLine(`[trace] session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
    } finally {
      taskRunningRef.value = false;
      escAbortArmedRef.value = false;
      if (escAbortTimer) {
        clearTimeout(escAbortTimer);
        escAbortTimer = null;
      }
      if (tui) tui.clearInputHint();
    }
    if (traceRef.value) {
      const elapsed = traceStateRef.value.turnStartedAt
        ? Date.now() - traceStateRef.value.turnStartedAt
        : 0;
      logLine(`[trace] turn_end id=${traceStateRef.value.turnId} duration=${elapsed}ms`);
    }
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
    if (onKeypress && keypressSource && typeof keypressSource.off === "function") {
      keypressSource.off("keypress", onKeypress);
    }
    if (escAbortTimer) clearTimeout(escAbortTimer);
    if (onMouseData) filteredInput.off("data", onMouseData);
    stdin.unpipe(stdinFilter);
    destroyKeypressSource();
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

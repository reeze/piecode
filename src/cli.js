#!/usr/bin/env node
import { promises as fs, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import * as readlineCore from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable, Transform } from "node:stream";
import { stdin, stdout } from "node:process";
import { Agent } from "./lib/agent.js";
import { createAgentEventHandler } from "./lib/agentEventHandler.js";
import { getProvider } from "./lib/providers.js";
import {
  addSkillByName,
  autoEnableSkills,
  autoLoadSkillsFromInstructions,
  discoverSkillCommands,
  discoverSkills,
  loadActiveSkills,
  removeSkillByName,
  resolveRequestedSkills,
  resolveSkillCommand,
  resolveSkillRoots,
} from "./lib/skills.js";
import {
  addPluginByName,
  autoEnablePlugins,
  discoverPluginCommands,
  discoverPlugins,
  getDefaultPluginNames,
  loadActivePlugins,
  removePluginByName,
  resolvePluginCommand,
  resolvePluginRoots,
  resolveRequestedPlugins,
} from "./lib/plugins.js";
import { installPlugin, updatePlugin } from "./lib/pluginInstaller.js";
import { createSkillInteractive } from "./lib/skillCreator.js";
import { SimpleTui } from "./lib/tui.js";
import { InkTuiLayout } from "./lib/inkLayout.js";
import { buildInputHints } from "./lib/inputHints.js";
import { Display } from "./lib/display.js";
import { consumeMouseWheelDeltas, stripMouseInputNoise } from "./lib/mouse.js";
import { applyCommandPickerSelectionForSubmit, isPickerCancelKey } from "./lib/cliTuiInteraction.js";
import { TuiLineEditor } from "./lib/tuiLineEditor.js";
import { filterUsableModelCatalog, getModelQueryFromInput } from "./lib/modelInput.js";
import {
  buildModelCatalog,
  describeProviderSetup,
  discoverAllProviderModels,
  formatModelRef,
  getCatalogContextWindow,
  getProviderSpec,
  inferProviderForModel,
  isKnownProvider,
  normalizeProviderId,
  parseModelRef,
  resolveProviderConfig,
} from "./lib/modelCatalog.js";
import {
  buildDoctorReport,
  describeModelRef,
  formatModelCatalogLines,
  formatProviderTable,
} from "./lib/providerStatus.js";
import { McpHub, mergeCommonMcpServers, resolveMcpServerConfigs } from "./lib/mcp.js";
import { AgentSessionState, SessionEventBus, createJsonlSessionSink } from "./lib/sessionProtocol.js";
import {
  createTmuxSubagentWatcher,
  resolveTmuxSubagentOptions,
  watchSubagentEventsFile,
} from "./lib/tmuxSubagentWindows.js";
import { classifyShellCommand } from "./lib/tools.js";
import { applyFileMentionSelection, getFileMentionSuggestions, isGitRelatedPath } from "./lib/fileMentions.js";
import { buildFileMentionContext } from "./lib/fileMentionContext.js";
import { formatAttachmentSummary, readClipboardImage } from "./lib/attachments.js";
import { loadMemory } from "./lib/memory.js";
import {
  clearLedger,
  createEmptyLedger,
  formatLedgerForDisplay,
  loadLedger,
  saveLedger,
} from "./lib/taskLedger.js";
import { loadAgentDefinitions } from "./lib/agentDefinitions.js";
import {
  listResumableSessions,
  loadResumableSession,
  makeSessionId as makeResumableSessionId,
  resolveResumableSessionId,
  saveResumableSession,
  shortSessionId,
} from "./lib/resumableSessions.js";
import {
  buildGoalContinuationPrompt,
  buildGoalPrompt,
  createGoalRun,
  parseGoalStatus,
  summarizeGoalOutput,
} from "./lib/goalMode.js";

const HISTORY_MAX = 500;
const execAsync = promisify(execCb);
const DIRECT_SHELL_MAX_OUTPUT = 12000;
const FILE_MENTION_INDEX_MAX = 15000;
const FILE_MENTION_REFRESH_MS = 15000;
const SLASH_COMMANDS = [
  "/help",
  "/exit",
  "/quit",
  "/clear",
  "/compact",
  "/sessions",
  "/resume",
  "/status",
  "/task",
  "/tasks",
  "/agents",
  "/plan",
  "/goal",
  "/approve",
  "/trace",
  "/debug",
  "/debug status",
  "/debug llm",
  "/debug last",
  "/debug save",
  "/model",
  "/models",
  "/provider",
  "/providers",
  "/doctor",
  "/ledger",
  "/ledger clear",
  "/think",
  "/thinking",
  "/reasoning",
  "/mcp",
  "/mcp list",
  "/mcp show",
  "/mcp add",
  "/mcp remove",
  "/mcp reload",
  "/mcp import",
  "/skills",
  "/skills list",
  "/skills commands",
  "/skills use",
  "/skills off",
  "/skills clear",
  "/plugins",
  "/plugins list",
  "/plugins commands",
  "/plugins install",
  "/plugins update",
  "/plugins use",
  "/plugins off",
  "/plugins clear",
  "/plugin",
  "/use",
  "/skill-creator",
  "/workspace",
  "/attach image",
];

const DEFAULT_CONTEXT_WINDOW = 128000;

// Seed suggestions come from the shared model registry so every provider the
// registry knows about shows up in the picker without a second hard-coded list.
const MODEL_SUGGESTIONS = buildModelCatalog({ includeUnconfigured: true }).map((row) => row.ref);

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
  // `--model deepseek:deepseek-chat` selects the provider as well as the model.
  const modelRef = parseModelRef(args.model || settings.model || "");
  const provider =
    normalizeProviderId(args.provider || modelRef.provider || settings.provider || "") || null;
  const providerSettings =
    provider && settings.providers && typeof settings.providers === "object"
      ? settings.providers[provider] || {}
      : {};

  const model =
    modelRef.model ||
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

  const thinkingEffort =
    args.thinkingEffort ||
    providerSettings.thinkingEffort ||
    providerSettings.thinking_effort ||
    providerSettings.reasoningEffort ||
    providerSettings.reasoning_effort ||
    settings.thinkingEffort ||
    settings.thinking_effort ||
    settings.reasoningEffort ||
    settings.reasoning_effort ||
    process.env.PIECODE_THINKING_EFFORT ||
    process.env.PIECODE_REASONING_EFFORT ||
    null;

  return {
    provider,
    apiKey,
    model,
    baseUrl: endpoint,
    endpoint,
    thinkingEffort,
    // The provider registry resolves credentials/endpoints from settings too.
    settings,
  };
}

function getHistoryFilePath() {
  const configured = process.env.PIECODE_HISTORY_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode_history");
}

function makeSessionId() {
  return makeResumableSessionId();
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

function startTaskTrace(taskTraceRef, { input, kind, sessionBus = null }) {
  if (sessionBus && typeof sessionBus.emit === "function") {
    sessionBus.emit("task.start", { input: String(input || ""), kind: String(kind || "task") });
  }
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
    llm: [],
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

function recordTaskLlm(taskTraceRef, entry) {
  if (!taskTraceRef?.current || !entry || typeof entry !== "object") return;
  const usage = normalizeTokenUsage(entry.usage);
  taskTraceRef.current.llm.push({
    at: new Date().toISOString(),
    direction: String(entry.direction || ""),
    stage: String(entry.stage || ""),
    provider: String(entry.provider || ""),
    model: String(entry.model || ""),
    endpoint: String(entry.endpoint || ""),
    chars: Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : 0,
    durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : 0,
    ...(usage ? { usage } : {}),
    payload: clipText(entry.payload, 32000),
  });
}

async function finishTaskTrace(taskTraceRef, workspaceDir, { status = "done", error = "", sessionBus = null } = {}) {
  if (sessionBus && typeof sessionBus.emit === "function") {
    const doneType = String(status || "done") === "done" ? "task.done" : "task.error";
    sessionBus.emit(doneType, { status: String(status || "done"), error: String(error || "") });
  }
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
    const llmText = (Array.isArray(current.llm) ? current.llm : [])
      .map((entry, idx) => {
        const meta = [
          `idx=${idx + 1}`,
          `at=${entry.at}`,
          `dir=${entry.direction || "-"}`,
          `stage=${entry.stage || "-"}`,
          `provider=${entry.provider || "-"}`,
          `model=${entry.model || "-"}`,
          `endpoint=${entry.endpoint || "-"}`,
          `chars=${entry.chars || 0}`,
          entry?.usage?.input_tokens != null ? `in_tok=${entry.usage.input_tokens}` : "",
          entry?.usage?.output_tokens != null ? `out_tok=${entry.usage.output_tokens}` : "",
          entry?.usage?.total_tokens != null ? `total_tok=${entry.usage.total_tokens}` : "",
          entry.durationMs > 0 ? `duration=${entry.durationMs}ms` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `[LLM] ${meta}\n${String(entry.payload || "")}`;
      })
      .join("\n\n");
    await fs.appendFile(trajectoryPath, `${JSON.stringify(current)}\n`, "utf8");
    if (logsText || llmText) {
      const llmSection = llmText ? `\n\n[llm-transcript]\n${llmText}\n` : "";
      await fs.appendFile(logsPath, `\n[${current.id}] ${current.input}\n${logsText}${llmSection}\n`, "utf8");
    }
    const saved = {
      id: current.id,
      sessionId: taskTraceRef.sessionId,
      dir: sessionDir,
      trajectoryPath,
      logsPath,
      status: current.status,
      error: current.error,
      durationMs: current.durationMs,
      input: current.input,
      finishedAt: current.finishedAt,
    };
    taskTraceRef.current = null;
    taskTraceRef.lastSaved = saved;
    return saved;
  } catch {
    taskTraceRef.current = null;
    return null;
  }
}

function formatDebugSavedTrace(saved, workspaceDir) {
  if (!saved || typeof saved !== "object") return "trace: no saved task trace yet";
  const rel = (value) => {
    const text = String(value || "");
    if (!text) return "-";
    try {
      return path.relative(workspaceDir, text) || text;
    } catch {
      return text;
    }
  };
  const lines = [
    `trace: ${saved.id || "-"} status=${saved.status || "-"} duration=${formatReadableDuration(saved.durationMs || 0)}`,
    `session: ${saved.sessionId || "-"}`,
    `trajectory: ${rel(saved.trajectoryPath)}`,
    `logs: ${rel(saved.logsPath)}`,
  ];
  if (saved.error) lines.push(`error: ${saved.error}`);
  if (saved.input) lines.push(`input: ${summarizeForLog(saved.input, 220)}`);
  return lines.join("\n");
}

function formatDebugStatus({
  traceRef,
  taskTraceRef,
  providerRef,
  workspaceDir,
  llmHistoryRef,
  subagentsRef,
  todosRef,
  planModeRef,
  contextWindowRef,
  agent,
} = {}) {
  const active = taskTraceRef?.current || null;
  const saved = taskTraceRef?.lastSaved || null;
  const llmEntries = Array.isArray(llmHistoryRef?.value?.entries) ? llmHistoryRef.value.entries.length : 0;
  const activeSubagents = subagentsRef?.value?.active instanceof Map ? subagentsRef.value.active.size : 0;
  const completedSubagents = Array.isArray(subagentsRef?.value?.completed) ? subagentsRef.value.completed.length : 0;
  const backgroundTasks = getBackgroundTaskCounts(agent);
  const todos = Array.isArray(todosRef?.value) ? todosRef.value : [];
  const doneTodos = todos.filter((todo) => String(todo?.status || "").toLowerCase() === "completed").length;
  const historyMessages = Array.isArray(agent?.history) ? agent.history.length : 0;
  const historyTokens = typeof agent?.estimateMessagesTokens === "function" ? agent.estimateMessagesTokens(agent.history) : 0;
  const lines = [
    "## Debug Status",
    `trace: ${traceRef?.value ? "on" : "off"}`,
    `plan mode: ${planModeRef?.value ? "on" : "off"}`,
    `model: ${providerRef?.value ? formatProviderModel(providerRef.value) : "unknown"}`,
    `context: ${formatCompactNumber(historyTokens)}/${formatCompactNumber(contextWindowRef?.value || 0)} estimated tokens (${historyMessages} messages)`,
    `task: ${active ? `${active.id} running ${formatReadableDuration(Date.now() - Date.parse(active.startedAt || Date.now()))}` : "idle"}`,
    `background tasks: ${backgroundTasks.running} running, ${backgroundTasks.total} total`,
    `last trace: ${saved ? `${saved.id} ${saved.status || "-"}` : "none"}`,
    `llm debug entries: ${llmEntries}`,
    `subagents: ${activeSubagents} active, ${completedSubagents} recent completed`,
    `todos: ${doneTodos}/${todos.length}`,
    `session dir: ${path.relative(workspaceDir, taskTraceRef?.sessionDir || path.join(workspaceDir, ".piecode", "sessions", taskTraceRef?.sessionId || ""))}`,
  ];
  if (active?.error) lines.push(`current error: ${active.error}`);
  if (saved?.error) lines.push(`last error: ${saved.error}`);
  return lines.join("\n");
}

function getBackgroundTaskCounts(agent) {
  const manager = agent?.backgroundTaskManager;
  const list = typeof manager?.list === "function" ? manager.list() : [];
  const tasks = Array.isArray(list) ? list : [];
  return {
    total: tasks.length,
    running: tasks.filter((task) => task?.status === "running").length,
  };
}

// ponytail: streaming deltas fire hundreds of appendFile calls per turn;
// buffer per file and flush every 200ms (plus a sync flush on exit).
const llmEventBuffers = new Map();
let llmEventExitFlushInstalled = false;

function flushLlmEventBuffersSync() {
  for (const [llmPath, buf] of llmEventBuffers) {
    if (buf.lines.length === 0) continue;
    const payload = buf.lines.join("");
    buf.lines = [];
    try {
      appendFileSync(llmPath, payload, "utf8");
    } catch {}
  }
}

async function persistLlmSessionEvent(taskTraceRef, workspaceDir, entry) {
  if (!entry || typeof entry !== "object") return;
  try {
    const sessionDir =
      taskTraceRef.sessionDir ||
      (await ensureSessionStoreDir(workspaceDir, taskTraceRef.sessionId));
    taskTraceRef.sessionDir = sessionDir;
    const llmPath = path.join(sessionDir, "llm.jsonl");
    let buf = llmEventBuffers.get(llmPath);
    if (!buf) {
      buf = { lines: [], timer: null };
      llmEventBuffers.set(llmPath, buf);
    }
    buf.lines.push(`${JSON.stringify(entry)}\n`);
    if (!llmEventExitFlushInstalled) {
      llmEventExitFlushInstalled = true;
      process.once("exit", flushLlmEventBuffersSync);
    }
    if (!buf.timer) {
      buf.timer = setTimeout(async () => {
        buf.timer = null;
        const payload = buf.lines.join("");
        buf.lines = [];
        try {
          await fs.appendFile(llmPath, payload, "utf8");
        } catch {}
      }, 200);
      buf.timer.unref?.();
    }
  } catch {
    // Best effort only; runtime should continue even if logging fails.
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
          instructions: {
            source: name,
            path: filePath,
            content: trimmed,
          },
          status: {
            source: name,
            state: "loaded",
            detail: "",
          },
        };
      }
      return {
        instructions: null,
        status: {
          source: name,
          state: "empty",
          detail: "",
        },
      };
    } catch (err) {
      const code = String(err?.code || "").toUpperCase();
      if (code === "ENOENT") continue;
      return {
        instructions: null,
        status: {
          source: name,
          state: "error",
          detail: String(err?.message || "unreadable"),
        },
      };
    }
  }
  return {
    instructions: null,
    status: {
      source: "AGENTS.md",
      state: "missing",
      detail: "",
    },
  };
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

function getInteractiveHelpLines() {
  return [
    "## PieCode command map",
    "",
    "### Essentials",
    "- `/help`, `/status`, `/clear`, `/compact`, `/exit` - session basics",
    "- `/sessions`, `/resume <id>` - continue previous work",
    "",
    "### Agent workflow",
    "- `/task`, `/btw <question>`, `/plan`, `/goal <task>`, `/agents` - manage long-running work",
    "- `/approve on|off` - control shell command approval",
    "",
    "### Model and runtime",
    "- `/model`, `/model list` - switch or inspect models",
    "- `/think <none|minimal|low|medium|high|xhigh|off>` - adjust reasoning effort",
    "",
    "### Extensions",
    "- `/skills`, `/plugins`, `/mcp` - inspect and manage extensions",
    "- `/attach image`, `/skill-creator` - add context or create skills",
    "",
    "### Diagnostics",
    "- `/debug status|llm|last|save`, `/trace on|off` - inspect internals",
    "",
    "Tip: type `/` to search commands; type `!` before a shell command to run it.",
  ];
}

function getTimelineHelpLines() {
  return [
    "[help] title: PieCode command map",
    "[help] section: Essentials",
    "[help] item: /help, /status, /clear, /compact, /exit - session basics",
    "[help] item: /sessions, /resume <id> - continue previous work",
    "[help] section: Agent workflow",
    "[help] item: /task, /btw <question>, /plan, /goal <task>, /agents - manage long-running work",
    "[help] item: /approve on|off - control shell command approval",
    "[help] section: Model and runtime",
    "[help] item: /model, /model list - switch or inspect models",
    "[help] item: /think <none|minimal|low|medium|high|xhigh|off> - adjust reasoning effort",
    "[help] section: Extensions",
    "[help] item: /skills, /plugins, /mcp - inspect and manage extensions",
    "[help] item: /attach image, /skill-creator - add context or create skills",
    "[help] section: Diagnostics",
    "[help] item: /debug status|llm|last|save, /trace on|off - inspect internals",
    "[help] tip: type / to search commands; type ! before a shell command to run it",
  ];
}

function openHelpOverlay(tui) {
  if (!tui || typeof tui.openOverlay !== "function") return false;
  tui.openOverlay("PieCode command map", getInteractiveHelpLines().join("\n"), {
    mode: "help",
    hint: " j/k: scroll  ctrl-f/b: page  q: close ",
  });
  return true;
}

function printHelp() {
  console.log(`Pie Code - Coding agent

Usage:
  piecode
  piecode --prompt "fix failing test"
  piecode --resume <session-id|short-id>
  piecode --web
  piecode --provider anthropic --api-key "sk-ant-..." --model "claude-3-5-sonnet-latest"
  piecode --help

Options:
  --prompt, -p         One-shot prompt to run
  --resume, -r         Resume a saved session by full or short id
  --help, -h           Show this help
  --provider, -P       Model provider: anthropic, openai, openrouter, codex
  --api-key, -K        API key for the provider
  --model, -M          Model name to use
  --base-url, -B       Base URL for OpenAI-compatible endpoints (default: https://api.openai.com/v1)
  --thinking-effort    Model thinking/reasoning effort (none, minimal, low, medium, high, xhigh)
  --skill, -S          Enable skill by name (repeatable)
  --plugin, -G         Enable plugin by name (repeatable)
  --plugin-install     Install plugin from local directory or git URL and exit
  --plugin-update      Update git-backed plugin by name or "all" and exit
  --plugin-install-project Install plugin into .piecode/plugins instead of ~/.piecode/plugins
  --list-skills        List discovered skills and exit
  --list-plugins       List discovered plugins and exit
  --tui                Start simple full-screen TUI mode (default for interactive use)
  --web                Start browser-based Web UI
  --tmux-subagents     Open a tmux window for each subagent event stream
  --disable-codex      Disable Codex CLI fallback (equivalent to PIECODE_DISABLE_CODEX_CLI=1)

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

  CODEX_HOME           Optional (default ~/.codex)
  CODEX_MODEL          Optional for codex token mode (default gpt-5.3-codex)
  PIECODE_DISABLE_CODEX_CLI Optional (set 1 to disable Codex CLI session fallback)
  PIECODE_CODEX_PREFER_CLI Optional (set 1 to force Codex CLI session fallback)
  PIECODE_ENABLE_PLANNER  Optional (set 1 to enable experimental task planner)
  PIECODE_PLAN_MODE       Optional (set 1 to start in plan-only mode)
  PIECODE_GOAL_MAX_TURNS  Optional /goal loop limit (default 50, range 1-200)
  PIECODE_PLAN_FIRST      Optional (default off; set 1 to enable lightweight pre-plan)
  PIECODE_TOOL_BUDGET     Optional (default 6, range 1-12)
  PIECODE_THINKING_EFFORT Optional model thinking/reasoning effort (alias: PIECODE_REASONING_EFFORT)
  PIECODE_VERBOSE_TOOL_LOGS Optional (set 1 for full tool input details in logs)
  PIECODE_LLM_DEBUG_HISTORY Optional (number of LLM debug entries kept in memory; default 20)
  PIECODE_SETTINGS_FILE Optional (default ~/.piecode/settings.json)
  PIECODE_MCP_IMPORT Optional (default 1; set 0 to disable shared MCP config import)
  PIECODE_MCP_CONFIG_PATHS Optional (comma-separated JSON config paths with mcpServers)
  MCP via settings       Configure mcpServers in ~/.piecode/settings.json (overrides imported configs)
  PIECODE_SKILLS_DIR Optional (comma-separated skill root directories)
  PIECODE_PLUGINS_DIR Optional (comma-separated plugin root directories)
  PIECODE_HISTORY_FILE Optional (default ~/.piecode_history)
  PIECODE_SESSION_EVENTS_FILE Optional JSONL event stream for GUI/remote integrations
  PIECODE_TMUX_SUBAGENTS Optional (set 1 inside tmux to open windows for subagents; writes/tails local JSONL events that may include prompts/tool output)

Auth fallback order:
  1) Command line arguments --provider/--api-key/--model
  2) ~/.piecode/settings.json
  3) Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY)
  4) Codex auth file (~/.codex/auth.json; native tools when token/key is usable)
  5) Codex CLI session fallback (codex login; slower, no native tools)
  Note: Codex OAuth tokens can be scope-limited.

Slash commands in interactive mode:
  /help                Show commands
  /exit                Quit
  /quit                Quit (alias)
  /clear               Clear all turn context (history + todos)
  /compact             Compact older context and keep recent turns
  /sessions            List recent saved sessions
  /resume <id>         Resume a saved session by full or short id
  /status              Show current task/model/subagent status
  /task                List background shell tasks
  /task start [name --] <cmd>
                       Run a shell command in the background
  /task status <id>    Show one background task
  /task read <id>      Show recent background task output
  /task stop <id>      Stop a running background task
  /btw <question>      Run a background strict-read-only side question while the main task continues
  /agents              Show active and recent subagents
  /plan on|off         Toggle plan mode (safe read-only tools allowed; no file changes)
  /plan                Show current plan mode
  /goal <task>         Run a goal-driven loop: clarify, plan, execute, and verify acceptance
  /approve on|off      Toggle shell auto-approval
  /trace on|off        Toggle runtime trace logs (timings/stages)
  /debug               Show debug status, trace/session paths, and recent error/LLM info
  /debug status        Show current debug/session state
  /debug llm           Dump latest LLM request/response payloads
  /debug last          Show the last task summary with error and trace file paths
  /debug save          Force-save the current session trace/log files
  /model               Show active provider/model
                       Tip: use /model codex:gpt-5.3-codex to force Codex provider
  /think <none|minimal|low|medium|high|xhigh|off>
                       Show or set model thinking/reasoning effort and save it to settings
  /mcp                 Show MCP status and usage
  /mcp list            List active MCP servers
  /mcp show <name>     Show one MCP server config
  /mcp add <name> <command> [args...]
                       Add/update local MCP server config
  /mcp remove <name>   Remove local MCP server (or mask imported server)
  /mcp reload          Reload MCP settings from disk
  /mcp import on|off   Toggle shared MCP config import
  /skills              Show active skills
  /skills list         List discovered skills
  /skills commands     List slash commands exposed by skills
  /<skill-command>     Invoke a skill as a custom command
  /skills use <name>   Enable a skill
  /skills off <name>   Disable a skill
  /skills clear        Disable all skills
  /plugins             Show active plugins
  /plugins list        List discovered plugins
  /plugins commands    List slash commands exposed by plugins
  /plugins install <source> [--name <name>] [--project]
                       Install plugin from local directory or git URL
  /plugins update <name|all>
                       Update git-backed plugin(s) with git pull --ff-only
  /plugins use <name>  Enable a plugin
  /plugins off <name>  Disable plugin
  /plugins clear       Disable all plugins
  /use <name>          Alias for /skills use <name>
  /skill-creator       Interactive skill creation tool
  /workspace           Return to workspace timeline view
  /attach image        Attach the current clipboard image to the next prompt
  CTRL+D               Press twice on empty input to exit (TUI mode)
  CTRL+C               Clear current input (TUI mode)
  UP/DOWN              Scroll timeline when input is empty (TUI mode)
  SHIFT+UP/DOWN        Scroll timeline line-by-line (TUI mode)
  PAGEUP/PAGEDOWN      Scroll timeline by page (TUI mode)
  HOME/END             Jump to oldest/newest timeline content (TUI mode)
  CTRL+L               Toggle event log panel (TUI mode)
  CTRL+T               Toggle TODO panel (TUI mode)
  CTRL+O               Open LLM debug panel (TUI mode)
  CTRL+A / CTRL+E      Move cursor to start/end of input (TUI mode)
  ESC (twice)          Abort current running task (TUI mode)
  SHIFT+ENTER / CTRL+J Insert newline in prompt (TUI mode)
  @<file>              Fuzzy-search project files for context (git metadata ignored)

Skill invocation:
  Mention $skill-name in a prompt to auto-enable that skill.
  Skills are also invokable as slash commands, e.g. /openspec <request>.
  Skill frontmatter may define command, aliases, or commands for extra command names.
`);
}

function parseArgs(argv) {
  const args = {
    prompt: null,
    resume: null,
    help: false,
    provider: null,
    apiKey: null,
    model: null,
    baseUrl: null,
    disableCodex: false,
    thinkingEffort: null,
    skills: [],
    plugins: [],
    pluginInstall: "",
    pluginInstallName: "",
    pluginInstallProject: false,
    pluginUpdate: "",
    listSkills: false,
    listPlugins: false,
    listModels: false,
    listProviders: false,
    doctor: false,
    tui: false,
    web: false,
    tmuxSubagents: false,
    watchSubagentEvents: "",
    watchSubagentId: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--prompt" || a === "-p") {
      args.prompt = argv[i + 1] || "";
      i += 1;
    } else if (a === "--resume" || a === "-r") {
      args.resume = argv[i + 1] || "";
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
    } else if (a === "--thinking-effort" || a === "--reasoning-effort") {
      args.thinkingEffort = argv[i + 1] || "";
      i += 1;
    } else if (a === "--disable-codex") {
      args.disableCodex = true;
    } else if (a === "--skill" || a === "-S") {
      args.skills.push(argv[i + 1] || "");
      i += 1;
    } else if (a === "--plugin" || a === "-G") {
      args.plugins.push(argv[i + 1] || "");
      i += 1;
    } else if (a === "--plugin-install") {
      args.pluginInstall = argv[i + 1] || "";
      i += 1;
    } else if (a === "--plugin-install-name" || a === "--plugin-name") {
      args.pluginInstallName = argv[i + 1] || "";
      i += 1;
    } else if (a === "--plugin-install-project") {
      args.pluginInstallProject = true;
    } else if (a === "--plugin-update") {
      args.pluginUpdate = argv[i + 1] || "";
      i += 1;
    } else if (a === "--list-skills") {
      args.listSkills = true;
    } else if (a === "--list-plugins") {
      args.listPlugins = true;
    } else if (a === "--list-models") {
      args.listModels = true;
    } else if (a === "--list-providers" || a === "--providers") {
      args.listProviders = true;
    } else if (a === "--doctor") {
      args.doctor = true;
    } else if (a === "--tui") {
      args.tui = true;
    } else if (a === "--web") {
      args.web = true;
    } else if (a === "--tmux-subagents") {
      args.tmuxSubagents = true;
    } else if (a === "--watch-subagent-events") {
      args.watchSubagentEvents = argv[i + 1] || "";
      i += 1;
    } else if (a === "--subagent-id") {
      args.watchSubagentId = argv[i + 1] || "";
      i += 1;
    }
  }
  return args;
}

function formatJsonMaybe(value) {
  const text = String(value || "");
  if (!text.trim()) return { text: "", parsed: null };
  try {
    const parsed = JSON.parse(text);
    return { text: JSON.stringify(parsed, null, 2), parsed };
  } catch {
    return { text, parsed: null };
  }
}

function collectContentParts(value) {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectContentParts(item));
  if (typeof value !== "object") return [];

  const out = [];
  if (typeof value.text === "string" && value.text.trim()) out.push(value.text.trim());
  if (typeof value.content === "string" && value.content.trim()) out.push(value.content.trim());
  if (typeof value.output_text === "string" && value.output_text.trim()) out.push(value.output_text.trim());
  if (value.message) out.push(...collectContentParts(value.message));
  if (value.delta) out.push(...collectContentParts(value.delta));
  if (value.content && typeof value.content === "object") out.push(...collectContentParts(value.content));
  if (value.output && typeof value.output === "object") out.push(...collectContentParts(value.output));
  if (value.choices && typeof value.choices === "object") out.push(...collectContentParts(value.choices));
  return out;
}

function summarizeResponsePayload(parsed, fallbackUsage = null) {
  const parsedObj = parsed && typeof parsed === "object" ? parsed : null;
  const lines = [];
  const finishReason =
    parsedObj?.stop_reason ||
    parsedObj?.finish_reason ||
    parsedObj?.choices?.[0]?.finish_reason ||
    parsedObj?.response?.stop_reason ||
    "";
  if (finishReason) lines.push(`- finish_reason: ${finishReason}`);

  const usage = parsedObj?.usage || parsedObj?.response?.usage || fallbackUsage || null;
  if (usage && typeof usage === "object") {
    const inTok = usage.input_tokens ?? usage.prompt_tokens ?? usage.tokens_in;
    const outTok = usage.output_tokens ?? usage.completion_tokens ?? usage.tokens_out;
    const totalTok = usage.total_tokens ?? usage.tokens;
    if (inTok != null || outTok != null || totalTok != null) {
      lines.push(`- usage: in=${inTok ?? "-"} out=${outTok ?? "-"} total=${totalTok ?? "-"}`);
    }
  }

  const parts = collectContentParts(parsedObj).filter(Boolean);
  if (parts.length > 0) {
    const merged = parts.join("\n").trim();
    lines.push("- content:");
    lines.push("```text");
    lines.push(merged);
    lines.push("```");
  }
  return lines;
}

function trackLlmDebugEvent(llmHistoryRef, direction, payload) {
  if (!llmHistoryRef || !llmHistoryRef.value) return null;
  const state = llmHistoryRef.value;
  if (!Array.isArray(state.entries)) state.entries = [];
  const maxEntries = Math.max(1, Number.parseInt(process.env.PIECODE_LLM_DEBUG_HISTORY || "20", 10) || 20);
  if (!Number.isFinite(state.seq)) state.seq = 0;
  if (!Number.isFinite(state.index)) state.index = -1;
  const nextId = () => {
    state.seq += 1;
    return state.seq;
  };

  const data = payload && typeof payload === "object" ? payload : {};
  if (direction === "request") {
    const item = { id: nextId(), request: data, response: null, stage: String(data.stage || "") };
    state.entries.push(item);
    if (state.entries.length > maxEntries) state.entries = state.entries.slice(-maxEntries);
    state.index = state.entries.length - 1;
    return item;
  }

  if (direction === "response") {
    let target = null;
    for (let i = state.entries.length - 1; i >= 0; i -= 1) {
      const entry = state.entries[i];
      if (!entry || entry.response) continue;
      if (!entry.stage || entry.stage === String(data.stage || "")) {
        target = entry;
        break;
      }
    }
    if (!target) {
      target = { id: nextId(), request: null, response: data, stage: String(data.stage || "") };
      state.entries.push(target);
      if (state.entries.length > maxEntries) state.entries = state.entries.slice(-maxEntries);
      target = state.entries[state.entries.length - 1];
    } else {
      target.response = data;
    }
    state.index = state.entries.length - 1;
    return target;
  }

  return null;
}

function appendThinkingToLlmDebugEvent(llmHistoryRef, stage, delta) {
  if (!llmHistoryRef?.value || !delta) return null;
  const state = llmHistoryRef.value;
  if (!Array.isArray(state.entries) || state.entries.length === 0) return null;
  const targetStage = String(stage || "");
  let target = null;
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (!entry) continue;
    if (!targetStage || !entry.stage || entry.stage === targetStage) {
      target = entry;
      break;
    }
  }
  if (!target) return null;
  const nextChunk = sanitizeThinkingChunk(delta);
  if (!nextChunk) return target;
  const previous = String(target.thinking || "");
  const needsSpace =
    previous.length > 0 &&
    !/\s$/.test(previous) &&
    !/^[\s.,;:!?]/.test(nextChunk);
  target.thinking = `${previous}${needsSpace ? " " : ""}${nextChunk}`;
  return target;
}

function summarizeDebugPayloadSize(item) {
  const chars = Number(item?.chars) || String(item?.payload || "").length;
  return chars > 0 ? `${formatCompactNumber(chars)} chars` : "empty";
}

function summarizeDebugUsage(item) {
  const usage = normalizeTokenUsage(item?.usage);
  if (!usage) return "usage: -";
  const input = usage.input_tokens != null ? formatCompactNumber(usage.input_tokens) : "-";
  const output = usage.output_tokens != null ? formatCompactNumber(usage.output_tokens) : "-";
  const total = usage.total_tokens != null ? formatCompactNumber(usage.total_tokens) : "-";
  return `usage: in=${input} out=${output} total=${total}`;
}

function renderLlmDebugEntry(entry, position, total) {
  const req = entry?.request || null;
  const res = entry?.response || null;
  const thinking = String(entry?.thinking || "");
  const stage = req?.stage || res?.stage || entry?.stage || "-";
  const provider = req?.provider || res?.provider || "-";
  const model = req?.model || res?.model || "-";
  const lines = ["## LLM Debug Dump"];
  lines.push(
    "",
    `Entry: ${position}/${total} · stage=${stage} · provider=${provider} · model=${model}`,
    `Overview: request ${req ? summarizeDebugPayloadSize(req) : "missing"} · thinking ${thinking ? `${formatCompactNumber(thinking.length)} chars` : "empty"} · response ${res ? summarizeDebugPayloadSize(res) : "missing"} · ${summarizeDebugUsage(res || req)}`,
    "Sections: Request · Thinking Output · Response Key Content · Response Raw"
  );

  if (req) {
    const formattedReq = formatJsonMaybe(String(req.payload || ""));
    lines.push(
      "",
      `Request: stage=${req.stage || "-"} provider=${req.provider || "-"} model=${req.model || "-"} endpoint=${req.endpoint || "-"}`,
      "```text",
      formattedReq.text,
      "```"
    );
  } else {
    lines.push("", "Request: <none>");
  }

  if (thinking) {
    lines.push("", "Thinking Output:", "```text", thinking, "```");
  } else {
    lines.push("", "Thinking Output: <none>");
  }
  if (res) {
    const formattedRes = formatJsonMaybe(String(res.payload || ""));
    const keySummary = summarizeResponsePayload(formattedRes.parsed, res.usage || null);
    lines.push(
      "",
      `Response: stage=${res.stage || "-"} provider=${res.provider || "-"} model=${res.model || "-"} endpoint=${res.endpoint || "-"}`
    );
    if (keySummary.length > 0) {
      lines.push("", "Response Key Content:", ...keySummary);
    }
    lines.push(
      "",
      "Response Raw:",
      "```text",
      formattedRes.text,
      "```"
    );
  } else {
    lines.push("", "Response: <none>");
  }
  return lines.join("\n");
}

function openLlmDebugOverlay({ tui, llmHistoryRef, llmLastRef, logLine }) {
  let entries = Array.isArray(llmHistoryRef?.value?.entries) ? llmHistoryRef.value.entries : [];
  if (entries.length === 0) {
    const req = llmLastRef?.value?.request || null;
    const res = llmLastRef?.value?.response || null;
    if (!req && !res) {
      if (tui && typeof tui.openOverlay === "function") {
        tui.openOverlay("LLM Debug", "No LLM request/response captured yet.\n\nRun a model task, then press CTRL+O again.", {
          mode: "llm-debug",
          hint: " q: close ",
        });
        return true;
      }
      if (typeof logLine === "function") logLine("no llm request/response captured yet");
      return false;
    }
    if (req) trackLlmDebugEvent(llmHistoryRef, "request", req);
    if (res) trackLlmDebugEvent(llmHistoryRef, "response", res);
    entries = Array.isArray(llmHistoryRef?.value?.entries) ? llmHistoryRef.value.entries : [];
  }
  if (entries.length === 0) {
    if (tui && typeof tui.openOverlay === "function") {
      tui.openOverlay("LLM Debug", "No LLM request/response captured yet.\n\nRun a model task, then press CTRL+O again.", {
        mode: "llm-debug",
        hint: " q: close ",
      });
      return true;
    }
    if (typeof logLine === "function") logLine("no llm request/response captured yet");
    return false;
  }
  const selected = Math.max(0, Math.min(entries.length - 1, Number(llmHistoryRef.value.index) || entries.length - 1));
  llmHistoryRef.value.index = selected;
  const payload = renderLlmDebugEntry(entries[selected], selected + 1, entries.length);
  if (tui && typeof tui.openOverlay === "function") {
    tui.openOverlay(`LLM Debug ${selected + 1}/${entries.length}`, payload, {
      mode: "llm-debug",
      hint: " /:search  n/p: entry  ctrl-n/p: section  j/k: scroll  J/K: req/resp  g: section end  ctrl-f/b: page  q: close ",
    });
  } else if (typeof logLine === "function") {
    logLine(`[response] ${payload}`);
  }
  return true;
}

export function createTuiKeypressSource({ input }) {
  readlineCore.emitKeypressEvents(input);
  const wasRaw = Boolean(input?.isRaw);
  const setRawMode = (enabled) => {
    try {
      if (input?.isTTY && typeof input.setRawMode === "function") {
        input.setRawMode(Boolean(enabled));
      }
    } catch {
      // best effort
    }
  };
  setRawMode(true);
  return {
    source: input,
    suspend: () => setRawMode(false),
    resume: () => setRawMode(true),
    destroy: () => {
      if (!wasRaw) setRawMode(false);
    },
  };
}

export function isSuspendKey(str, key = {}) {
  return Boolean(key?.ctrl && String(key?.name || "").toLowerCase() === "z") || str === "\x1a";
}

function createLogger(tui, display, getInput = () => "", onLogLine = null, sessionBus = null) {
  return (line) => {
    if (typeof onLogLine === "function") onLogLine(line);
    if (sessionBus && typeof sessionBus.emit === "function") {
      sessionBus.emit("log.line", { line: String(line || "") });
    }
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

function sanitizeThinkingChunk(raw) {
  const source = String(raw || "");
  if (!source.trim()) return "";

  // Ignore explicit tool-call metadata payload.
  if (
    /"tool_calls"\s*:|"function"\s*:|"arguments"\s*:|"tool_call_id"\s*:|"tool_use_id"\s*:/i.test(source)
  ) {
    return "";
  }

  // Remove small JSON argument objects that can leak during tool-call streaming.
  let text = source.replace(/\{[^{}]{0,240}\}/g, (match) => {
    if (
      /"?(path|command|tool|server|uri|input|oldText|newText|content|regex|query)"?\s*:/i.test(match)
    ) {
      return " ";
    }
    return match;
  });

  // Remove dangling partial JSON fragments, e.g. {"path": "
  if (/^\s*\{\s*"?[a-z_][a-z0-9_]*"?\s*:\s*"?\s*$/i.test(text.trim())) return "";
  text = text.replace(/\s*\{\s*"?[a-z_][a-z0-9_]*"?\s*:\s*"?\s*$/i, "");

  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (!/[A-Za-z]/.test(text)) return "";
  return text;
}

function summarizeThinkingResponseForLog(payload) {
  const text = String(payload || "").replace(/\s+/g, " ").trim();
  if (!text) return "<empty>";
  if (/"tool_calls"\s*:/i.test(text)) {
    const fn =
      text.match(/"function"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]+)"/i)?.[1] ||
      text.match(/"tool"\s*:\s*"([^"\\]+)"/i)?.[1] ||
      "";
    return fn ? `native tool call prepared: ${fn}` : "native tool call prepared";
  }
  return summarizeForLog(text);
}

function formatToolInputSummary(tool, input, maxLen = 120) {
  const safe = input && typeof input === "object" ? input : {};
  if (tool === "clarify_user") {
    const count = Array.isArray(safe.options) ? safe.options.length : 0;
    return summarizeForLog(`${safe.multiple ? "multi" : "single"} ${count} options: ${safe.question || ""}`, maxLen);
  }
  if (tool === "shell") {
    return summarizeForLog(safe.command || "", maxLen);
  }
  if (tool === "read_file" || tool === "write_file" || tool === "edit_file" || tool === "apply_patch") {
    return summarizeForLog(safe.path || "", maxLen);
  }
  if (tool === "read_files") {
    const count = Array.isArray(safe.paths) ? safe.paths.length : 0;
    const paths = Array.isArray(safe.paths) ? safe.paths.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const shown = paths.slice(0, 3).join(", ");
    const more = paths.length > 3 ? ` +${paths.length - 3}` : "";
    return summarizeForLog(shown ? `${shown}${more}` : `${count} paths`, maxLen);
  }
  if (tool === "replace_in_files") {
    return summarizeForLog(`${safe.file_pattern || "**/*"} :: ${safe.find || ""}`, maxLen);
  }
  if (tool === "list_files") {
    return summarizeForLog(safe.path || ".", maxLen);
  }
  if (tool === "glob_files") {
    return summarizeForLog(`${safe.path || "."} ${safe.pattern || "**/*"}`, maxLen);
  }
  if (tool === "find_files") {
    return summarizeForLog(`${safe.path || "."} ${safe.query || ""}`, maxLen);
  }
  if (tool === "web_search" || tool === "search_web") {
    return summarizeForLog(safe.query || safe.q || "", maxLen);
  }
  if (tool === "rg" || tool === "grep" || tool === "search_files") {
    const pattern = safe.pattern || safe.regex || safe.query || "";
    const scope = safe.path || safe.glob || safe.file_pattern || "";
    const mode = safe.fixed_strings ? "fixed" : safe.case_sensitive === false ? "ignore-case" : "";
    return summarizeForLog(`${pattern}${scope ? ` in ${scope}` : ""}${mode ? ` (${mode})` : ""}`, maxLen);
  }
  if (tool === "subagent") {
    return summarizeForLog(safe.task || "", maxLen);
  }
  if (tool === "git_status") {
    return Boolean(safe.porcelain) ? "porcelain" : "full";
  }
  if (tool === "git_diff") {
    return summarizeForLog(`${safe.staged ? "--staged " : ""}${safe.path || ""}`, maxLen);
  }
  if (tool === "run_tests") {
    return summarizeForLog(safe.command || "npm test", maxLen);
  }
  if (tool === "todo_write" || tool === "todowrite") {
    const count = Array.isArray(safe.todos) ? safe.todos.length : 0;
    return `${count} todos`;
  }
  return summarizeForLog(JSON.stringify(safe), maxLen);
}

function formatReadableToolRunLine(tool, input = {}) {
  const name = String(tool || "tool");
  const summary = formatToolInputSummary(name, input, 180);
  const suffix = summary && summary !== "<empty>" ? ` ${summary}` : "";
  switch (name) {
    case "clarify_user":
      return `[ask] ${summary || "clarification"}`;
    case "shell":
      return `[run] ${summary || "shell command"}`;
    case "read_file":
      return `[run] read ${summary || "file"}`;
    case "read_files":
      return `[run] read ${summary || "files"}`;
    case "list_files":
      return `[run] list ${summary || "."}`;
    case "glob_files":
      return `[run] glob ${summary || "**/*"}`;
    case "find_files":
      return `[run] find ${summary || "files"}`;
    case "rg":
    case "grep":
    case "search_files":
      return `[run] search ${summary || "workspace"}`;
    case "git_status":
      return "[run] git status";
    case "git_diff":
      return `[run] git diff${suffix}`;
    case "run_tests":
      return `[run] test ${summary || "npm test"}`;
    case "edit_file":
      return `[run] edit ${summary || "file"}`;
    case "write_file":
      return `[run] write ${summary || "file"}`;
    case "apply_patch":
      return `[run] apply patch${suffix}`;
    case "replace_in_files":
      return `[run] replace ${summary || "in files"}`;
    case "web_search":
    case "search_web":
      return `[run] web search ${summary || ""}`.trimEnd();
    case "subagent":
      return `[run] subagent ${summary || ""}`.trimEnd();
    default:
      return `[run] ${name}${suffix}`;
  }
}

function formatToolBatchSummary(calls = [], maxLen = 180) {
  const list = Array.isArray(calls) ? calls : [];
  if (list.length === 0) return "0 tools";
  const counts = new Map();
  for (const call of list) {
    const tool = String(call?.tool || "tool");
    counts.set(tool, (counts.get(tool) || 0) + 1);
  }
  const names = [...counts.entries()].map(([tool, count]) => `${tool}${count > 1 ? ` x${count}` : ""}`).join(", ");
  const previews = list
    .map((call) => {
      const tool = String(call?.tool || "tool");
      const summary = formatToolInputSummary(call?.tool, call?.input, 70);
      return summary && summary !== "<empty>" ? `${tool}(${summary})` : tool;
    })
    .filter(Boolean)
    .slice(0, 3);
  const suffix = previews.length > 0 ? ` - ${previews.join("; ")}` : "";
  return summarizeForLog(`${names}${suffix}`, maxLen);
}

const TOOL_RESULT_DIFF_MAX_LINES = 80;

function truncateDiffTextForTimeline(value, { maxLines = TOOL_RESULT_DIFF_MAX_LINES } = {}) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const limit = Math.max(1, Number(maxLines) || TOOL_RESULT_DIFF_MAX_LINES);
  if (lines.length <= limit) return lines.join("\n");
  return `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more diff lines)`;
}

function formatToolResultLinesForTimeline(tool, result, error) {
  if (error) return [];
  const name = String(tool || "");
  const raw = String(result || "").trim();
  if (!raw) return [];

  if (name === "shell" || name === "run_tests") {
    const lines = raw.split("\n");
    const exit = lines.find((line) => /^exit_code:\s*/i.test(line))?.replace(/^exit_code:\s*/i, "").trim();
    const success = !exit || exit === "0";
    const tooLong = raw.match(/^Result too long[^\n]*/i)?.[0] || "";
    const previewIdx = lines.findIndex((line) => /^Preview:\s*$/i.test(line));
    const stdoutIdx = lines.findIndex((line) => /^stdout:\s*$/i.test(line));
    const stderrIdx = lines.findIndex((line) => /^stderr:\s*$/i.test(line));
    let bodyLines = [];
    if (previewIdx >= 0) {
      bodyLines = lines.slice(previewIdx + 1);
    } else if (stdoutIdx >= 0) {
      const stdoutEnd = stderrIdx > stdoutIdx ? stderrIdx : lines.length;
      bodyLines = lines.slice(stdoutIdx + 1, stdoutEnd);
      if (bodyLines.join("").trim().length === 0 && stderrIdx >= 0) bodyLines = lines.slice(stderrIdx + 1);
    } else {
      bodyLines = lines.filter((line) => !/^exit_code:\s*/i.test(line));
    }
    const preview = bodyLines.map((line) => line.trimEnd()).filter(Boolean).slice(0, 4);
    const out = [];
    if (tooLong) out.push(`[tool-result] ${success ? "✓" : "✗"} ${tooLong}${exit ? ` (${success ? "success" : `exit ${exit}`})` : ""}`);
    else if (!success) out.push(`[tool-result] ✗ ${exit ? `exit ${exit}` : name === "run_tests" ? "tests failed" : "command failed"}`);
    else if (preview.length === 0) out.push(`[tool-result] ✓ ${name === "run_tests" ? "tests passed" : "command succeeded"}`);
    for (const line of preview) out.push(`[tool-result]   ${summarizeForLog(line, 220)}`);
    if (bodyLines.filter(Boolean).length > preview.length) {
      out.push(`[tool-result]   ... (${bodyLines.filter(Boolean).length - preview.length} more lines)`);
    }
    return out;
  }

  if (name === "rg" || name === "grep" || name === "search_files") {
    if (/^No matches found/i.test(raw) || /^No files matched/i.test(raw)) {
      return [`[tool-result] ${summarizeForLog(raw.split("\n")[0], 180)}`];
    }
    const found = raw.match(/^Found matches in\s+(\d+)\s+files?\s+for\s+"([^"]+)"/i);
    if (found) return [`[tool-result] Found matches in ${found[1]} files for "${found[2]}"`];
    const files = [];
    for (const line of raw.split("\n")) {
      const file = line.match(/^([^:\n]+):\d+:/)?.[1] || line.match(/^([^:\n]+):/)?.[1] || "";
      if (file && !files.includes(file)) files.push(file);
      if (files.length >= 6) break;
    }
    if (files.length > 0) {
      const shown = files.slice(0, 4).join(", ");
      const more = files.length > 4 ? ` +${files.length - 4}` : "";
      return [`[tool-result] Matches in ${shown}${more}`];
    }
    return [];
  }

  if (name === "git_diff") {
    const files = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^diff --git a\/(.+?) b\//);
      if (match?.[1] && !files.includes(match[1])) files.push(match[1]);
      if (files.length >= 6) break;
    }
    if (/^diff --git\b|^# (?:Staged|Unstaged|Untracked) changes\b/im.test(raw)) {
      return [`[tool-result] ${truncateDiffTextForTimeline(raw)}`];
    }
    if (files.length > 0) {
      const shown = files.slice(0, 4).join(", ");
      const more = files.length > 4 ? ` +${files.length - 4}` : "";
      return [`[tool-result] Diff includes ${shown}${more}`];
    }
    return [];
  }

  if (name === "git_status") {
    const lines = raw.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(0, 8);
    if (lines.length === 0) return [];
    return lines.map((line) => `[tool-result] ${summarizeForLog(line, 220)}`);
  }

  if (name === "write_file" || name === "write") {
    const wrote = raw.match(/^Wrote\s+(\d+)\s+bytes\s+to\s+(.+)$/i);
    if (wrote) return [`[tool-result] Wrote ${wrote[1]} bytes to ${wrote[2]}`];
    return [`[tool-result] ${summarizeForLog(raw.split("\n")[0], 220)}`];
  }

  if (name !== "edit_file") return [];

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const lines = [];

    const message = String(parsed?.message || "").trim();
    if (message) lines.push(`[tool-result] ${message}`);

    const diffStat = String(parsed?.details?.diffStat || "").trim();
    if (diffStat) lines.push(`[tool-result] ${diffStat}`);

    return lines;
  } catch {
    return [];
  }
}

function estimateTokenCount(text) {
  const s = String(text || "");
  if (!s) return 0;
  // Heuristic: average ~4 chars/token for mixed code + English prompts.
  return Math.max(1, Math.round(s.length / 4));
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = toPositiveInt(raw.input_tokens ?? raw.prompt_tokens ?? raw.tokens_in);
  const output = toPositiveInt(raw.output_tokens ?? raw.completion_tokens ?? raw.tokens_out);
  const total = toPositiveInt(raw.total_tokens ?? raw.tokens);
  const usage = {};
  if (input != null) usage.input_tokens = input;
  if (output != null) usage.output_tokens = output;
  if (total != null) usage.total_tokens = total;
  if (usage.total_tokens == null && usage.input_tokens != null && usage.output_tokens != null) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : null;
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

async function runDirectShellCommand(command, { workspaceDir, logLine, tui, display, signal = null } = {}) {
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
      signal,
    });
    const preview = formatDirectShellOutput(stdout, stderr);
    if (preview) logLine(`[response] ${preview}`);
    const durationMs = Date.now() - startedAt;
    logLine(`[result] shell done | time: ${formatReadableDuration(durationMs)}`);
    if (tui) tui.onThinkingDone();
    if (display) display.onToolEnd("shell", preview || "<empty>", null);
    return { ok: true };
  } catch (err) {
    if (isTaskAbortError(err)) {
      const durationMs = Date.now() - startedAt;
      logLine(`[result] shell aborted | time: ${formatReadableDuration(durationMs)}`);
      if (tui) tui.onThinkingDone();
      if (display) display.onToolEnd("shell", "<aborted>", "aborted by user");
      return { ok: false, aborted: true, error: "aborted by user" };
    }
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

function maybeHandleLocalInfoTask(input, { logLine, tui, display, mcpHub = null } = {}) {
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
    "- `read_files`: Read multiple files in one call",
    "- `write_file`: Write a file",
    "- `edit_file`: Surgical in-file replacement using oldText/newText unique match",
    "- `apply_patch`: Legacy alias (prefer `edit_file`)",
    "- `replace_in_files`: Preview/apply bulk replacements",
    "- `list_files`: List files/directories",
    "- `glob_files`: Find files by glob pattern",
    "- `find_files`: Fuzzy-find files by path text",
    "- `rg`: Search file contents with ripgrep semantics",
    "- `grep`: Alias for `rg`",
    "- `search_files`: Compatibility alias for `rg`",
    "- `web_search`: Search the web using Brave/Tavily/Serper",
    "- `search_web`: Alias for `web_search`",
    "- `git_status`: Show git status",
    "- `git_diff`: Show git diff",
    "- `run_tests`: Run tests with structured summary",
    "- `todo_write` / `todowrite`: Update task todo list",
  ];
  if (mcpHub && typeof mcpHub.hasServers === "function" && mcpHub.hasServers()) {
    const names = mcpHub.getServerNames();
    lines.push("- `list_mcp_servers`: List configured MCP servers");
    lines.push("- `list_mcp_tools`: List tools exposed by MCP servers");
    lines.push("- `mcp_call_tool`: Call a specific MCP tool");
    lines.push("- `list_mcp_resources`: List resources from MCP servers");
    lines.push("- `list_mcp_resource_templates`: List resource templates from MCP servers");
    lines.push("- `read_mcp_resource`: Read a resource by URI from an MCP server");
    if (names.length > 0) lines.push(`- MCP servers: ${names.join(", ")}`);
  }
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

function formatStageUpdate(text, maxLen = 220) {
  const source = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:short\s+progress\s+update|progress\s+update|progress|thinking|thought|reason)\s*:\s*/i, "")
    .trim();
  if (!source) return "";
  return source.length > maxLen ? `${source.slice(0, maxLen - 3)}...` : source;
}

function extractReadableThinkingPreview(raw) {
  const source = String(raw || "");
  const thought = extractThoughtContentFromPartialJson(source);
  if (thought) return formatStageUpdate(sanitizeThinkingChunk(thought));

  const compact = source.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  const reasonMatch = compact.match(
    /"(reason|summary|rationale)"\s*:\s*"((?:[^"\\]|\\.)*)"/i
  );
  if (reasonMatch?.[2]) {
    return formatStageUpdate(
      reasonMatch[2]
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
    );
  }

  const toolMatch = compact.match(/"tool"\s*:\s*"([^"\\]+)"/i);
  if (toolMatch?.[1]) return `Preparing tool: ${toolMatch[1]}`;

  const readableSentences = compact
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => formatStageUpdate(sanitizeThinkingChunk(part), 180))
    .filter((part) => {
      if (!part) return false;
      if (/^[{\["',:}\]\s]+$/.test(part)) return false;
      if (/^(type|tool|input|arguments|function|tool_calls)\b/i.test(part)) return false;
      if (/[{}\[\]]/.test(part) && /"[a-z_][a-z0-9_]*"\s*:/i.test(part)) return false;
      return /[A-Za-z\u4e00-\u9fff]/.test(part);
    });
  if (readableSentences.length > 0) return readableSentences[readableSentences.length - 1];

  return "";
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

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normalizeModelKey(value) {
  return String(value || "").trim().toLowerCase();
}

function inferContextWindow(modelName) {
  const model = normalizeModelKey(modelName);
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (model.includes("gpt-5")) return 256000;
  if (model.includes("gpt-4.1")) return 128000;
  if (model.includes("gpt-4o")) return 128000;
  if (model.includes("claude-3.7")) return 200000;
  if (model.includes("claude-3.5")) return 200000;
  if (model.includes("claude-3")) return 200000;
  if (model.includes("deepseek")) return 128000;
  return DEFAULT_CONTEXT_WINDOW;
}

function extractContextWindowValue(input) {
  const direct = toPositiveInt(input);
  if (direct != null) return direct;
  if (!input || typeof input !== "object") return null;
  const keys = [
    "contextWindow",
    "context_window",
    "contextLength",
    "context_length",
    "maxContextLength",
    "max_context_length",
    "maxInputTokens",
    "max_input_tokens",
    "inputTokenLimit",
    "input_token_limit",
  ];
  for (const key of keys) {
    const value = toPositiveInt(input?.[key]);
    if (value != null) return value;
  }
  return null;
}

function registerContextWindow(targetMap, modelId, value) {
  if (!(targetMap instanceof Map)) return;
  const contextWindow = extractContextWindowValue(value);
  if (contextWindow == null) return;
  const raw = normalizeModelKey(modelId);
  if (!raw) return;
  const parsed = parseModelTarget(raw);
  const bare = normalizeModelKey(parsed.model || raw);
  targetMap.set(raw, contextWindow);
  if (bare && bare !== raw) targetMap.set(bare, contextWindow);
  if (parsed.provider && bare) {
    targetMap.set(`${parsed.provider}:${bare}`, contextWindow);
  }
}

function registerProviderContextWindow(targetMap, providerName, value) {
  if (!(targetMap instanceof Map)) return;
  const contextWindow = extractContextWindowValue(value);
  if (contextWindow == null) return;
  const provider = normalizeModelKey(providerName);
  if (!provider) return;
  targetMap.set(provider, contextWindow);
}

function registerContextWindowCandidates(targetMap, candidate, providerHint = "") {
  if (!candidate || typeof candidate !== "object") return;
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (!item || typeof item !== "object") continue;
      const modelId = String(item.id || item.model || item.name || item.slug || "").trim();
      if (!modelId) continue;
      if (providerHint) {
        registerContextWindow(targetMap, `${providerHint}:${modelId}`, item);
      }
      registerContextWindow(targetMap, modelId, item);
    }
    return;
  }
  for (const [modelId, value] of Object.entries(candidate)) {
    if (providerHint) {
      registerContextWindow(targetMap, `${providerHint}:${modelId}`, value);
    }
    registerContextWindow(targetMap, modelId, value);
  }
}

function collectContextWindowHints(settings = {}) {
  const byModel = new Map();
  const byProvider = new Map();
  const globalCandidates = [
    settings?.contextWindowByModel,
    settings?.contextWindows,
    settings?.modelContextWindows,
    settings?.models,
  ];
  for (const candidate of globalCandidates) {
    registerContextWindowCandidates(byModel, candidate);
  }
  if (settings?.model && settings?.contextWindow != null) {
    registerContextWindow(byModel, settings.model, settings.contextWindow);
  }

  const providers =
    settings?.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
      ? settings.providers
      : {};
  for (const [providerName, providerSettings] of Object.entries(providers)) {
    if (!providerSettings || typeof providerSettings !== "object") continue;
    registerProviderContextWindow(byProvider, providerName, providerSettings.contextWindow);
    registerProviderContextWindow(byProvider, providerName, providerSettings.context_length);
    if (providerSettings.model && providerSettings.contextWindow != null) {
      registerContextWindow(byModel, `${providerName}:${providerSettings.model}`, providerSettings.contextWindow);
      registerContextWindow(byModel, providerSettings.model, providerSettings.contextWindow);
    }
    const providerCandidates = [
      providerSettings.contextWindowByModel,
      providerSettings.contextWindows,
      providerSettings.modelContextWindows,
      providerSettings.models,
    ];
    for (const candidate of providerCandidates) {
      registerContextWindowCandidates(byModel, candidate, providerName);
    }
  }

  return { byModel, byProvider };
}

function applyContextWindowMetadata(targetMap, contextByModel = {}, providerHint = "") {
  if (!(targetMap instanceof Map) || !contextByModel || typeof contextByModel !== "object") return;
  for (const [modelId, value] of Object.entries(contextByModel)) {
    if (providerHint) {
      registerContextWindow(targetMap, `${providerHint}:${modelId}`, value);
    }
    registerContextWindow(targetMap, modelId, value);
  }
}

function resolveContextWindow({ modelName, providerName = "", settings = {}, dynamicByModel = null } = {}) {
  const fallback = inferContextWindow(modelName);
  const normalizedModel = normalizeModelKey(modelName);
  if (!normalizedModel) return fallback;

  const parsed = parseModelTarget(normalizedModel);
  const bareModel = normalizeModelKey(parsed.model || normalizedModel);
  const parsedProvider = normalizeModelKey(parsed.provider || "");
  const hintedProvider = normalizeModelKey(providerName || "");
  const candidates = [];
  const pushCandidate = (value) => {
    const key = normalizeModelKey(value);
    if (!key || candidates.includes(key)) return;
    candidates.push(key);
  };

  pushCandidate(normalizedModel);
  pushCandidate(bareModel);
  if (parsedProvider && bareModel) pushCandidate(`${parsedProvider}:${bareModel}`);
  if (hintedProvider && bareModel) pushCandidate(`${hintedProvider}:${bareModel}`);
  if (hintedProvider && normalizedModel && !normalizedModel.includes(":")) {
    pushCandidate(`${hintedProvider}:${normalizedModel}`);
  }

  const lookupModelMap = (map) => {
    if (!(map instanceof Map)) return null;
    for (const key of candidates) {
      const value = toPositiveInt(map.get(key));
      if (value != null) return value;
    }
    return null;
  };

  const dynamicMap = dynamicByModel instanceof Map ? dynamicByModel : null;
  const dynamicHit = lookupModelMap(dynamicMap);
  if (dynamicHit != null) return dynamicHit;

  const hints = collectContextWindowHints(settings);
  const settingsHit = lookupModelMap(hints.byModel);
  if (settingsHit != null) return settingsHit;

  const providerCandidates = [];
  const pushProvider = (value) => {
    const key = normalizeModelKey(value);
    if (!key || providerCandidates.includes(key)) return;
    providerCandidates.push(key);
  };
  pushProvider(hintedProvider);
  pushProvider(parsedProvider);
  for (const key of providerCandidates) {
    const value = toPositiveInt(hints.byProvider.get(key));
    if (value != null) return value;
  }

  // The shared registry knows context windows for every curated model.
  for (const key of candidates) {
    const value = toPositiveInt(getCatalogContextWindow(key));
    if (value != null) return value;
  }

  return fallback;
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

async function waitForTuiApproval({ stdinStream, defaultYes }) {
  return new Promise((resolve) => {
    const handler = (_str, key = {}) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") {
        stdinStream.off("keypress", handler);
        resolve(defaultYes ? "allow_once" : "deny");
        return;
      }
      if (key.name === "y") {
        stdinStream.off("keypress", handler);
        resolve("allow_once");
        return;
      }
      if (key.name === "r") {
        stdinStream.off("keypress", handler);
        resolve("remember_command");
        return;
      }
      if (key.name === "a") {
        stdinStream.off("keypress", handler);
        resolve("allow_all_session");
        return;
      }
      if (key.name === "n") {
        stdinStream.off("keypress", handler);
        resolve("deny");
      }
    };
    stdinStream.on("keypress", handler);
  });
}

function normalizeClarificationOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option, index) => {
      if (typeof option === "string") {
        const label = option.trim();
        return label ? { id: `option-${index + 1}`, label, value: label, description: "" } : null;
      }
      if (!option || typeof option !== "object") return null;
      const label = String(option.label || option.title || option.name || option.value || option.id || "").trim();
      if (!label) return null;
      return {
        id: String(option.id || `option-${index + 1}`),
        label,
        value: option.value ?? option.id ?? label,
        description: String(option.description || option.detail || "").trim(),
      };
    })
    .filter(Boolean);
}

function makeClarificationSelection(options, selectedIndexes) {
  const list = normalizeClarificationOptions(options);
  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((idx) => ({
      index: idx,
      id: list[idx]?.id || `option-${idx + 1}`,
      label: list[idx]?.label || "",
      value: list[idx]?.value ?? list[idx]?.label ?? "",
      description: list[idx]?.description || "",
    }))
    .filter((item) => item.label);
}

async function waitForTuiClarification({ stdinStream, tui, question, options, multiple = false, required = true }) {
  const list = normalizeClarificationOptions(options);
  if (list.length === 0) return { cancelled: true, selected: [] };
  const state = {
    question: String(question || "").trim(),
    options: list,
    multiple: Boolean(multiple),
    index: 0,
    selected: new Set(Boolean(multiple) ? [] : [0]),
  };
  const render = () => tui?.setClarificationPrompt?.(state);
  render();
  return new Promise((resolve) => {
    const finish = (cancelled = false) => {
      stdinStream.off("keypress", handler);
      tui?.clearClarificationPrompt?.();
      if (cancelled) {
        resolve({ cancelled: true, selected: [] });
        return;
      }
      const selectedIndexes = multiple ? state.selected : new Set([state.index]);
      resolve({ cancelled: false, selected: makeClarificationSelection(list, selectedIndexes) });
    };
    const handler = (str, key = {}) => {
      const name = String(key?.name || "").toLowerCase();
      if (name === "escape") return finish(true);
      if (name === "up" || name === "down") {
        const delta = name === "up" ? -1 : 1;
        state.index = (state.index + delta + list.length) % list.length;
        if (!multiple) state.selected = new Set([state.index]);
        render();
        return;
      }
      if (multiple && (name === "space" || str === " ")) {
        if (state.selected.has(state.index)) state.selected.delete(state.index);
        else state.selected.add(state.index);
        render();
        return;
      }
      if (name === "return" || name === "enter" || str === "\r" || str === "\n") {
        if (required && multiple && state.selected.size === 0) {
          tui?.setInputHint?.("Select at least one option, or press ESC to cancel.");
          render();
          return;
        }
        finish(false);
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

function applyTodoState(todosRef, todos, { sessionBus = null, tui = null, autoTrackRef = null, autoTrack = null } = {}) {
  if (!todosRef) return [];
  const normalized = normalizeTodos(todos);
  todosRef.value = normalized;
  if (autoTrackRef && typeof autoTrack === "boolean") autoTrackRef.value = autoTrack;
  sessionBus?.emit?.("todos.update", { todos: normalized });
  if (tui && typeof tui.setTodos === "function") tui.setTodos(normalized);
  return normalized;
}

function formatResumeCommand(sessionId, { binary = "piecode" } = {}) {
  const id = String(sessionId || "").trim();
  const command = `${String(binary || "piecode").trim() || "piecode"} --resume ${id}`;
  return { id, shortId: shortSessionId(id), command };
}

function formatSessionExitSummary(session) {
  const sessionId = String(session?.sessionId || "").trim();
  if (!sessionId) return [];
  const resume = formatResumeCommand(sessionId);
  return [
    `[session] id: ${sessionId}`,
    `[session] quick resume: ${resume.command}`,
  ];
}

function formatSessionListForDisplay(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (list.length === 0) return "No resumable sessions yet.";
  return [
    "## Recent Sessions",
    ...list.map((item, index) => {
      const resume = formatResumeCommand(item.sessionId);
      const shortId = item.shortId || resume.shortId;
      const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "unknown time";
      return `${index + 1}. \`${shortId}\` — ${item.summary || "PieCode session"}\n   ${updated} · ${item.messageCount || 0} messages · ${item.toolCount || 0} tools\n   Resume: \`/resume ${shortId}\`, \`/resume ${item.sessionId}\`, or \`${resume.command}\``;
    }),
  ].join("\n");
}

async function saveCliResumableSession({ workspaceDir, taskTraceRef, agent, todosRef, providerRef, logLine = null, force = false }) {
  if (!agent || !Array.isArray(agent.history)) return null;
  if (agent.history.length === 0 && !force) return null;
  const messages = agent.history
    .filter((msg) => msg?.role === "user" || msg?.role === "assistant")
    .map((msg, index) => ({
      id: `msg-${index + 1}`,
      type: "message",
      role: msg.role,
      content: String(msg.content || ""),
      at: new Date().toISOString(),
    }));
  const sessionId = taskTraceRef?.sessionId || makeSessionId();
  if (taskTraceRef && !taskTraceRef.sessionId) taskTraceRef.sessionId = sessionId;
  const saved = await saveResumableSession(workspaceDir, {
    sessionId,
    providerLabel: providerRef?.value ? formatProviderModel(providerRef.value) : "",
    messages,
    timeline: messages,
    todos: todosRef?.value || [],
    agentHistory: agent.history,
  });
  const shortId = shortSessionId(saved.sessionId);
  if (typeof logLine === "function") {
    const resume = formatResumeCommand(saved.sessionId);
    logLine(`[session] saved ${saved.sessionId}`);
    logLine(`[session] resume with /resume ${shortId}, /resume ${saved.sessionId}, or ${resume.command}`);
  }
  return { ...saved, shortId };
}

function formatSkillLabel(activeSkillsRef) {
  const skills = activeSkillsRef.value.map((s) => s.name);
  return skills.length > 0 ? skills.join(",") : "none";
}

function formatPluginLabel(activePluginsRef) {
  const plugins = activePluginsRef.value.map((p) => p.name);
  return plugins.length > 0 ? plugins.join(",") : "none";
}

function printPluginList(pluginIndex, logLine) {
  const plugins = [...pluginIndex.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (plugins.length === 0) {
    logLine("no plugins discovered");
    return;
  }
  logLine("## Plugins");
  const commandIndex = discoverPluginCommands(pluginIndex);
  for (const plugin of plugins) {
    const commands = [...commandIndex.values()]
      .filter((command) => command.pluginName === plugin.name)
      .map((command) => command.slash)
      .sort((a, b) => a.localeCompare(b));
    const commandText = commands.length > 0 ? ` (commands: ${commands.join(", ")})` : "";
    const versionText = plugin.version ? ` v${plugin.version}` : "";
    logLine(`- **${plugin.name}**${versionText}${plugin.description ? `: ${plugin.description}` : ""}${commandText}`);
  }
}

function printPluginCommandList(pluginIndex, logLine) {
  const commands = [...discoverPluginCommands(pluginIndex).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (commands.length === 0) {
    logLine("no plugin commands discovered");
    return;
  }
  logLine("## Plugin Commands");
  for (const command of commands) {
    const description = command.description ? `: ${command.description}` : "";
    logLine(`- **${command.slash}** -> ${command.pluginName}${description}`);
  }
}

function parsePluginInstallArgs(input) {
  const parsed = splitCommandArgs(input);
  if (parsed.error) return { error: parsed.error };
  const args = parsed.args;
  const out = { source: "", name: "", project: false, error: "" };
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === "--project") {
      out.project = true;
      continue;
    }
    if (item === "--name") {
      out.name = args[i + 1] || "";
      i += 1;
      continue;
    }
    if (!out.source) out.source = item;
  }
  if (!out.source) out.error = "missing plugin source";
  return out;
}

function printSkillList(skillIndex, logLine) {
  const skills = [...skillIndex.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) {
    logLine("no skills discovered");
    return;
  }
  logLine("## Skills");
  const commandIndex = discoverSkillCommands(skillIndex);
  for (const skill of skills) {
    const commands = [...commandIndex.values()]
      .filter((command) => command.skillName === skill.name)
      .map((command) => command.slash)
      .sort((a, b) => a.localeCompare(b));
    const commandText = commands.length > 0 ? ` (commands: ${commands.join(", ")})` : "";
    logLine(`- **${skill.name}**${skill.description ? `: ${skill.description}` : ""}${commandText}`);
  }
}

function printSkillCommandList(skillIndex, logLine) {
  const commands = [...discoverSkillCommands(skillIndex).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (commands.length === 0) {
    logLine("no skill commands discovered");
    return;
  }
  logLine("## Skill Commands");
  for (const command of commands) {
    const description = command.description ? `: ${command.description}` : "";
    logLine(`- **${command.slash}** -> ${command.skillName}${description}`);
  }
}

function providerPrefix(kind) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("openrouter")) return "openrouter";
  if (k.includes("anthropic")) return "anthropic";
  if (k.includes("openai")) return "openai";
  if (k.includes("codex")) return "codex";
  return k || "model";
}

function providerTransport(provider) {
  const kind = String(provider?.kind || "").toLowerCase();
  if (kind === "codex-cli-session") return "cli";
  if (kind.includes("codex-auth-token")) return "chatgpt";
  if (kind.includes("codex-auth-key")) return "api";
  return "api";
}

function providerToolMode(provider) {
  return provider?.supportsNativeTools ? "native" : "text";
}

function isCodexCliProvider(provider) {
  return String(provider?.kind || "").toLowerCase() === "codex-cli-session";
}

function formatProviderModel(provider) {
  const prefix = providerPrefix(provider?.kind);
  const model = String(provider?.model || "").trim() || "unknown";
  const thinkingEffort = String(provider?.thinkingEffort || "").trim();
  const thinking = thinkingEffort ? `, think:${thinkingEffort}` : "";
  return `${model}(${prefix}, tools:${providerToolMode(provider)}, ${providerTransport(provider)}${thinking})`;
}

function formatProviderWarning(provider) {
  if (!isCodexCliProvider(provider)) return "";
  return "warning: using Codex CLI fallback; native tools are disabled and startup/turns may be slower. Use Codex auth token/key or set PIECODE_DISABLE_CODEX_CLI=1 to fail fast.";
}

function abbreviateHomePath(targetPath, homeDir = os.homedir()) {
  const raw = String(targetPath || "");
  const home = String(homeDir || "");
  if (!raw || !home) return raw;
  const normalizedHome = path.resolve(home);
  const normalizedRaw = path.resolve(raw);
  if (normalizedRaw === normalizedHome) return "~";
  if (normalizedRaw.startsWith(`${normalizedHome}${path.sep}`)) {
    return `~${path.sep}${normalizedRaw.slice(normalizedHome.length + 1)}`;
  }
  return raw;
}

function emitStartupLogo(tui, provider, workspaceDir) {
  const displayWorkspace = abbreviateHomePath(workspaceDir);
  const shortWorkspace = displayWorkspace.length > 64 ? `...${displayWorkspace.slice(-61)}` : displayWorkspace;
  const shortModel = formatProviderModel(provider);

  tui.event(`[banner-title-inline]  Pie Code  let's cook`);
  tui.event(`[banner-meta] model: ${shortModel}`);
  tui.event(`[banner-meta] workspace: ${shortWorkspace}`);

  const shortcutHint = "keys: CTRL+L timeline/raw | CTRL+T todos | CTRL+O debug | /model switch | /help map";
  if (typeof tui.setStartupShortcutHint === "function") {
    tui.setStartupShortcutHint(shortcutHint);
  }
  const warning = formatProviderWarning(provider);
  if (warning) tui.event(warning);
}

function createCompleter(getSkillIndex, getModelCatalog = null, getMcpServerNames = null, getPluginIndex = null) {
  return (line, callback) => {
    const input = String(line || "");
    const trimmed = input.trimStart();

    if (!trimmed.startsWith("/")) {
      callback(null, [[], line]);
      return;
    }

    const skillIndex = typeof getSkillIndex === "function" ? getSkillIndex() : getSkillIndex;
    const pluginIndex = typeof getPluginIndex === "function" ? getPluginIndex() : getPluginIndex;
    const skillNames = [...skillIndex.keys()].sort((a, b) => a.localeCompare(b));
    const pluginNames = pluginIndex instanceof Map ? [...pluginIndex.keys()].sort((a, b) => a.localeCompare(b)) : [];
    const modelCatalog =
      typeof getModelCatalog === "function"
        ? getModelCatalog()
        : getModelCatalog;
    const modelNames =
      Array.isArray(modelCatalog) && modelCatalog.length > 0 ? modelCatalog : MODEL_SUGGESTIONS;
    const mcpNamesRaw =
      typeof getMcpServerNames === "function"
        ? getMcpServerNames()
        : getMcpServerNames;
    const mcpNames = Array.isArray(mcpNamesRaw)
      ? mcpNamesRaw.map((name) => String(name || "").trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
      : [];
    const skillCommandNames = [...discoverSkillCommands(skillIndex).values()]
      .map((command) => command.slash)
      .sort((a, b) => a.localeCompare(b));
    const pluginCommandNames = pluginIndex instanceof Map
      ? [...discoverPluginCommands(pluginIndex).values()].map((command) => command.slash).sort((a, b) => a.localeCompare(b))
      : [];
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
    if (/^\/plugins\s+use(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/plugins\s+use(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(pluginNames, fragment);
      return;
    }
    if (/^\/plugins\s+off(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/plugins\s+off(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(pluginNames, fragment);
      return;
    }
    if (/^\/plugins(?:\s+.*)?$/i.test(trimmed)) {
      const fragment = trimmed.replace(/^\/plugins\s*/i, "");
      const candidates = ["/plugins", "/plugins list", "/plugins commands", "/plugins install", "/plugins update", "/plugins use", "/plugins off", "/plugins clear"];
      if (!fragment) callback(null, [candidates, fragment]);
      else tryComplete(candidates, fragment);
      return;
    }
    if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
      const fragment = trimmed.replace(/^\/model\s*/i, "");
      const candidates = ["/model", "/model list", ...modelNames];
      if (!fragment) {
        callback(null, [candidates, fragment]);
      } else {
        tryComplete(candidates, fragment);
      }
      return;
    }
    if (/^\/mcp\s+show(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/mcp\s+show(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(mcpNames, fragment);
      return;
    }
    if (/^\/mcp\s+(?:remove|rm)(?:\s+.*)?$/i.test(trimmed)) {
      const match = trimmed.match(/^\/mcp\s+(?:remove|rm)(?:\s+(.*))?$/i);
      const fragment = (match?.[1] || "").trim();
      tryComplete(mcpNames, fragment);
      return;
    }
    if (/^\/mcp\s+import(?:\s+.*)?$/i.test(trimmed)) {
      const fragment = trimmed.replace(/^\/mcp\s+import\s*/i, "");
      const candidates = ["/mcp import", "on", "off"];
      if (!fragment) {
        callback(null, [candidates, fragment]);
      } else {
        tryComplete(candidates, fragment);
      }
      return;
    }
    if (/^\/mcp(?:\s+.*)?$/i.test(trimmed)) {
      const fragment = trimmed.replace(/^\/mcp\s*/i, "");
      const candidates = ["/mcp", "/mcp list", "/mcp show", "/mcp add", "/mcp remove", "/mcp reload", "/mcp import"];
      if (!fragment) {
        callback(null, [candidates, fragment]);
      } else {
        tryComplete(candidates, fragment);
      }
      return;
    }

    tryComplete([...SLASH_COMMANDS, ...pluginCommandNames, ...skillCommandNames], trimmed);
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

function getSuggestionsForInput(line, getSkillIndex, getModelCatalog = null, getMcpServerNames = null, getPluginIndex = null) {
  const input = String(line || "");
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];

  const skillIndex = typeof getSkillIndex === "function" ? getSkillIndex() : getSkillIndex;
  const pluginIndex = typeof getPluginIndex === "function" ? getPluginIndex() : getPluginIndex;
  const skillNames = [...skillIndex.keys()].sort((a, b) => a.localeCompare(b));
  const pluginNames = pluginIndex instanceof Map ? [...pluginIndex.keys()].sort((a, b) => a.localeCompare(b)) : [];
  const mcpNamesRaw =
    typeof getMcpServerNames === "function"
      ? getMcpServerNames()
      : getMcpServerNames;
  const mcpNames = Array.isArray(mcpNamesRaw)
    ? mcpNamesRaw.map((name) => String(name || "").trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
    : [];
  const skillCommandNames = [...discoverSkillCommands(skillIndex).values()]
    .map((command) => command.slash)
    .sort((a, b) => a.localeCompare(b));
  const pluginCommandNames = pluginIndex instanceof Map
    ? [...discoverPluginCommands(pluginIndex).values()].map((command) => command.slash).sort((a, b) => a.localeCompare(b))
    : [];

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
  if (/^\/plugins\s+use(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/plugins\s+use(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(pluginNames, fragment);
  }
  if (/^\/plugins\s+off(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/plugins\s+off(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(pluginNames, fragment);
  }
  if (/^\/plugins(?:\s+.*)?$/i.test(trimmed)) {
    const fragment = trimmed.replace(/^\/plugins\s*/i, "");
    const candidates = ["/plugins", "/plugins list", "/plugins commands", "/plugins install", "/plugins update", "/plugins use", "/plugins off", "/plugins clear"];
    if (!fragment) return candidates;
    return filterByPrefix(candidates, fragment);
  }

  if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
    const fragment = trimmed.replace(/^\/model\s*/i, "");
    const modelCatalog =
      typeof getModelCatalog === "function"
        ? getModelCatalog()
        : getModelCatalog;
    const modelCandidates =
      Array.isArray(modelCatalog) && modelCatalog.length > 0 ? modelCatalog : MODEL_SUGGESTIONS;
    const candidates = ["/model", "/model list", ...modelCandidates];
    if (!fragment) return candidates;
    return filterByPrefix(candidates, fragment);
  }
  if (/^\/mcp\s+show(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/mcp\s+show(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(mcpNames, fragment);
  }
  if (/^\/mcp\s+(?:remove|rm)(?:\s+.*)?$/i.test(trimmed)) {
    const match = trimmed.match(/^\/mcp\s+(?:remove|rm)(?:\s+(.*))?$/i);
    const fragment = (match?.[1] || "").trim();
    return filterByPrefix(mcpNames, fragment);
  }
  if (/^\/mcp\s+import(?:\s+.*)?$/i.test(trimmed)) {
    const fragment = trimmed.replace(/^\/mcp\s+import\s*/i, "");
    const candidates = ["/mcp import", "on", "off"];
    if (!fragment) return candidates;
    return filterByPrefix(candidates, fragment);
  }
  if (/^\/mcp(?:\s+.*)?$/i.test(trimmed)) {
    const fragment = trimmed.replace(/^\/mcp\s*/i, "");
    const candidates = ["/mcp", "/mcp list", "/mcp show", "/mcp add", "/mcp remove", "/mcp reload", "/mcp import"];
    if (!fragment) return candidates;
    return filterByPrefix(candidates, fragment);
  }

  return filterByPrefix([...SLASH_COMMANDS, ...pluginCommandNames, ...skillCommandNames], trimmed);
}

async function collectWorkspaceFilesForMentions(workspaceDir, maxEntries = FILE_MENTION_INDEX_MAX) {
  const root = String(workspaceDir || "");
  if (!root) return [];
  const files = [];
  const stack = [""];
  while (stack.length > 0 && files.length < maxEntries) {
    const relDir = stack.pop() || "";
    const absDir = path.join(root, relDir);
    let entries = [];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (const entry of entries) {
      const name = String(entry?.name || "");
      if (!name) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (isGitRelatedPath(relPath)) continue;
      const lower = name.toLowerCase();
      if (entry.isDirectory()) {
        if (lower === "node_modules") continue;
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(relPath);
      if (files.length >= maxEntries) break;
    }
  }
  return files;
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

async function maybeAutoEnablePlugins(input, activePluginsRef, pluginIndex, logLine) {
  const result = await autoEnablePlugins(input, activePluginsRef, pluginIndex);
  if (result.enabled.length > 0) {
    const sections = [];
    if (result.byTrigger.length > 0) sections.push(`trigger: ${result.byTrigger.join(", ")}`);
    if (result.byMention.length > 0) sections.push(`mention: ${result.byMention.join(", ")}`);
    const details = sections.length > 0 ? ` (${sections.join(" | ")})` : "";
    logLine(`auto-enabled plugins: ${result.enabled.join(", ")}${details}`);
  }
}

async function runAgentTurn(agent, input, tui, logLine, display, workspaceDir, options = {}) {
  const startedAt = Date.now();
  const planOnly = Boolean(options?.planOnly);
  const attachments = Array.isArray(options?.attachments) ? options.attachments : [];
  const mentionContext = await buildFileMentionContext(input, { cwd: workspaceDir, memoryRef: agent.memoryRef });
  const modelInput = mentionContext.prompt;
  if (mentionContext.mentions.some((item) => item.status === "inline" || item.status === "preview")) {
    const inlineCount = mentionContext.mentions.filter((item) => item.status === "inline").length;
    const previewCount = mentionContext.mentions.filter((item) => item.status === "preview").length;
    logLine(`[context] attached ${inlineCount} referenced file(s), ${previewCount} preview(s)`);
  }
  if (tui) tui.beginTurn();
  try {
    const result = await agent.runTurn(modelInput, { planOnly, attachments });
    const durationMs = Date.now() - startedAt;
    if (tui) tui.onTurnSuccess(durationMs);
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (tui) {
      const usage = tui.getTurnTokenUsage();
      logLine(`[response] ${output}`);
      logLine(
        `[result] done | time: ${formatReadableDuration(durationMs)} | tok ↑${formatCompactNumber(usage.sent)} ↓${formatCompactNumber(usage.received)}`
      );
      tui.clearLiveThought();
      tui.setInputHints(buildInputHints({ lastUserMessage: input, assistantText: output }));
      tui.render("", "done");
    } else if (display) {
      display.onResponse(output);
    } else {
      console.log(`\n${output}`);
    }
    return { ok: true, aborted: false, error: "", output, durationMs };
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
        tui.setInputHints(buildInputHints({ lastUserMessage: input, assistantText: err.message, hadError: true }));
        tui.render("", "error");
      }
    } else if (display) {
      display.onError(aborted ? "Task aborted by user." : err.message);
    } else {
      console.error(`error: ${aborted ? "Task aborted by user." : err.message}`);
    }
    return { ok: false, aborted, error: aborted ? "aborted" : String(err?.message || "error") };
  }
}

function formatSubagentLines(subagentsRef, agent = null) {
  const managed = agent?.agentManager && typeof agent.agentManager.snapshot === "function"
    ? agent.agentManager.snapshot()
    : null;
  const state = managed || subagentsRef?.value || {};
  const active = Array.isArray(state.active)
    ? state.active
    : state.active instanceof Map
      ? [...state.active.values()]
      : [];
  const completed = Array.isArray(state.completed) ? state.completed : [];
  const lines = [];
  lines.push(`subagents: ${active.length} active, ${completed.length} completed`);
  for (const item of active) {
    const elapsed = item.startedAt ? formatReadableDuration(Date.now() - item.startedAt) : "-";
    const tool = item.lastTool ? ` | tool=${item.lastTool}` : "";
    lines.push(`- running ${item.id}: ${summarizeForLog(item.task, 90)} | ${elapsed}${tool}`);
  }
  for (const item of completed.slice(-5).reverse()) {
    const elapsed = item.startedAt && item.endedAt ? formatReadableDuration(item.endedAt - item.startedAt) : "-";
    const status = item.status || "done";
    const tools = Array.isArray(item.tools) && item.tools.length > 0 ? ` | tools=${item.tools.join(",")}` : "";
    lines.push(`- ${status} ${item.id}: ${summarizeForLog(item.task, 90)} | ${elapsed}${tools}`);
  }
  const definitions = typeof agent?.getAgentDefinitions === "function" ? agent.getAgentDefinitions() : [];
  if (definitions.length > 0) {
    lines.push(`configured agents: ${definitions.length}`);
    for (const definition of definitions) {
      const color = definition.color ? ` [${definition.color}]` : "";
      const model = definition.model ? ` ${definition.model}` : "";
      lines.push(`- ${definition.name}${color}${model}: ${summarizeForLog(definition.description || definition.path, 100)}`);
    }
  }
  return lines;
}

function updateSubagentState(subagentsRef, evt) {
  if (!subagentsRef?.value || !evt || typeof evt !== "object") return;
  const state = subagentsRef.value;
  if (!(state.active instanceof Map)) state.active = new Map();
  if (!Array.isArray(state.completed)) state.completed = [];
  const id = String(evt.id || "").trim();
  if (!id) return;
  if (evt.type === "subagent_start") {
    state.active.set(id, {
      id,
      task: String(evt.task || ""),
      mode: String(evt.mode || "analysis"),
      role: String(evt.role || ""),
      agentDefinition: evt.agentDefinition || null,
      status: "running",
      startedAt: Date.now(),
      lastTool: "",
    });
    return;
  }
  if (evt.type === "subagent_event") {
    const item = state.active.get(id);
    const child = evt.event && typeof evt.event === "object" ? evt.event : {};
    if (item && child.type === "tool_use") {
      item.lastTool = String(child.tool || "");
      item.lastUpdateAt = Date.now();
    }
    return;
  }
  if (evt.type === "subagent_end") {
    const current = state.active.get(id) || {
      id,
      task: String(evt.task || ""),
      startedAt: Date.now(),
    };
    state.active.delete(id);
    state.completed.push({
      ...current,
      status: String(evt.status || "done"),
      error: String(evt.error || ""),
      tools: Array.isArray(evt.tools) ? evt.tools : [],
      endedAt: Date.now(),
    });
    if (state.completed.length > 20) state.completed = state.completed.slice(-20);
  }
}

async function handleNonInterruptingCommand(input, ctx = {}) {
  const raw = String(input || "").trim();
  const lower = raw.replace(/\s+/g, " ").toLowerCase();
  const logLine = ctx.logLine || (() => {});
  if (!raw.startsWith("/")) {
    if (ctx.steerQueueRef?.value && Array.isArray(ctx.steerQueueRef.value)) {
      ctx.steerQueueRef.value.push({ id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, content: raw, at: new Date().toISOString() });
      logLine(`[steer] queued for current task: ${summarizeForLog(raw, 160)}`);
      return true;
    }
    logLine("task is running; only non-interrupting slash commands are accepted now");
    return true;
  }
  if (lower === "/agents" || lower === "/subagents") {
    for (const line of formatSubagentLines(ctx.subagentsRef, ctx.agent)) logLine(line);
    return true;
  }
  if (lower === "/status") {
    const active = ctx.subagentsRef?.value?.active instanceof Map ? ctx.subagentsRef.value.active.size : 0;
    const model = ctx.providerRef?.value ? formatProviderModel(ctx.providerRef.value) : "unknown";
    const backgroundTasks = getBackgroundTaskCounts(ctx.agent);
    logLine(`status: task running | model=${model} | subagents=${active} active | background=${backgroundTasks.running}/${backgroundTasks.total}`);
    return true;
  }
  if (lower === "/task" || lower === "/tasks" || lower.startsWith("/task ") || lower.startsWith("/tasks ")) {
    await handleTaskSlashCommand(raw, ctx);
    return true;
  }
  if (lower === "/btw" || lower.startsWith("/btw ")) {
    startBtwTask(raw, ctx);
    return true;
  }
  if (lower === "/help") {
    logLine("running commands: /task, /btw <question>, /status, /agents, /debug, /debug status, /debug llm, /help");
    logLine("other commands are deferred until the current task finishes");
    return true;
  }
  if (lower === "/debug" || lower === "/debug status") {
    logLine(
      formatDebugStatus({
        traceRef: ctx.traceRef,
        taskTraceRef: ctx.taskTraceRef,
        providerRef: ctx.providerRef,
        workspaceDir: ctx.workspaceDir,
        llmHistoryRef: ctx.llmHistoryRef,
        subagentsRef: ctx.subagentsRef,
        todosRef: ctx.todosRef,
        planModeRef: ctx.planModeRef,
        contextWindowRef: ctx.contextWindowRef,
        agent: ctx.agent,
      })
    );
    return true;
  }
  if (lower === "/debug last") {
    logLine(formatDebugSavedTrace(ctx.taskTraceRef?.lastSaved, ctx.workspaceDir));
    return true;
  }
  if (lower === "/debug llm") {
    openLlmDebugOverlay({ tui: ctx.tui, llmHistoryRef: ctx.llmHistoryRef, llmLastRef: ctx.llmLastRef, logLine });
    return true;
  }
  logLine(`command not available while task is running: ${raw}`);
  logLine("available now: plain text to steer, /task, /btw <question>, /status, /agents, /debug, /debug llm, /help");
  return true;
}

function startBtwTask(input, ctx = {}) {
  const raw = String(input || "").trim();
  const task = raw.replace(/^\/btw(?:\s+|$)/i, "").trim();
  const logLine = ctx.logLine || (() => {});
  const agent = ctx.agent;
  if (!task) {
    logLine("usage: /btw <read-only question>");
    return false;
  }
  if (!agent || typeof agent.runSubagent !== "function") {
    logLine("/btw unavailable: subagent support is not configured");
    return false;
  }
  const active = ctx.subagentsRef?.value?.active instanceof Map ? ctx.subagentsRef.value.active.size : 0;
  logLine(`[btw] started read-only task${active > 0 ? ` (${active + 1} active)` : ""}: ${summarizeForLog(task, 140)}`);
  void agent
    .runSubagent(
      {
        task,
        context: [
          "This is a user-invoked /btw background task.",
          "It must be strict read-only and must not modify files, todos, memory, settings, shell state, services, or external systems.",
          "Answer concisely so the main task can continue uninterrupted.",
          ctx.currentTask ? `Main task currently running: ${ctx.currentTask}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        mode: "analysis",
        toolBudget: 3,
      },
      { strictReadOnly: true }
    )
    .then((result) => {
      const text = String(result || "").trim();
      logLine(`[btw] done: ${summarizeForLog(task, 100)}`);
      for (const line of text.split("\n").filter(Boolean).slice(0, 18)) {
        logLine(`[btw] ${line}`);
      }
    })
    .catch((err) => {
      logLine(`[btw] failed: ${String(err?.message || err)}`);
    });
  return true;
}

function parseTaskSlashCommand(input) {
  const raw = String(input || "").trim();
  const body = raw.replace(/^\/tasks?(?:\s+|$)/i, "").trim();
  if (!body) return { action: "list" };
  const match = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const verb = String(match?.[1] || "list").toLowerCase();
  const rest = String(match?.[2] || "").trim();
  const action = verb === "run" ? "start" : verb === "ls" ? "list" : verb === "logs" || verb === "log" ? "read" : verb;
  if (action === "list") return { action: "list" };
  if (action === "start") {
    const split = rest.match(/^(.+?)\s+--\s+([\s\S]+)$/);
    if (split) return { action: "start", name: split[1].trim(), command: split[2].trim() };
    return { action: "start", command: rest };
  }
  const [id = "", second = ""] = rest.split(/\s+/, 2);
  if (action === "read") {
    const limit = Number.parseInt(second, 10);
    return { action: "read", id, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) };
  }
  if (action === "stop") {
    return { action: "stop", id, ...(second ? { signal: second } : {}) };
  }
  if (action === "status" || action === "show") return { action: "status", id };
  return { action };
}

async function handleTaskSlashCommand(input, ctx = {}) {
  const logLine = ctx.logLine || (() => {});
  const taskTool = ctx.agent?.tools?.task;
  if (typeof taskTool !== "function") {
    logLine("/task unavailable: background task support is not configured");
    return true;
  }
  const parsed = parseTaskSlashCommand(input);
  if (parsed.action === "start" && !parsed.command) {
    logLine("usage: /task start [name --] <shell command>");
    return true;
  }
  if ((parsed.action === "status" || parsed.action === "read" || parsed.action === "stop") && !parsed.id) {
    logLine(`usage: /task ${parsed.action} <task-id>`);
    return true;
  }
  try {
    const result = await taskTool(parsed);
    for (const line of String(result || "").split("\n")) logLine(line);
  } catch (err) {
    logLine(`task command failed: ${String(err?.message || err)}`);
  }
  return true;
}

async function handleSlashCommand(input, ctx) {
  const {
    agent,
    autoApproveRef,
    traceRef,
    providerRef,
    providerOptionsRef,
    skillIndex,
    activeSkillsRef,
    pluginIndex,
    activePluginsRef,
    refreshPluginIndex,
    logLine,
    rl,
    skillRoots,
    refreshSkillIndex,
    tui,
    setModel,
    setStatusBar,
    openModelPicker,
    planModeRef,
    settings,
    settingsFile,
    workspaceDir,
    mcpHubRef,
    refreshMcpHub,
    modelCatalogRef,
    modelContextWindowsRef,
    modelContextMetadataRef,
    llmLastRef,
    llmHistoryRef,
    sessionBus,
    refreshTuiContextUsage,
    ledgerRef,
    pendingAttachmentsRef,
  } = ctx;

  const raw = String(input || "").trim();
  if (!raw.startsWith("/")) return { done: false, handled: false };
  const normalized = raw.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const formatModelStatus = (provider, prefix = "current model") => {
    const modelLabel = formatProviderModel(provider);
    const contextWindow = formatCompactNumber(
      resolveContextWindow({
        modelName: provider?.model,
        providerName: providerPrefix(provider?.kind),
        settings,
        dynamicByModel: modelContextWindowsRef?.value,
      })
    );
    const fallback = isCodexCliProvider(provider) ? " | fallback: codex-cli" : " | fallback: none";
    return `${prefix}: ${modelLabel} | context window: ${contextWindow}${fallback}`;
  };
  const formatPlanModeStatus = (prefix = "plan mode", enabled = planModeRef?.value) =>
    enabled ? `${prefix}: on` : `${prefix}: off`;
  const normalizeThinkingEffortInput = (value) => {
    const effort = String(value || "").trim().toLowerCase();
    if (!effort || effort === "show" || effort === "status") return { ok: true, value: "", showOnly: true };
    if (effort === "off" || effort === "default") return { ok: true, value: "" };
    const normalizedAliases = {
      "extra": "xhigh",
      "extra-high": "xhigh",
      "extra_high": "xhigh",
      "max": "xhigh",
    };
    const normalized = normalizedAliases[effort] || effort;
    if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return { ok: true, value: normalized };
    return { ok: false, value: effort };
  };
  const getCurrentThinkingEffort = () => String(providerRef.value?.thinkingEffort || providerOptionsRef?.value?.thinkingEffort || "").trim();
  const formatThinkingEffortStatus = (prefix = "thinking effort") => {
    const effort = getCurrentThinkingEffort();
    return `${prefix}: ${effort || "default"} | model=${formatProviderModel(providerRef.value)}`;
  };
  const mcpImportEnvEnabled = String(process.env.PIECODE_MCP_IMPORT || "1") !== "0";
  const getActiveMcpHub = () =>
    mcpHubRef?.value && typeof mcpHubRef.value.hasServers === "function" ? mcpHubRef.value : null;
  const getLocalMcpKeys = () => [...getLocalMcpServerKeySet(settings)].sort((a, b) => a.localeCompare(b));
  const getEffectiveMcpNames = () => {
    const hub = getActiveMcpHub();
    if (hub && hub.hasServers()) return hub.getServerNames();
    return [];
  };
  const printMcpSummary = () => {
    const localKeys = getLocalMcpKeys();
    const effectiveNames = getEffectiveMcpNames();
    const localSet = new Set(localKeys);
    const importEnabled = getMcpImportEnabled(settings);
    const importStatus = mcpImportEnvEnabled && importEnabled ? "on" : "off";
    logLine(`mcp: ${effectiveNames.length} active server(s) | local=${localKeys.length} | import=${importStatus}`);
    if (effectiveNames.length === 0) {
      logLine("no mcp servers configured");
    } else {
      for (const name of effectiveNames) {
        const source = localSet.has(name) ? "local" : "imported";
        logLine(`- ${name} (${source})`);
      }
    }
  };
  const saveSettingsAndRefreshMcp = async (announce = true) => {
    await saveSettings(settingsFile, settings);
    if (typeof refreshMcpHub === "function") {
      await refreshMcpHub({ announce });
    }
  };
  const hasModelContextMetadata = (source) => {
    const key = String(source || "").trim().toLowerCase();
    if (!key) return false;
    return modelContextMetadataRef?.value instanceof Set && modelContextMetadataRef.value.has(key);
  };
  const markModelContextMetadataLoaded = (source) => {
    const key = String(source || "").trim().toLowerCase();
    if (!key) return;
    if (!(modelContextMetadataRef?.value instanceof Set)) {
      if (modelContextMetadataRef) modelContextMetadataRef.value = new Set();
      else return;
    }
    modelContextMetadataRef.value.add(key);
  };
  const loadOpenRouterContextMetadata = async ({ force = false, logErrors = false } = {}) => {
    if (!force && hasModelContextMetadata("openrouter")) return null;
    try {
      const groups = await fetchOpenRouterModelGroups({ settings });
      if (groups.contextByModel && typeof groups.contextByModel === "object") {
        applyContextWindowMetadata(modelContextWindowsRef.value, groups.contextByModel, "openrouter");
      }
      markModelContextMetadataLoaded("openrouter");
      return groups;
    } catch (err) {
      if (logErrors) {
        logLine(`openrouter metadata unavailable: ${String(err?.message || err)}`);
      }
      return null;
    }
  };
  if (lower === "/exit" || lower === "/quit") return { done: true, handled: true };
  if (lower === "/help") {
    if (tui) {
      openHelpOverlay(tui);
      for (const line of getTimelineHelpLines()) logLine(line);
    } else {
      printHelp();
    }
    return { done: false, handled: true };
  }
  if (lower === "/clear") {
    agent.clearHistory();
    if (ctx.todosRef) {
      applyTodoState(ctx.todosRef, [], {
        sessionBus: ctx.sessionBus,
        tui: ctx.tui,
        autoTrackRef: ctx.todoAutoTrackRef,
        autoTrack: false,
      });
    }
    if (ctx.tui) {
      ctx.tui.resetContextUsage();
      ctx.tui.render("", "context cleared");
    }
    logLine("all context cleared");
    return { done: false, handled: true };
  }
  if (lower === "/status") {
    const active = ctx.subagentsRef?.value?.active instanceof Map ? ctx.subagentsRef.value.active.size : 0;
    const backgroundTasks = getBackgroundTaskCounts(agent);
    logLine(`status: idle | model=${formatProviderModel(providerRef.value)} | subagents=${active} active | background=${backgroundTasks.running}/${backgroundTasks.total}`);
    return { done: false, handled: true };
  }
  if (lower === "/task" || lower === "/tasks" || lower.startsWith("/task ") || lower.startsWith("/tasks ")) {
    await handleTaskSlashCommand(raw, {
      ...ctx,
      agent,
      logLine,
    });
    return { done: false, handled: true };
  }
  if (lower === "/think" || lower === "/thinking" || lower === "/reasoning" || lower.startsWith("/think ") || lower.startsWith("/thinking ") || lower.startsWith("/reasoning ")) {
    const requested = raw.replace(/^\/(?:think|thinking|reasoning)(?:\s+|$)/i, "").trim();
    const parsedEffort = normalizeThinkingEffortInput(requested);
    if (!parsedEffort.ok) {
      logLine(`usage: /think none|minimal|low|medium|high|xhigh|off (got: ${parsedEffort.value})`);
      return { done: false, handled: true };
    }
    if (parsedEffort.showOnly) {
      logLine(formatThinkingEffortStatus());
      return { done: false, handled: true };
    }

    const previous = getCurrentThinkingEffort() || "default";
    providerOptionsRef.value = {
      ...providerOptionsRef.value,
      thinkingEffort: parsedEffort.value || null,
    };
    if (parsedEffort.value) {
      settings.thinkingEffort = parsedEffort.value;
    } else {
      delete settings.thinkingEffort;
      delete settings.thinking_effort;
      delete settings.reasoningEffort;
      delete settings.reasoning_effort;
    }
    const providerName = providerOptionsRef.value.provider || settings.provider || providerPrefix(providerRef.value?.kind);
    if (providerName) {
      if (!settings.providers || typeof settings.providers !== "object") settings.providers = {};
      const existingProviderSettings =
        settings.providers[providerName] && typeof settings.providers[providerName] === "object"
          ? settings.providers[providerName]
          : {};
      settings.providers[providerName] = {
        ...existingProviderSettings,
        thinkingEffort: parsedEffort.value || undefined,
      };
      if (!parsedEffort.value) {
        delete settings.providers[providerName].thinkingEffort;
        delete settings.providers[providerName].thinking_effort;
        delete settings.providers[providerName].reasoningEffort;
        delete settings.providers[providerName].reasoning_effort;
      }
    }

    try {
      const nextProvider = getProvider(providerOptionsRef.value);
      providerRef.value = nextProvider;
      agent.provider = nextProvider;
      await saveSettings(settingsFile, settings);
      const nextContextLimit = resolveContextWindow({
        modelName: nextProvider?.model,
        providerName: providerPrefix(nextProvider?.kind),
        settings,
        dynamicByModel: modelContextWindowsRef?.value,
      });
      if (agent?.contextWindowRef) agent.contextWindowRef.value = nextContextLimit;
      if (tui) {
        tui.onModelCall(formatProviderModel(nextProvider));
        tui.setContextUsage(0, nextContextLimit);
        tui.onThinkingDone();
      }
      const next = getCurrentThinkingEffort() || "default";
      logLine(`thinking effort changed: ${previous} -> ${next}`);
      logLine(formatThinkingEffortStatus());
    } catch (err) {
      logLine(`unable to set thinking effort: ${String(err?.message || err)}`);
    }
    return { done: false, handled: true };
  }
  if (lower === "/btw" || lower.startsWith("/btw ")) {
    startBtwTask(raw, {
      agent,
      logLine,
      subagentsRef: ctx.subagentsRef,
      currentTask: "",
    });
    return { done: false, handled: true };
  }
  if (lower === "/agents" || lower === "/subagents") {
    for (const line of formatSubagentLines(ctx.subagentsRef, agent)) logLine(line);
    return { done: false, handled: true };
  }
  if (lower === "/sessions") {
    const sessions = await listResumableSessions(workspaceDir, 10);
    logLine(formatSessionListForDisplay(sessions));
    return { done: false, handled: true };
  }
  if (lower.startsWith("/resume")) {
    const query = normalized.split(/\s+/).slice(1).join(" ").trim();
    if (!query) {
      logLine("usage: /resume <session-id|short-id>");
      return { done: false, handled: true };
    }
    try {
      const sessionId = await resolveResumableSessionId(workspaceDir, query);
      const session = await loadResumableSession(workspaceDir, sessionId);
      agent.history = Array.isArray(session.agentHistory) ? session.agentHistory : [];
      if (ctx.todosRef) {
        applyTodoState(ctx.todosRef, Array.isArray(session.todos) ? session.todos : [], {
          sessionBus,
          tui,
          autoTrackRef: ctx.todoAutoTrackRef,
          autoTrack: false,
        });
      }
      if (tui) {
        if (typeof tui.restoreSessionTimeline === "function") {
          tui.restoreSessionTimeline(Array.isArray(session.timeline) ? session.timeline : session.messages || []);
        }
        refreshTuiContextUsage?.();
      }
      logLine(`resumed session ${session.sessionId} (${session.messages?.length || agent.history.length} messages)`);
    } catch (err) {
      logLine(`resume failed: ${String(err?.message || err)}`);
    }
    return { done: false, handled: true };
  }
  if (lower === "/compact") {
    const result = await agent.compactHistory();
    if (!result.compacted) {
      logLine(`compact skipped: ${result.summary}`);
      return { done: false, handled: true };
    }
    refreshTuiContextUsage?.();
    logLine(
      `context compacted: ${result.beforeMessages} -> ${result.afterMessages} messages (removed ${result.removedMessages})`
    );
    return { done: false, handled: true };
  }
  if (lower === "/plan") {
    const status = formatPlanModeStatus("plan mode");
    if (tui && typeof setStatusBar === "function") {
      setStatusBar(status);
    } else {
      logLine(status);
      logLine("usage: /plan on|off");
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/plan ")) {
    const mode = normalized.split(/\s+/)[1]?.toLowerCase();
    if (mode === "on" || mode === "off") {
      const enabled = mode === "on";
      if (planModeRef) planModeRef.value = enabled;
      if (tui && typeof tui.setPlanMode === "function") tui.setPlanMode(enabled);
      const status = formatPlanModeStatus("plan mode", enabled);
      if (tui && typeof setStatusBar === "function") {
        setStatusBar(status);
      } else {
        logLine(status);
      }
    } else {
      logLine("usage: /plan on|off");
    }
    return { done: false, handled: true };
  }
  if (lower === "/goal" || lower.startsWith("/goal ")) {
    const goal = raw.replace(/^\/goal(?:\s+|$)/i, "").trim();
    if (!goal) {
      logLine("usage: /goal <task>");
      logLine("goal mode loops until the agent reports acceptance complete, blocked, or the max turn limit is reached");
      return { done: false, handled: true };
    }
    ctx.commandRunRef = ctx.commandRunRef || { value: null };
    ctx.commandRunRef.value = {
      input: buildGoalPrompt(goal),
      displayName: "/goal",
      goal,
    };
    return { done: false, handled: false, commandRun: ctx.commandRunRef.value };
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
  if (lower === "/debug" || lower === "/debug status") {
    logLine(
      formatDebugStatus({
        traceRef,
        taskTraceRef: ctx.taskTraceRef,
        providerRef,
        workspaceDir,
        llmHistoryRef,
        subagentsRef: ctx.subagentsRef,
        todosRef: ctx.todosRef,
        planModeRef,
        contextWindowRef: ctx.contextWindowRef,
        agent,
      })
    );
    logLine("debug commands: /debug llm | /debug last | /debug save | /trace on|off");
    return { done: false, handled: true };
  }
  if (lower === "/debug last") {
    logLine(formatDebugSavedTrace(ctx.taskTraceRef?.lastSaved, workspaceDir));
    return { done: false, handled: true };
  }
  if (lower === "/debug save") {
    if (ctx.taskTraceRef?.current) {
      const saved = await finishTaskTrace(ctx.taskTraceRef, workspaceDir, { status: "debug-save", sessionBus });
      logLine(saved ? formatDebugSavedTrace(saved, workspaceDir) : "debug save failed: no trace written");
    } else {
      logLine(formatDebugSavedTrace(ctx.taskTraceRef?.lastSaved, workspaceDir));
    }
    return { done: false, handled: true };
  }
  if (lower === "/debug llm") {
    openLlmDebugOverlay({ tui, llmHistoryRef, llmLastRef, logLine });
    return { done: false, handled: true };
  }
  if (lower === "/model") {
    const providerName = providerPrefix(providerRef.value?.kind);
    if (providerName === "openrouter") {
      await loadOpenRouterContextMetadata({ force: false, logErrors: false });
    }
    const p = providerRef.value;
    if (tui && typeof setStatusBar === "function") {
      setStatusBar(formatModelStatus(p, "current model"));
      const warning = formatProviderWarning(p);
      if (warning) logLine(warning);
      if (typeof openModelPicker === "function") {
        openModelPicker("");
        return { done: false, handled: true, preserveInput: true };
      }
    } else {
      logLine(formatModelStatus(p, "current model"));
      const warning = formatProviderWarning(p);
      if (warning) logLine(warning);
      logLine("usage: /model list | /model <model-id>");
    }
    return { done: false, handled: true };
  }
  if (lower === "/provider" || lower === "/providers" || lower.startsWith("/provider ")) {
    const arg = normalized.slice(lower.startsWith("/providers") ? "/providers".length : "/provider".length).trim();
    if (arg && arg.toLowerCase() !== "list") {
      // `/provider <id>` switches provider using that provider's default model.
      const target = normalizeProviderId(arg);
      const spec = getProviderSpec(target);
      if (!spec) {
        logLine(`unknown provider: ${arg}`);
        logLine("run /provider to list the supported providers");
        return { done: false, handled: true };
      }
      const config = resolveProviderConfig(target, { settings });
      if (!config.configured) {
        logLine(`${spec.label} is not configured — ${describeProviderSetup(target)}`);
        if (spec.docsUrl) logLine(`docs: ${spec.docsUrl}`);
        return { done: false, handled: true };
      }
      const targetModel = config.model || spec.defaultModel;
      if (!targetModel) {
        logLine(`${spec.label} has no default model — use /model ${target}:<model-id>`);
        return { done: false, handled: true };
      }
      try {
        const nextProvider = await setModel(formatModelRef({ provider: target, model: targetModel }));
        const message = formatModelStatus(nextProvider, "provider switched");
        if (tui && typeof setStatusBar === "function") setStatusBar(message);
        else logLine(message);
      } catch (err) {
        logLine(`unable to switch provider: ${err.message}`);
      }
      return { done: false, handled: true };
    }

    const activeProviderId =
      normalizeProviderId(providerRef.value?.providerId) || providerPrefix(providerRef.value?.kind);
    for (const line of formatProviderTable({ settings, env: process.env, activeProviderId })) {
      logLine(line);
    }
    logLine("usage: /provider <id> to switch  |  /models to browse models");
    return { done: false, handled: true };
  }
  if (lower === "/ledger" || lower === "/ledger clear") {
    if (lower === "/ledger clear") {
      await clearLedger(workspaceDir);
      if (ledgerRef) ledgerRef.value = createEmptyLedger();
      if (agent) agent.systemPromptCache?.clear?.();
      logLine("task ledger cleared");
      return { done: false, handled: true };
    }
    for (const line of formatLedgerForDisplay(ledgerRef?.value || agent?.getLedger?.())) {
      logLine(line);
    }
    logLine("usage: /ledger clear to reset durable task state");
    return { done: false, handled: true };
  }
  if (lower === "/doctor") {
    const hub = getActiveMcpHub();
    const report = buildDoctorReport({
      settings,
      env: process.env,
      activeProvider: providerRef.value,
      workspaceDir,
      settingsFile,
      extraChecks: [
        {
          label: "mcp servers",
          ok: true,
          detail: hub && hub.hasServers() ? hub.getServerNames().join(", ") : "none configured",
        },
        {
          label: "skills",
          ok: true,
          detail: `${(skillIndex?.length ?? 0)} discovered, ${(activeSkillsRef?.value?.length ?? 0)} active`,
        },
      ],
    });
    for (const line of report.lines) logLine(line);
    return { done: false, handled: true };
  }
  if (lower === "/models" || lower === "/model list") {
    if (tui && typeof setStatusBar === "function") {
      setStatusBar(formatModelStatus(providerRef.value, "current model"));
    } else {
      logLine(formatModelStatus(providerRef.value, "current model"));
    }
    // Refresh from every configured provider, not just OpenRouter.
    let discoveredRefs = [];
    try {
      const groups = await fetchProviderModelGroups({ settings });
      discoveredRefs = groups.refs;
      for (const source of groups.sources) {
        applyContextWindowMetadata(modelContextWindowsRef.value, groups.contextByModel, source);
        modelContextMetadataRef?.value?.add?.(source);
      }
    } catch {
      // Offline is fine: the curated catalog still lists models.
    }

    modelCatalogRef.value = getUsableModelCatalog(
      mergeModelCatalog(
        MODEL_SUGGESTIONS,
        [],
        [],
        collectModelsFromSettings(settings),
        discoveredRefs
      ),
      settings,
      collectModelsFromSettings(settings)
    );

    const activeRef = formatActiveModelRef(providerRef.value);
    for (const line of formatModelCatalogLines({
      settings,
      env: process.env,
      refs: modelCatalogRef.value,
      activeRef,
    })) {
      logLine(line);
    }
    logLine("usage: /model <provider:model> to switch  |  /provider to see provider setup");
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
      const nextProviderName = providerPrefix(nextProvider?.kind);
      if (nextProviderName === "openrouter") {
        await loadOpenRouterContextMetadata({ force: false, logErrors: false });
      }
      const nextContextLimit = resolveContextWindow({
        modelName: nextProvider?.model,
        providerName: providerPrefix(nextProvider?.kind),
        settings,
        dynamicByModel: modelContextWindowsRef?.value,
      });
      if (ctx.agent?.contextWindowRef) ctx.agent.contextWindowRef.value = nextContextLimit;
      if (tui) {
        tui.setContextUsage(0, nextContextLimit);
      }
      if (tui && typeof setStatusBar === "function") {
        setStatusBar(formatModelStatus(nextProvider, "model switched"));
        const warning = formatProviderWarning(nextProvider);
        if (warning) logLine(warning);
      } else {
        logLine(formatModelStatus(nextProvider, "model switched"));
        const warning = formatProviderWarning(nextProvider);
        if (warning) logLine(warning);
      }
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
  if (lower === "/mcp") {
    printMcpSummary();
    logLine("usage: /mcp list | /mcp show <name> | /mcp add <name> <command> [args...]");
    logLine("       /mcp remove <name> | /mcp reload | /mcp import on|off");
    return { done: false, handled: true };
  }
  if (lower === "/mcp list") {
    const effectiveNames = getEffectiveMcpNames();
    const localSet = new Set(getLocalMcpKeys());
    const hub = getActiveMcpHub();
    if (effectiveNames.length === 0) {
      if (localSet.size > 0) {
        logLine(`no active mcp servers (local entries: ${[...localSet].join(", ")})`);
      } else {
        logLine("no mcp servers configured");
      }
      return { done: false, handled: true };
    }
    logLine("## MCP Servers");
    for (const name of effectiveNames) {
      let commandSummary = "";
      try {
        const config = hub ? hub.getConfig(name) : null;
        if (config && config.command) {
          const argsText = Array.isArray(config.args) && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
          commandSummary = ` -> ${config.command}${argsText}`;
        }
      } catch {
        // keep listing even if one config read fails
      }
      const source = localSet.has(name) ? "local" : "imported";
      logLine(`- ${name} (${source})${commandSummary}`);
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/mcp show ")) {
    const name = normalized.slice("/mcp show ".length).trim();
    if (!name) {
      logLine("usage: /mcp show <name>");
      return { done: false, handled: true };
    }
    const hub = getActiveMcpHub();
    if (!hub || !hub.hasServers()) {
      logLine("no mcp servers configured");
      return { done: false, handled: true };
    }
    try {
      const config = hub.getConfig(name);
      const localSet = new Set(getLocalMcpKeys());
      const source = localSet.has(name) ? "local" : "imported";
      logLine(`mcp server: ${name} (${source})`);
      logLine(`command: ${config.command || "-"}`);
      const argsText = Array.isArray(config.args) && config.args.length > 0 ? config.args.join(" ") : "";
      logLine(`args: ${argsText || "-"}`);
      logLine(`stdio protocol: ${String(config.stdioProtocol || "auto")}`);
      logLine(`cwd: ${config.cwd || workspaceDir}`);
      const envKeys = isRecord(config.env) ? Object.keys(config.env).sort((a, b) => a.localeCompare(b)) : [];
      logLine(`env keys: ${envKeys.length > 0 ? envKeys.join(", ") : "-"}`);
    } catch (err) {
      logLine(`unknown mcp server: ${name}`);
      logLine(`details: ${String(err?.message || "not found")}`);
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/mcp add ")) {
    const payload = raw.replace(/^\/mcp\s+add\s+/i, "").trim();
    const parsed = splitCommandArgs(payload);
    if (parsed.error) {
      logLine(`unable to parse command: ${parsed.error}`);
      logLine('usage: /mcp add <name> <command> [args...]');
      logLine('example: /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .');
      return { done: false, handled: true };
    }
    const [name, command, ...args] = parsed.args;
    if (!name || !command) {
      logLine("usage: /mcp add <name> <command> [args...]");
      return { done: false, handled: true };
    }
    const localServers = ensureLocalMcpServers(settings);
    const existing = isRecord(localServers[name]) ? localServers[name] : {};
    setLocalMcpServer(settings, name, {
      ...existing,
      command,
      args,
      disabled: false,
    });
    try {
      await saveSettingsAndRefreshMcp(false);
      logLine(`saved mcp server: ${name}`);
      printMcpSummary();
    } catch (err) {
      logLine(`failed to save mcp config: ${String(err?.message || "unknown error")}`);
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/mcp remove ") || lower.startsWith("/mcp rm ")) {
    const name = lower.startsWith("/mcp remove ")
      ? normalized.slice("/mcp remove ".length).trim()
      : normalized.slice("/mcp rm ".length).trim();
    if (!name) {
      logLine("usage: /mcp remove <name>");
      return { done: false, handled: true };
    }
    const localSet = new Set(getLocalMcpKeys());
    const effectiveSet = new Set(getEffectiveMcpNames());
    let action = "";
    if (localSet.has(name)) {
      removeLocalMcpServer(settings, name);
      action = `removed local mcp server: ${name}`;
    } else if (effectiveSet.has(name)) {
      setLocalMcpServer(settings, name, { disabled: true });
      action = `masked imported mcp server: ${name}`;
    } else {
      logLine(`mcp server not found: ${name}`);
      return { done: false, handled: true };
    }
    try {
      await saveSettingsAndRefreshMcp(false);
      logLine(action);
      printMcpSummary();
    } catch (err) {
      logLine(`failed to save mcp config: ${String(err?.message || "unknown error")}`);
    }
    return { done: false, handled: true };
  }
  if (lower === "/mcp reload") {
    try {
      const latest = await loadSettings(settingsFile);
      applySettingsSnapshot(settings, latest);
      if (typeof refreshMcpHub === "function") {
        await refreshMcpHub({ announce: true });
      }
      logLine(`reloaded mcp settings from ${settingsFile}`);
      printMcpSummary();
    } catch (err) {
      logLine(`unable to reload mcp settings: ${String(err?.message || "unknown error")}`);
    }
    return { done: false, handled: true };
  }
  if (lower === "/mcp import") {
    const localEnabled = getMcpImportEnabled(settings);
    const effectiveEnabled = localEnabled && mcpImportEnvEnabled;
    logLine(`mcp import: ${effectiveEnabled ? "on" : "off"} (local=${localEnabled ? "on" : "off"})`);
    if (!mcpImportEnvEnabled) {
      logLine("env override: PIECODE_MCP_IMPORT=0");
    }
    logLine("usage: /mcp import on|off");
    return { done: false, handled: true };
  }
  if (lower.startsWith("/mcp import ")) {
    const mode = normalized.slice("/mcp import ".length).trim().toLowerCase();
    if (mode !== "on" && mode !== "off") {
      logLine("usage: /mcp import on|off");
      return { done: false, handled: true };
    }
    const enabled = mode === "on";
    setMcpImportEnabled(settings, enabled);
    try {
      await saveSettingsAndRefreshMcp(false);
      if (enabled && !mcpImportEnvEnabled) {
        logLine("mcp import local setting is on, but this session still has PIECODE_MCP_IMPORT=0");
      }
      logLine(`mcp import ${mode}`);
      printMcpSummary();
    } catch (err) {
      logLine(`failed to save mcp config: ${String(err?.message || "unknown error")}`);
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/mcp ")) {
    logLine(`unknown mcp command: ${raw}`);
    logLine("usage: /mcp list | /mcp show <name> | /mcp add <name> <command> [args...]");
    logLine("       /mcp remove <name> | /mcp reload | /mcp import on|off");
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
  if (lower === "/skills commands") {
    printSkillCommandList(skillIndex, logLine);
    return { done: false, handled: true };
  }
  if (lower === "/skills clear") {
    activeSkillsRef.value = [];
    logLine("all skills disabled");
    return { done: false, handled: true };
  }
  if (lower === "/plugins" || lower === "/plugin") {
    const names = activePluginsRef.value.map((plugin) => plugin.name);
    if (names.length === 0) {
      logLine("active plugins: none");
    } else {
      logLine("## Active Plugins");
      for (const name of names) logLine(`- **${name}**`);
    }
    return { done: false, handled: true };
  }
  if (lower === "/plugins list" || lower === "/plugin list") {
    printPluginList(pluginIndex, logLine);
    return { done: false, handled: true };
  }
  if (lower === "/plugins commands" || lower === "/plugin commands") {
    printPluginCommandList(pluginIndex, logLine);
    return { done: false, handled: true };
  }
  if (lower.startsWith("/plugins install ") || lower.startsWith("/plugin install ")) {
    const payload = raw.replace(/^\/plugins?\s+install\s+/i, "").trim();
    const parsed = parsePluginInstallArgs(payload);
    if (parsed.error) {
      logLine(`usage: /plugins install <source> [--name <name>] [--project] (${parsed.error})`);
      return { done: false, handled: true };
    }
    try {
      const result = await installPlugin({
        source: parsed.source,
        name: parsed.name,
        project: parsed.project,
        workspaceDir,
      });
      if (typeof refreshPluginIndex === "function") await refreshPluginIndex();
      logLine(`installed plugin: ${result.name} -> ${path.relative(workspaceDir, result.dir) || result.dir}`);
      logLine(`enable with: /plugins use ${result.name}`);
    } catch (err) {
      logLine(`plugin install failed: ${String(err?.message || err)}`);
    }
    return { done: false, handled: true };
  }
  if (lower.startsWith("/plugins update") || lower.startsWith("/plugin update")) {
    const target = raw.replace(/^\/plugins?\s+update\s*/i, "").trim() || "all";
    const targets = target.toLowerCase() === "all" ? [...pluginIndex.values()] : [pluginIndex.get(target)].filter(Boolean);
    if (targets.length === 0) {
      logLine(`plugin not found: ${target}`);
      return { done: false, handled: true };
    }
    for (const plugin of targets) {
      try {
        const result = await updatePlugin({ plugin });
        logLine(result.ok ? `updated plugin: ${plugin.name}` : `plugin update skipped: ${plugin.name} (${result.reason})`);
      } catch (err) {
        logLine(`plugin update failed: ${plugin.name}: ${String(err?.message || err)}`);
      }
    }
    if (typeof refreshPluginIndex === "function") await refreshPluginIndex();
    return { done: false, handled: true };
  }
  if (lower === "/plugins clear" || lower === "/plugin clear") {
    activePluginsRef.value = [];
    logLine("all plugins disabled");
    return { done: false, handled: true };
  }
  if (lower.startsWith("/plugins use ") || lower.startsWith("/plugin use ")) {
    const target = raw.replace(/^\/plugins?\s+use\s+/i, "").trim();
    const result = await addPluginByName(activePluginsRef.value, pluginIndex, target);
    activePluginsRef.value = result.active;
    if (result.added) logLine(`enabled plugin: ${target}`);
    else if (result.reason === "already-enabled") logLine(`plugin already enabled: ${target}`);
    else if (result.reason === "not-found") logLine(`plugin not found: ${target}`);
    else if (result.reason === "unreadable") logLine(`plugin unreadable: ${target}`);
    else logLine("unable to enable plugin");
    return { done: false, handled: true };
  }
  if (lower.startsWith("/plugins off ") || lower.startsWith("/plugin off ")) {
    const target = raw.replace(/^\/plugins?\s+off\s+/i, "").trim();
    const result = removePluginByName(activePluginsRef.value, target);
    activePluginsRef.value = result.active;
    logLine(result.removed ? `disabled plugin: ${target}` : `plugin not active: ${target}`);
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
  if (lower === "/attach image" || lower === "/image" || lower === "/paste image") {
    if (!pendingAttachmentsRef) {
      logLine("attachments are unavailable in this mode");
      return { done: false, handled: true };
    }
    try {
      const image = await readClipboardImage();
      pendingAttachmentsRef.value = [...(pendingAttachmentsRef.value || []), image];
      logLine(`attached clipboard image: ${formatAttachmentSummary(image)} (will be sent with next prompt)`);
    } catch (err) {
      logLine(`attach image failed: ${String(err?.message || err)}`);
      if (process.platform === "linux") {
        logLine("hint: on Linux install wl-paste, xclip, or xsel, then copy an image to the clipboard");
      } else if (process.platform === "darwin") {
        logLine("hint: copy an image to the macOS clipboard, then run /attach image");
      } else if (process.platform === "win32") {
        logLine("hint: copy an image to the Windows clipboard, then run /attach image");
      }
    }
    return { done: false, handled: true };
  }

  const pluginCommand = resolvePluginCommand(raw, pluginIndex);
  if (pluginCommand) {
    const result = await addPluginByName(activePluginsRef.value, pluginIndex, pluginCommand.pluginName);
    if (result.added) {
      activePluginsRef.value = result.active;
      logLine(`enabled plugin for command ${pluginCommand.slash}: ${pluginCommand.pluginName}`);
    } else if (result.reason === "not-found" || result.reason === "unreadable") {
      logLine(`plugin command unavailable: ${pluginCommand.slash} (${result.reason})`);
      return { done: false, handled: true };
    }
    ctx.commandRunRef = ctx.commandRunRef || { value: null };
    ctx.commandRunRef.value = {
      input: pluginCommand.prompt,
      displayName: pluginCommand.slash,
      pluginName: pluginCommand.pluginName,
    };
    return { done: false, handled: false, commandRun: ctx.commandRunRef.value };
  }

  const skillCommand = resolveSkillCommand(raw, skillIndex);
  if (skillCommand) {
    const result = await addSkillByName(activeSkillsRef.value, skillIndex, skillCommand.skillName);
    if (result.added) {
      activeSkillsRef.value = result.active;
      logLine(`enabled skill for command ${skillCommand.slash}: ${skillCommand.skillName}`);
    } else if (result.reason === "not-found" || result.reason === "unreadable") {
      logLine(`skill command unavailable: ${skillCommand.slash} (${result.reason})`);
      return { done: false, handled: true };
    }
    ctx.commandRunRef = ctx.commandRunRef || { value: null };
    ctx.commandRunRef.value = {
      input: skillCommand.prompt,
      displayName: skillCommand.slash,
      skillName: skillCommand.skillName,
    };
    return { done: false, handled: false, commandRun: ctx.commandRunRef.value };
  }

  if (raw.startsWith("/")) {
    logLine(`unknown command: ${raw} (try /help)`);
    return { done: false, handled: true };
  }
  return { done: false, handled: false };
}

function getFilteredModelSuggestions(query, catalog = MODEL_SUGGESTIONS) {
  const source = Array.isArray(catalog) && catalog.length > 0 ? catalog : MODEL_SUGGESTIONS;
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [...source];
  const starts = source.filter((m) => m.toLowerCase().startsWith(q));
  const contains = source.filter((m) => !starts.includes(m) && m.toLowerCase().includes(q));
  return [...starts, ...contains];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function splitCommandArgs(input) {
  const src = String(input || "").trim();
  if (!src) return { args: [], error: "" };
  const args = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const pushCurrent = () => {
    if (current.length === 0) return;
    args.push(current);
    current = "";
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      const next = src[i + 1];
      if (next) {
        current += next;
        i += 1;
      } else {
        current += "\\";
      }
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  if (quote) return { args, error: "unclosed quote in command" };
  pushCurrent();
  return { args, error: "" };
}

function applySettingsSnapshot(target, source) {
  if (!isRecord(target)) return;
  const next = isRecord(source) ? source : {};
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function ensureLocalMcpServers(settings) {
  const target = isRecord(settings) ? settings : {};
  const direct = isRecord(target.mcpServers) ? target.mcpServers : {};
  const nested = isRecord(target?.mcp?.servers) ? target.mcp.servers : {};
  const merged = {
    ...nested,
    ...direct,
  };
  target.mcpServers = merged;
  if (!isRecord(target.mcp)) target.mcp = {};
  target.mcp.servers = merged;
  return merged;
}

function setLocalMcpServer(settings, name, config) {
  const key = String(name || "").trim();
  if (!key) return false;
  const servers = ensureLocalMcpServers(settings);
  const nextConfig = isRecord(config) ? config : {};
  servers[key] = nextConfig;
  settings.mcpServers = servers;
  if (!isRecord(settings.mcp)) settings.mcp = {};
  settings.mcp.servers = servers;
  return true;
}

function removeLocalMcpServer(settings, name) {
  const key = String(name || "").trim();
  if (!key) return false;
  const servers = ensureLocalMcpServers(settings);
  if (!Object.prototype.hasOwnProperty.call(servers, key)) return false;
  delete servers[key];
  settings.mcpServers = servers;
  if (!isRecord(settings.mcp)) settings.mcp = {};
  settings.mcp.servers = servers;
  return true;
}

function getMcpImportEnabled(settings) {
  const value = settings?.mcpImport?.enabled;
  if (typeof value === "boolean") return value;
  return true;
}

function setMcpImportEnabled(settings, enabled) {
  const target = isRecord(settings) ? settings : {};
  if (!isRecord(target.mcpImport)) target.mcpImport = {};
  target.mcpImport.enabled = Boolean(enabled);
}

function getLocalMcpServerKeySet(settings) {
  const direct = isRecord(settings?.mcpServers) ? settings.mcpServers : {};
  const nested = isRecord(settings?.mcp?.servers) ? settings.mcp.servers : {};
  const merged = {
    ...nested,
    ...direct,
  };
  const names = new Set();
  for (const rawName of Object.keys(merged)) {
    const name = String(rawName || "").trim();
    if (name) names.add(name);
  }
  return names;
}

function getLocalMcpServerNameSet(settings, workspaceDir) {
  const names = new Set();
  const map = resolveMcpServerConfigs(settings, workspaceDir);
  for (const name of map.keys()) names.add(name);
  return names;
}

/**
 * Ask every configured provider which models it serves. Results are converted
 * into `provider:model` refs plus a context-window map for the status bar.
 */
async function fetchProviderModelGroups({ settings, providerIds = null, timeoutMs = 6000 } = {}) {
  const { models, sources } = await discoverAllProviderModels({
    settings,
    env: process.env,
    providerIds,
    timeoutMs,
  });

  const byProvider = new Map();
  const contextByModel = {};
  const refs = [];
  for (const entry of models) {
    const ref = formatModelRef({ provider: entry.provider, model: entry.id });
    if (!ref) continue;
    refs.push(ref);
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider).push(entry.id);
    const contextWindow = extractContextWindowValue(entry.context);
    if (contextWindow != null) {
      contextByModel[entry.id] = contextWindow;
      contextByModel[ref] = contextWindow;
    }
  }
  return { refs, byProvider, contextByModel, sources };
}

/** Back-compat shim: `/model list` still highlights OpenRouter separately. */
async function fetchOpenRouterModelGroups({ settings }) {
  const groups = await fetchProviderModelGroups({ settings, providerIds: ["openrouter"] });
  const available = new Set(groups.byProvider.get("openrouter") || []);
  if (available.size === 0) throw new Error("OpenRouter models request returned nothing");
  const preferred = buildModelCatalog({ includeUnconfigured: true })
    .filter((row) => row.provider === "openrouter")
    .map((row) => row.id)
    .filter((id) => available.has(id));
  return {
    popular: preferred.slice(0, 10),
    latest: [...available].filter((id) => !preferred.includes(id)).slice(0, 10),
    contextByModel: groups.contextByModel,
  };
}

function mergeModelCatalog(baseCatalog, popular, latest, localSettingsModels = [], discoveredRefs = []) {
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
  for (const id of localSettingsModels || []) push(id);
  for (const id of baseCatalog || []) push(id);
  // Discovered ids go last: curated entries stay at the top of the picker.
  for (const ref of discoveredRefs || []) push(ref);
  return out;
}

function getUsableModelCatalog(baseCatalog, settings, alwaysInclude = []) {
  return filterUsableModelCatalog(baseCatalog, settings, process.env, alwaysInclude);
}

async function probeAvailableModels({
  settings,
  modelCatalogRef,
  modelContextWindowsRef,
  modelContextMetadataRef,
  logLine = null,
  tui = null,
} = {}) {
  if (String(process.env.PIECODE_MODEL_PROBE || "1") === "0") {
    return { openrouter: null };
  }

  const loadedSources = [];
  const popular = [];
  const latest = [];
  let discoveredRefs = [];

  const markLoaded = (source) => {
    const key = String(source || "").trim().toLowerCase();
    if (!key) return;
    if (!(modelContextMetadataRef?.value instanceof Set)) {
      if (modelContextMetadataRef) modelContextMetadataRef.value = new Set();
      else return;
    }
    modelContextMetadataRef.value.add(key);
    loadedSources.push(key);
  };

  const applyContext = (contextByModel, source) => {
    if (contextByModel && typeof contextByModel === "object") {
      applyContextWindowMetadata(modelContextWindowsRef.value, contextByModel, source);
    }
  };

  let openrouter = null;

  try {
    // One sweep across every configured provider, not just OpenRouter.
    const groups = await fetchProviderModelGroups({ settings });
    discoveredRefs = groups.refs;
    for (const source of groups.sources) {
      applyContext(groups.contextByModel, source);
      markLoaded(source);
    }
    const openRouterIds = groups.byProvider.get("openrouter") || [];
    if (openRouterIds.length > 0) {
      const available = new Set(openRouterIds);
      const preferred = MODEL_SUGGESTIONS.map((ref) => parseModelRef(ref))
        .filter((parsed) => parsed.provider === "openrouter" && available.has(parsed.model))
        .map((parsed) => parsed.model);
      for (const id of preferred.slice(0, 10)) popular.push(id);
      openrouter = { popular, latest, contextByModel: groups.contextByModel };
    }
  } catch {
    // Best effort: model discovery should never block startup.
  }

  if (loadedSources.length > 0) {
    const discoveredCatalog = mergeModelCatalog(
      MODEL_SUGGESTIONS,
      popular,
      latest,
      collectModelsFromSettings(settings),
      discoveredRefs
    );
    modelCatalogRef.value = getUsableModelCatalog(discoveredCatalog, settings, collectModelsFromSettings(settings));
    const hiddenCount = Math.max(0, discoveredCatalog.length - modelCatalogRef.value.length);
    const hiddenSuffix = hiddenCount > 0 ? `, ${hiddenCount} unavailable hidden` : "";
    const message = `model probe: ${loadedSources.join(", ")} (${modelCatalogRef.value.length} models available${hiddenSuffix})`;
    if (typeof logLine === "function") logLine(message);
    else if (tui && typeof tui.render === "function") tui.render(undefined, message);
  }

  return { openrouter };
}

function collectModelsFromSettings(settings = {}) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  const pushModel = (providerHint, modelValue) => {
    const provider = String(providerHint || "").trim().toLowerCase();
    const raw = String(modelValue || "").trim();
    if (!raw) return;
    const parsed = parseModelTarget(raw);
    if (parsed.provider) {
      push(`${parsed.provider}:${parsed.model}`);
      return;
    }
    if (provider) push(`${provider}:${raw}`);
    push(raw);
  };

  const defaultProvider = String(settings?.provider || "").trim().toLowerCase();
  pushModel(defaultProvider, settings?.model);

  const providers =
    settings?.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
      ? settings.providers
      : {};
  for (const [providerName, providerSettings] of Object.entries(providers)) {
    if (!providerSettings || typeof providerSettings !== "object") continue;
    pushModel(providerName, providerSettings.model);
    if (Array.isArray(providerSettings.models)) {
      for (const candidate of providerSettings.models) {
        pushModel(providerName, candidate);
      }
    }
  }
  return out;
}

function parseModelTarget(target) {
  return parseModelRef(target);
}

/** `provider:model` for the live provider, for picker/status highlighting. */
function formatActiveModelRef(provider) {
  const model = String(provider?.model || "").trim();
  if (!model) return "";
  const providerId = normalizeProviderId(provider?.providerId || providerPrefix(provider?.kind));
  return providerId ? formatModelRef({ provider: providerId, model }) : model;
}

function inferEndpointForProvider(providerOptions, provider) {
  const explicit =
    providerOptions?.endpoint ||
    providerOptions?.baseUrl ||
    null;
  if (explicit) return String(explicit);
  const kind = String(provider?.kind || "").toLowerCase();
  if (kind.includes("openrouter")) return "https://openrouter.ai/api/v1";
  if (kind.includes("openai") || kind.includes("codex")) return "https://api.openai.com/v1";
  if (kind.includes("anthropic")) return "https://api.anthropic.com/v1/messages";
  return "unknown";
}

async function main() {
  const startupStartedAt = Date.now();
  const startupTraceEnabled = process.env.PIECODE_STARTUP_TRACE === "1";
  const startupMark = (name) => {
    if (!startupTraceEnabled) return;
    const elapsed = Date.now() - startupStartedAt;
    console.error(`[startup] ${name} ${elapsed}ms`);
  };
  startupMark("main");
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.web) {
    const web = await import("./web/server.js");
    await web.main();
    return;
  }
  if (args.watchSubagentEvents) {
    await watchSubagentEventsFile({
      filePath: args.watchSubagentEvents,
      subagentId: args.watchSubagentId,
      out: stdout,
    });
    return;
  }

  // Handle --disable-codex option
  if (args.disableCodex) {
    process.env.PIECODE_DISABLE_CODEX_CLI = "1";
  }

  const settingsFile = getSettingsFilePath();
  const workspaceDir = process.cwd();
  const settings = await loadSettings(settingsFile);
  const planModeRef = { value: process.env.PIECODE_PLAN_MODE === "1" };
  const settingsModelSuggestions = collectModelsFromSettings(settings);
  const modelCatalogRef = {
    value: getUsableModelCatalog(
      mergeModelCatalog(MODEL_SUGGESTIONS, [], [], settingsModelSuggestions),
      settings,
      settingsModelSuggestions
    ),
  };
  const modelContextWindowsRef = { value: new Map() };
  const modelContextMetadataRef = { value: new Set() };
  const skillRoots = resolveSkillRoots(settings, workspaceDir);
  const pluginRoots = resolvePluginRoots(settings, workspaceDir);
  const historyFile = getHistoryFilePath();
  const requestedResumeId = String(args.resume || "").trim();
  if (args.resume !== null && !requestedResumeId) {
    throw new Error("--resume requires a session id or short id");
  }

  const startupLoads = {
    skills: discoverSkills(skillRoots),
    plugins: discoverPlugins(pluginRoots),
    projectInstructions: loadProjectInstructions(workspaceDir),
    memory: loadMemory({ workspaceDir }),
    agentDefinitions: loadAgentDefinitions({ workspaceDir }),
    history: loadHistory(historyFile),
    resumeSession: requestedResumeId
      ? resolveResumableSessionId(workspaceDir, requestedResumeId).then((id) => loadResumableSession(workspaceDir, id))
      : Promise.resolve(null),
  };

  let [skillIndex, pluginIndex] = await Promise.all([startupLoads.skills, startupLoads.plugins]);
  startupMark("indexes-ready");
  const refreshSkillIndex = async () => {
    skillIndex = await discoverSkills(skillRoots);
  };
  const refreshPluginIndex = async () => {
    pluginIndex = await discoverPlugins(pluginRoots);
    return pluginIndex;
  };
  const requestedSkills = resolveRequestedSkills(args.skills, settings);
  const requestedPlugins = [
    ...resolveRequestedPlugins(args.plugins, settings),
    ...getDefaultPluginNames(pluginIndex, settings),
  ];
  const [loadedSkills, loadedPlugins] = await Promise.all([
    loadActiveSkills(skillIndex, requestedSkills),
    loadActivePlugins(pluginIndex, requestedPlugins),
  ]);
  const { active: activeSkillsInitial, missing: missingSkills } = loadedSkills;
  const { active: activePluginsInitial, missing: missingPlugins } = loadedPlugins;
  const activeSkillsRef = { value: activeSkillsInitial };
  const activePluginsRef = { value: activePluginsInitial };
  startupMark("extensions-ready");

  if (missingSkills.length > 0) {
    console.error(`warning: missing skills: ${missingSkills.join(", ")}`);
  }
  if (missingPlugins.length > 0) {
    console.error(`warning: missing plugins: ${missingPlugins.join(", ")}`);
  }

  if (args.pluginInstall) {
    const result = await installPlugin({
      source: args.pluginInstall,
      name: args.pluginInstallName,
      project: args.pluginInstallProject,
      workspaceDir,
    });
    console.log(`installed plugin: ${result.name}`);
    console.log(`path: ${result.dir}`);
    console.log(`enable with: piecode --plugin ${result.name}`);
    return;
  }
  if (args.pluginUpdate) {
    const target = String(args.pluginUpdate || "all").trim() || "all";
    const targets = target.toLowerCase() === "all" ? [...pluginIndex.values()] : [pluginIndex.get(target)].filter(Boolean);
    if (targets.length === 0) throw new Error(`Plugin not found: ${target}`);
    for (const plugin of targets) {
      const result = await updatePlugin({ plugin });
      console.log(result.ok ? `updated plugin: ${plugin.name}` : `plugin update skipped: ${plugin.name} (${result.reason})`);
    }
    return;
  }

  if (args.listSkills) {
    printSkillList(skillIndex, console.log);
    return;
  }
  if (args.listPlugins) {
    printPluginList(pluginIndex, console.log);
    return;
  }
  if (args.listProviders) {
    for (const line of formatProviderTable({ settings, env: process.env })) console.log(line);
    return;
  }
  if (args.listModels) {
    let discoveredRefs = [];
    try {
      discoveredRefs = (await fetchProviderModelGroups({ settings })).refs;
    } catch {
      // Offline: fall back to the curated catalog.
    }
    const refs = getUsableModelCatalog(
      mergeModelCatalog(MODEL_SUGGESTIONS, [], [], collectModelsFromSettings(settings), discoveredRefs),
      settings,
      collectModelsFromSettings(settings)
    );
    for (const line of formatModelCatalogLines({ settings, env: process.env, refs })) console.log(line);
    return;
  }

  const providerOptionsRef = { value: resolveProviderOptions(args, settings) };
  if (args.doctor) {
    let activeProvider = null;
    try {
      activeProvider = getProvider(providerOptionsRef.value);
    } catch {
      activeProvider = null;
    }
    const report = buildDoctorReport({
      settings,
      env: process.env,
      activeProvider,
      workspaceDir,
      settingsFile,
      extraChecks: [
        { label: "skills", ok: true, detail: `${skillIndex.size ?? skillIndex.length ?? 0} discovered` },
        { label: "plugins", ok: true, detail: `${pluginIndex.size ?? pluginIndex.length ?? 0} discovered` },
      ],
    });
    for (const line of report.lines) console.log(line);
    process.exitCode = report.problems.length > 0 ? 1 : 0;
    return;
  }
  const providerRef = { value: getProvider(providerOptionsRef.value) };
  const contextWindowRef = { value: 0 };
  const [projectInstructionsLoaded, loadedMemory, loadedAgentDefinitions] = await Promise.all([
    startupLoads.projectInstructions,
    startupLoads.memory,
    startupLoads.agentDefinitions,
  ]);
  const projectInstructionsRef = { value: projectInstructionsLoaded.instructions };
  const projectInstructionsStatusRef = { value: projectInstructionsLoaded.status };
  const memoryRef = { value: loadedMemory };
  const agentDefinitionsRef = { value: loadedAgentDefinitions };
  const startupAutoSkills = await autoLoadSkillsFromInstructions(
    projectInstructionsRef.value,
    activeSkillsRef,
    skillIndex
  );
  startupMark("context-ready");
  const autoApproveRef = { value: false };
  const shellPermissionRef = { value: { allowAllSession: false, rememberedCommands: new Set() } };
  const oneShotPromptMode = args.prompt !== null;
  if (oneShotPromptMode) {
    // One-shot mode has no interactive approval channel; auto-approve tool prompts.
    autoApproveRef.value = true;
  }
  const initialHistory = await startupLoads.history;
  const useTui = !oneShotPromptMode && !args.web && (process.env.PIECODE_TUI !== "0" || args.tui);
  const display = useTui ? null : new Display();
  const llmLastRef = { value: { request: null, response: null } };
  const llmHistoryRef = { value: { entries: [], seq: 0, index: -1 } };
  const traceRef = { value: process.env.PIECODE_TRACE === "1" };
  const verboseToolLogs = process.env.PIECODE_VERBOSE_TOOL_LOGS === "1";
  const llmStreamRef = { value: { turn: "", planning: "", replanning: "" } };
  const llmPendingRequestTokensRef = { value: new Map() };
  const traceStateRef = { value: { turnId: 0, turnStartedAt: 0, llmStageStart: {}, toolStartByName: {} } };
  const startupResumeSession = await startupLoads.resumeSession;
  const taskTraceRef = {
    seq: 0,
    current: null,
    lastSaved: null,
    sessionId: startupResumeSession?.sessionId || makeSessionId(),
    sessionDir: "",
  };
  const tmuxSubagentOptions = resolveTmuxSubagentOptions({
    args,
    env: process.env,
    workspaceDir,
    sessionId: taskTraceRef.sessionId,
  });
  const sessionEventsFile =
    process.env.PIECODE_SESSION_EVENTS_FILE ||
    (tmuxSubagentOptions.enabled && tmuxSubagentOptions.available ? tmuxSubagentOptions.eventsFile : "");
  const subagentsRef = { value: { active: new Map(), completed: [] } };
  const sessionBus = new SessionEventBus({ sessionId: taskTraceRef.sessionId });
  const sessionState = new AgentSessionState({ sessionId: taskTraceRef.sessionId });
  sessionBus.subscribe((event) => sessionState.apply(event));
  const sessionSink = createJsonlSessionSink(sessionEventsFile);
  if (sessionSink) sessionBus.subscribe(sessionSink);
  const currentInputRef = { value: "" };
  const keepIdleStatusRef = { value: false };
  const todosRef = { value: [] };
  const todoAutoTrackRef = { value: false };
  const fileMentionIndexRef = { files: [], loading: false, lastLoadedAt: 0 };
  const exitArmedRef = { value: false };
  const userExitRequestedRef = { value: false };
  const approvalActiveRef = { value: false };
  const clarificationActiveRef = { value: false };
  const suppressNextSubmitRef = { value: false };
  const pendingCommandSubmitRef = { value: "" };
  const modelPickerRef = { active: false, query: "", options: [], index: 0 };
  const commandPickerRef = { active: false, mode: "command", options: [], index: 0 };
  const mcpHubRef = { value: null };
  const commandRunRef = { value: null };
  const pendingAttachmentsRef = { value: [] };
  const getMcpServerNamesForSuggestions = () => {
    const names = new Set([...getLocalMcpServerKeySet(settings)]);
    if (mcpHubRef.value && typeof mcpHubRef.value.hasServers === "function" && mcpHubRef.value.hasServers()) {
      for (const name of mcpHubRef.value.getServerNames()) names.add(name);
    }
    for (const name of getLocalMcpServerNameSet(settings, workspaceDir)) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
  };
  const taskRunningRef = { value: false };
  const directShellAbortRef = { value: null };
  const steerQueueRef = { value: [] };
  const escAbortArmedRef = { value: false };
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

  // TUI mode renders through Ink, but input is still owned by PieCode's
  // line editor so model pickers, approvals, command mode, and multiline
  // shortcuts all share the same key handling path.
  if (!useTui) readlineCore.emitKeypressEvents(filteredInput);
  let keypressSource = filteredInput;
  let destroyKeypressSource = () => {};
  if (useTui) {
    const keypressHub = createTuiKeypressSource({ input: filteredInput });
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
        shouldHandleKeypress: (str, key = {}) => {
          if (tui && tui.isOverlayOpen && tui.isOverlayOpen()) return false;
          const name = String(key?.name || "").toLowerCase();
          if (key?.ctrl && (name === "c" || name === "z")) return false;
          const tabLike = name === "tab" || str === "\t";
          const navLike = name === "up" || name === "down";
          const enterLike = name === "return" || name === "enter" || str === "\r" || str === "\n";
          if ((modelPickerRef.active || commandPickerRef.active) && (tabLike || navLike || enterLike)) {
            return false;
          }
          if (!key?.ctrl && !key?.meta && !key?.shift && (name === "up" || name === "down")) {
            const currentLine = stripMouseInputNoise(String(rl?.line || ""));
            if (currentLine.trim().length === 0) return false;
          }
          if (name === "pageup" || name === "pagedown") return false;
          if (!key?.ctrl && !key?.meta && !key?.shift && (name === "home" || name === "end")) {
            const currentLine = stripMouseInputNoise(String(rl?.line || ""));
            if (currentLine.trim().length === 0) return false;
          }
          return true;
        },
      });
    }
    const next = createInterface({
      input: filteredInput,
      output: readlineOutput,
      terminal: true,
      historySize: HISTORY_MAX,
      removeHistoryDuplicates: true,
      completer: createCompleter(
        () => skillIndex,
        () => modelCatalogRef.value,
        () => getMcpServerNamesForSuggestions(),
        () => pluginIndex
      ),
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
  const refreshFileMentionIndex = async (force = false) => {
    if (fileMentionIndexRef.loading) return;
    const staleMs = Date.now() - Number(fileMentionIndexRef.lastLoadedAt || 0);
    if (!force && fileMentionIndexRef.files.length > 0 && staleMs < FILE_MENTION_REFRESH_MS) return;
    fileMentionIndexRef.loading = true;
    try {
      fileMentionIndexRef.files = await collectWorkspaceFilesForMentions(workspaceDir);
      fileMentionIndexRef.lastLoadedAt = Date.now();
    } finally {
      fileMentionIndexRef.loading = false;
    }
  };

  let tui = null;
  let onResize = null;
  if (useTui) {
    const inkLayout = new InkTuiLayout({
      input: filteredInput,
      output: stdout,
      error: process.stderr,
    });
    tui = new SimpleTui({
      out: stdout,
      workspaceDir,
      providerLabel: () => formatProviderModel(providerRef.value),
      getSkillsLabel: () => formatSkillLabel(activeSkillsRef),
      getPluginsLabel: () => formatPluginLabel(activePluginsRef),
      getApprovalLabel: () => (autoApproveRef.value ? "on" : "off"),
      layout: inkLayout,
    });
    tui.setProjectInstructionsStatus(projectInstructionsStatusRef.value);
    tui.setTodos(todosRef.value);
    tui.setPlanMode(planModeRef.value);
    onResize = () => {
      tui.render(currentInputRef.value);
    };
    stdout.on("resize", onResize);
    process.on("SIGWINCH", onResize);
  }

  const resolveProviderContextLimit = (provider = providerRef.value) =>
    resolveContextWindow({
      modelName: provider?.model,
      providerName: providerPrefix(provider?.kind),
      settings,
      dynamicByModel: modelContextWindowsRef.value,
    });
  contextWindowRef.value = resolveProviderContextLimit(providerRef.value);
  const getPendingRequestTokenTotal = () => {
    let total = 0;
    for (const value of llmPendingRequestTokensRef.value.values()) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) total += Math.round(n);
    }
    return total;
  };
  const addPendingRequestTokens = (stage, tokens) => {
    const key = String(stage || "");
    const amount = Math.max(0, Math.round(Number(tokens) || 0));
    if (!key || amount <= 0) return;
    const current = Number(llmPendingRequestTokensRef.value.get(key) || 0);
    llmPendingRequestTokensRef.value.set(key, Math.max(0, current + amount));
  };
  const consumePendingRequestTokens = (stage) => {
    const key = String(stage || "");
    if (!key) return 0;
    const current = Number(llmPendingRequestTokensRef.value.get(key) || 0);
    llmPendingRequestTokensRef.value.delete(key);
    return Number.isFinite(current) && current > 0 ? Math.round(current) : 0;
  };
  const clearPendingRequestTokens = () => {
    llmPendingRequestTokensRef.value.clear();
  };
  const refreshTuiContextUsage = () => {
    const limit = resolveProviderContextLimit();
    contextWindowRef.value = limit;
    if (!tui) return;
    const pending = getPendingRequestTokenTotal();
    const historyTokens = typeof agent?.estimateMessagesTokens === "function" ? agent.estimateMessagesTokens(agent.history) : 0;
    const used = Math.max(0, Math.round(historyTokens + pending));
    tui.setContextUsage(used, limit);
  };

  const logLine = createLogger(tui, display, () => currentInputRef.value, (line) =>
    recordTaskLog(taskTraceRef, line),
    sessionBus
  );
  let tmuxSubagentWatcher = null;
  if (tmuxSubagentOptions.enabled && !tmuxSubagentOptions.available) {
    logLine("tmux subagent windows requested but not running inside tmux; continuing without tmux windows");
  } else if (tmuxSubagentOptions.enabled && sessionEventsFile) {
    tmuxSubagentWatcher = createTmuxSubagentWatcher({
      sessionBus,
      eventsFile: sessionEventsFile,
      workspaceDir,
      cliPath: fileURLToPath(import.meta.url),
      log: (line) => logLine(line),
    });
    logLine(`tmux subagent windows enabled; event log: ${path.relative(workspaceDir, sessionEventsFile) || sessionEventsFile}`);
  }
  if (!oneShotPromptMode) {
    void probeAvailableModels({
      settings,
      modelCatalogRef,
      modelContextWindowsRef,
      modelContextMetadataRef,
      logLine,
      tui,
    }).catch(() => {});
  }
  const setStatusBar = (message) => {
    if (!tui) return;
    const text = String(message || "").trim();
    if (!text) return;
    keepIdleStatusRef.value = true;
    tui.render(currentInputRef.value, text);
  };
  const getCurrentModelTarget = () => {
    const provider = providerRef.value;
    const model = String(provider?.model || "").trim();
    if (!model) return "";
    const prefix = providerPrefix(provider?.kind);
    return prefix ? `${prefix}:${model}` : model;
  };
  /** Annotate picker rows with context window and capability tags. */
  const applyModelSuggestionMeta = (options) => {
    if (!tui || typeof tui.setModelSuggestionMeta !== "function") return;
    const meta = new Map();
    for (const ref of Array.isArray(options) ? options : []) {
      const dynamicContext = resolveContextWindow({
        modelName: ref,
        settings,
        dynamicByModel: modelContextWindowsRef.value,
      });
      const described = describeModelRef(ref);
      const contextLabel = dynamicContext ? `${formatCompactNumber(dynamicContext)} ctx` : "";
      const tags = described.split(" · ").filter((part) => part && !/ctx$/.test(part));
      const line = [contextLabel || described.split(" · ")[0] || "", ...tags].filter(Boolean).join(" · ");
      if (line) meta.set(ref, line);
    }
    tui.setModelSuggestionMeta(meta);
  };

  const openModelPicker = (query = "") => {
    if (!tui) return false;
    const pickerQuery = String(query || "").trim();
    const nextLine = `/model ${pickerQuery}`.trimEnd() + " ";
    const activeModel = getCurrentModelTarget();
    const catalog = activeModel
      ? mergeModelCatalog(modelCatalogRef.value, [], [], [activeModel])
      : modelCatalogRef.value;
    const nextOptions = getFilteredModelSuggestions(pickerQuery, catalog);
    modelPickerRef.active = nextOptions.length > 0;
    modelPickerRef.query = pickerQuery;
    modelPickerRef.options = nextOptions;
    modelPickerRef.index = 0;
    commandPickerRef.active = false;
    commandPickerRef.mode = "command";
    commandPickerRef.options = [];
    commandPickerRef.index = 0;
    tui.clearCommandSuggestions();
    safeRlWrite(null, { ctrl: true, name: "u" });
    safeRlWrite(nextLine);
    currentInputRef.value = nextLine;
    applyModelSuggestionMeta(nextOptions);
    if (modelPickerRef.active) tui.setModelSuggestions(modelPickerRef.options, modelPickerRef.index);
    else tui.clearModelSuggestions();
    tui.renderInput(currentInputRef.value);
    return modelPickerRef.active;
  };
  const updateGoalStatus = (status = null) => {
    if (!tui || typeof tui.setGoalStatus !== "function") return;
    tui.setGoalStatus(status);
  };
  let escAbortTimer = null;
  let onKeypress = null;
  let onSigint = null;
  let onSigtstp = null;
  let onSigcont = null;
  let onMouseData = null;
  let renderLiveInput = () => {};
  let requestCurrentTaskAbort = () => false;
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
    const writeLineWithCursor = (nextLine, targetCursor = null) => {
      const text = String(nextLine || "");
      const cursor = Number.isFinite(targetCursor) ? Math.max(0, Math.min(text.length, targetCursor)) : text.length;
      safeRlWrite(null, { ctrl: true, name: "u" });
      if (text) safeRlWrite(text);
      const movesLeft = text.length - cursor;
      for (let i = 0; i < movesLeft; i += 1) safeRlWrite(null, { ctrl: true, name: "b" });
      currentInputRef.value = text;
      if (tui) tui.renderInput(text, cursor);
    };
    const submitCurrentLine = () => {
      if (rl && typeof rl.submit === "function") {
        rl.submit();
        return true;
      }
      if (rl && typeof rl._submitCurrentLine === "function") {
        rl._submitCurrentLine();
        return true;
      }
      return false;
    };
    onKeypress = (str, key = {}) => {
      key = key && typeof key === "object" ? key : {};
      if (isReadlineClosed()) return;
      if (approvalActiveRef.value || clarificationActiveRef.value) return;
      const keyNameRaw = String(key?.name || "");
      const keyName = keyNameRaw.toLowerCase();
      const enterPressed = keyName === "return" || keyName === "enter" || str === "\r" || str === "\n";
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

      if (isSuspendKey(str, key)) {
        process.kill(process.pid, "SIGTSTP");
        return;
      }

      if (isMultilineShortcut(str, key) && !(tui && tui.isOverlayOpen && tui.isOverlayOpen())) {
        // Insert a newline at cursor without submitting.
        safeRlWrite("\n");
        currentInputRef.value = String(rl.line || "");
        if (tui) tui.renderInput(currentInputRef.value);
        return;
      }

      if (tui) {
        if (tui.isOverlayOpen && tui.isOverlayOpen()) {
          if (tui.isOverlaySearchActive && tui.isOverlaySearchActive()) {
            if (!key.ctrl && !key.meta && !key.shift && key.name === "escape") {
              tui.cancelOverlaySearch();
              return;
            }
            if (!key.ctrl && !key.meta && enterPressed) {
              tui.submitOverlaySearch();
              return;
            }
            if (!key.ctrl && !key.meta && key.name === "backspace") {
              tui.backspaceOverlaySearch();
              return;
            }
            if (
              !key.ctrl &&
              !key.meta &&
              typeof str === "string" &&
              str &&
              str !== "\r" &&
              str !== "\n"
            ) {
              tui.appendOverlaySearch(str);
              return;
            }
            return;
          }
          if (!key.ctrl && !key.meta && !key.shift && (key.name === "/" || str === "/")) {
            tui.startOverlaySearch();
            return;
          }
          if (
            !key.ctrl &&
            !key.meta &&
            !key.shift &&
            key.name === "n" &&
            tui.getOverlayMode &&
            tui.getOverlayMode() === "llm-debug"
          ) {
            const entries = Array.isArray(llmHistoryRef.value.entries) ? llmHistoryRef.value.entries : [];
            if (entries.length > 0) {
              const next = ((Number(llmHistoryRef.value.index) || 0) + 1 + entries.length) % entries.length;
              llmHistoryRef.value.index = next;
              const payload = renderLlmDebugEntry(entries[next], next + 1, entries.length);
              tui.openOverlay(`LLM Debug ${next + 1}/${entries.length}`, payload, {
                mode: "llm-debug",
                hint: " /:search  n/p: entry  ctrl-n/p: section  j/k: scroll  J/K: req/resp  g: section end  ctrl-f/b: page  q: close ",
              });
            }
            return;
          }
          if (
            !key.ctrl &&
            !key.meta &&
            !key.shift &&
            key.name === "p" &&
            tui.getOverlayMode &&
            tui.getOverlayMode() === "llm-debug"
          ) {
            const entries = Array.isArray(llmHistoryRef.value.entries) ? llmHistoryRef.value.entries : [];
            if (entries.length > 0) {
              const prev = ((Number(llmHistoryRef.value.index) || 0) - 1 + entries.length) % entries.length;
              llmHistoryRef.value.index = prev;
              const payload = renderLlmDebugEntry(entries[prev], prev + 1, entries.length);
              tui.openOverlay(`LLM Debug ${prev + 1}/${entries.length}`, payload, {
                mode: "llm-debug",
                hint: " /:search  n/p: entry  ctrl-n/p: section  j/k: scroll  J/K: req/resp  g: section end  ctrl-f/b: page  q: close ",
              });
            }
            return;
          }
          if (!key.ctrl && !key.meta && !key.shift && key.name === "q") {
            tui.closeOverlay();
            return;
          }
          if (!key.ctrl && !key.meta && key.shift && key.name === "j") {
            tui.jumpOverlaySection("request");
            return;
          }
          if (!key.ctrl && !key.meta && key.shift && key.name === "k") {
            tui.jumpOverlaySection("response");
            return;
          }
          if (!key.ctrl && !key.meta && !key.shift && key.name === "j") {
            tui.scrollOverlayLines(1);
            return;
          }
          if (!key.ctrl && !key.meta && !key.shift && key.name === "k") {
            tui.scrollOverlayLines(-1);
            return;
          }
          if (!key.ctrl && !key.meta && !key.shift && key.name === "g") {
            tui.jumpOverlayCurrentSectionBottom();
            return;
          }
          if (key.ctrl && key.name === "n" && typeof tui.jumpOverlaySectionRelative === "function") {
            tui.jumpOverlaySectionRelative(1);
            return;
          }
          if (key.ctrl && key.name === "p" && typeof tui.jumpOverlaySectionRelative === "function") {
            tui.jumpOverlaySectionRelative(-1);
            return;
          }
          if (key.ctrl && key.name === "f") {
            tui.scrollOverlayPage(1);
            return;
          }
          if (key.ctrl && key.name === "b") {
            tui.scrollOverlayPage(-1);
            return;
          }
          return;
        }
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
        if (taskRunningRef.value) {
          const editableDuringRun =
            enterPressed ||
            keyName === "backspace" ||
            keyName === "delete" ||
            keyName === "left" ||
            keyName === "right" ||
            keyName === "home" ||
            keyName === "end" ||
            (key.ctrl && (keyName === "a" || keyName === "e" || keyName === "u")) ||
            (!key.ctrl && !key.meta && typeof str === "string" && str && str !== "\r" && str !== "\n");
          if (editableDuringRun && rl && typeof rl.handleKeypress === "function") {
            const submitted = rl.handleKeypress(str, key, { allowWithoutPending: true }) || {};
            currentInputRef.value = String(rl.line || "");
            if (tui) tui.renderInput(currentInputRef.value, Number.isFinite(rl.cursor) ? rl.cursor : null);
            if (submitted.submitted) {
              const commandText = stripMouseInputNoise(String(submitted.value || "")).trim();
              currentInputRef.value = "";
              if (tui) tui.renderInput("");
              if (commandText) {
                void handleNonInterruptingCommand(commandText, {
                  logLine,
                  tui,
                  agent,
                  providerRef,
                  traceRef,
                  taskTraceRef,
                  workspaceDir,
                  subagentsRef,
                  todosRef,
                  planModeRef,
                  contextWindowRef,
                  llmHistoryRef,
                  llmLastRef,
                  steerQueueRef,
                }).catch((err) => logLine(`command failed: ${String(err?.message || err)}`));
              }
            }
            return;
          }
        }
        if (isPickerCancelKey(str, key) && (modelPickerRef.active || commandPickerRef.active)) {
          modelPickerRef.active = false;
          modelPickerRef.query = "";
          modelPickerRef.options = [];
          modelPickerRef.index = 0;
          commandPickerRef.active = false;
          commandPickerRef.mode = "command";
          commandPickerRef.options = [];
          commandPickerRef.index = 0;
          tui.clearModelSuggestions();
          tui.clearCommandSuggestions();
          setImmediate(renderLiveInput);
          return;
        }
        if (key.ctrl && key.name === "c") {
          if (taskRunningRef.value) {
            const requested = requestCurrentTaskAbort();
            tui.clearInputHint();
            tui.render(currentInputRef.value, requested ? "aborting task..." : "no active task to abort");
            return;
          }
          if (emptyInput) {
            userExitRequestedRef.value = true;
            currentInputRef.value = "";
            tui.clearInputHint();
            tui.render("", "exiting");
            try {
              rl.close();
            } catch {
              // no-op
            }
            return;
          }
          exitArmedRef.value = false;
          suppressNextSubmitRef.value = false;
          pendingCommandSubmitRef.value = "";
          modelPickerRef.active = false;
          modelPickerRef.query = "";
          modelPickerRef.options = [];
          modelPickerRef.index = 0;
          commandPickerRef.active = false;
          commandPickerRef.mode = "command";
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
          openLlmDebugOverlay({ tui, llmHistoryRef, llmLastRef, logLine });
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

        const isPickerNavigationKey =
          keyName === "tab" || keyName === "up" || keyName === "down" || enterPressed;
        const isBareHistoryNavKey = !key.ctrl && !key.meta && !key.shift && (keyName === "up" || keyName === "down");

        if (!(isPickerNavigationKey && (modelPickerRef.active || commandPickerRef.active)) && !isBareHistoryNavKey) {
          const pickerQuery = getModelQueryFromInput(currentLine);
          if (pickerQuery !== null) {
            const nextOptions = getFilteredModelSuggestions(pickerQuery, modelCatalogRef.value);
            if (nextOptions.length > 0) {
              modelPickerRef.active = true;
              commandPickerRef.active = false;
              commandPickerRef.mode = "command";
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
              applyModelSuggestionMeta(modelPickerRef.options);
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
              const commandOptions = getSuggestionsForInput(
                currentLine,
                () => skillIndex,
                () => modelCatalogRef.value,
                () => getMcpServerNamesForSuggestions(),
                () => pluginIndex
              ).slice(0, 8);
              if (commandOptions.length > 0) {
                commandPickerRef.active = true;
                commandPickerRef.mode = "command";
                commandPickerRef.options = commandOptions;
                if (commandPickerRef.index >= commandOptions.length) commandPickerRef.index = 0;
                tui.setCommandSuggestions(commandPickerRef.options, commandPickerRef.index, "commands");
              } else {
                commandPickerRef.active = false;
                commandPickerRef.mode = "command";
                commandPickerRef.options = [];
                commandPickerRef.index = 0;
                tui.clearCommandSuggestions();
              }
            } else {
              const cursorNow = Number.isFinite(rl.cursor) ? Math.max(0, Math.floor(rl.cursor)) : currentLine.length;
              const mentionState = getFileMentionSuggestions(
                currentLine,
                cursorNow,
                fileMentionIndexRef.files,
                8
              );
              if (
                mentionState.mention &&
                mentionState.suggestions.length === 0 &&
                !fileMentionIndexRef.loading
              ) {
                refreshFileMentionIndex(true).catch(() => {});
              }
              if (mentionState.mention && mentionState.suggestions.length > 0) {
                commandPickerRef.active = true;
                commandPickerRef.mode = "file";
                commandPickerRef.options = mentionState.suggestions;
                if (commandPickerRef.index >= commandPickerRef.options.length) commandPickerRef.index = 0;
                tui.setCommandSuggestions(
                  commandPickerRef.options.map((item) => `@${item}`),
                  commandPickerRef.index,
                  "files"
                );
              } else if (commandPickerRef.active) {
                commandPickerRef.active = false;
                commandPickerRef.mode = "command";
                commandPickerRef.options = [];
                commandPickerRef.index = 0;
                tui.clearCommandSuggestions();
              }
            }
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
          if (enterPressed) {
            const selectedModel = modelPickerRef.options[modelPickerRef.index] || "";
            if (selectedModel) {
              const nextLine = `/model ${selectedModel}`;
              safeRlWrite(null, { ctrl: true, name: "u" });
              safeRlWrite(nextLine);
              currentInputRef.value = nextLine;
              if (tui) tui.renderInput(currentInputRef.value);
            }
            modelPickerRef.active = false;
            modelPickerRef.query = "";
            modelPickerRef.options = [];
            modelPickerRef.index = 0;
            tui.clearModelSuggestions();
            submitCurrentLine();
            return;
          }
        }

        if (commandPickerRef.active) {
          if (key.name === "tab") {
            const delta = key.shift ? -1 : 1;
            const len = commandPickerRef.options.length;
            commandPickerRef.index = (commandPickerRef.index + delta + len) % len;
            const selectedItem = commandPickerRef.options[commandPickerRef.index];
            if (commandPickerRef.mode === "file") {
              const cursorNow = Number.isFinite(rl.cursor) ? Math.max(0, Math.floor(rl.cursor)) : currentLine.length;
              const applied = applyFileMentionSelection(currentLine, cursorNow, selectedItem);
              if (applied) writeLineWithCursor(applied.line, applied.cursor);
              tui.setCommandSuggestions(
                commandPickerRef.options.map((item) => `@${item}`),
                commandPickerRef.index,
                "files"
              );
            } else {
              writeLineWithCursor(selectedItem);
              tui.setCommandSuggestions(commandPickerRef.options, commandPickerRef.index, "commands");
            }
            return;
          }
          if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            const len = commandPickerRef.options.length;
            commandPickerRef.index = (commandPickerRef.index + delta + len) % len;
            if (commandPickerRef.mode === "file") {
              tui.setCommandSuggestions(
                commandPickerRef.options.map((item) => `@${item}`),
                commandPickerRef.index,
                "files"
              );
            } else {
              tui.setCommandSuggestions(commandPickerRef.options, commandPickerRef.index, "commands");
            }
            return;
          }
          if (enterPressed) {
            const selectedItem = commandPickerRef.options[commandPickerRef.index];
            const nextLine = applyCommandPickerSelectionForSubmit({
              currentLine,
              mode: commandPickerRef.mode,
              selectedItem,
            });
            if (nextLine !== currentLine) writeLineWithCursor(nextLine);
            commandPickerRef.active = false;
            commandPickerRef.mode = "command";
            commandPickerRef.options = [];
            commandPickerRef.index = 0;
            tui.clearCommandSuggestions();
            submitCurrentLine();
            return;
          }
        }

        setImmediate(renderLiveInput);
      }

      if (tui) return;

      const cursorNow = Number.isFinite(rl.cursor) ? Math.max(0, Math.floor(rl.cursor)) : currentLine.length;
      const mentionState = getFileMentionSuggestions(currentLine, cursorNow, fileMentionIndexRef.files, 8);
      if (mentionState.mention) {
        if (mentionState.suggestions.length === 0 && !fileMentionIndexRef.loading) {
          refreshFileMentionIndex(true).catch(() => {});
        }
        if (mentionState.suggestions.length > 0) {
          if (display) display.showSuggestions(mentionState.suggestions.map((item) => `@${item}`));
          return;
        }
      }

      if (!currentLine.trimStart().startsWith("/")) {
        if (display) display.clearSuggestions();
        return;
      }

      const suggestions = getSuggestionsForInput(
        currentLine,
        () => skillIndex,
        () => modelCatalogRef.value,
        () => getMcpServerNamesForSuggestions(),
        () => pluginIndex
      ).slice(0, 8);
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
  if (tui && tui.isMouseCaptureEnabled && tui.isMouseCaptureEnabled()) {
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
      if (approvalActiveRef.value || clarificationActiveRef.value) return;
      if (!Array.isArray(parsed.deltas) || parsed.deltas.length === 0) return;
      for (const delta of parsed.deltas) tui.scrollLines(delta);
    };
    filteredInput.on("data", onMouseData);
  }

  const switchModel = async (modelId) => {
    const parsed = parseModelTarget(modelId);
    const selectedModel = parsed.model;
    if (!selectedModel) throw new Error("Model id is required");

    // Provider resolution order: explicit `provider:model` prefix, then the
    // registry's inference for the bare id, then whatever is already active.
    const inferredProvider = parsed.provider || inferProviderForModel(selectedModel);
    const nextProviderName =
      normalizeProviderId(inferredProvider) ||
      normalizeProviderId(providerOptionsRef.value.provider) ||
      normalizeProviderId(settings.provider) ||
      null;

    if (nextProviderName && isKnownProvider(nextProviderName)) {
      const config = resolveProviderConfig(nextProviderName, { settings });
      if (!config.configured) {
        throw new Error(
          `${config.spec.label} is not configured — ${describeProviderSetup(nextProviderName)}, then retry.`
        );
      }
    }

    const providerSettings =
      nextProviderName && isRecord(settings?.providers) && isRecord(settings.providers[nextProviderName])
        ? settings.providers[nextProviderName]
        : {};
    const resolved = nextProviderName && isKnownProvider(nextProviderName)
      ? resolveProviderConfig(nextProviderName, { settings })
      : null;

    providerOptionsRef.value = {
      ...providerOptionsRef.value,
      provider: nextProviderName,
      model: selectedModel,
      settings,
      thinkingEffort:
        providerOptionsRef.value.thinkingEffort ??
        (providerSettings.thinkingEffort ||
          providerSettings.thinking_effort ||
          providerSettings.reasoningEffort ||
          providerSettings.reasoning_effort ||
          settings.thinkingEffort ||
          settings.thinking_effort ||
          settings.reasoningEffort ||
          settings.reasoning_effort ||
          null),
    };
    if (inferredProvider) {
      // Switching providers must not carry the previous provider's credentials.
      providerOptionsRef.value.apiKey = resolved?.apiKey || null;
      providerOptionsRef.value.baseUrl = resolved?.baseUrl || null;
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
    modelCatalogRef.value = getUsableModelCatalog(
      mergeModelCatalog(
        MODEL_SUGGESTIONS,
        [],
        [],
        collectModelsFromSettings(settings)
      ),
      settings,
      collectModelsFromSettings(settings)
    );
    const nextContextLimit = resolveContextWindow({
      modelName: nextProvider?.model,
      providerName: providerPrefix(nextProvider?.kind),
      settings,
      dynamicByModel: modelContextWindowsRef.value,
    });
    contextWindowRef.value = nextContextLimit;
    if (tui) {
      tui.onModelCall(formatProviderModel(nextProvider));
      tui.setContextUsage(0, nextContextLimit);
      tui.onThinkingDone();
    }
    return nextProvider;
  };

  const askClarification = async ({ question, options, multiple = false, required = true } = {}) => {
    const normalizedOptions = normalizeClarificationOptions(options);
    const prompt = String(question || "").trim();
    if (!prompt || normalizedOptions.length === 0) return { selected: [] };
    const nonInteractive = oneShotPromptMode || !filteredInput.isTTY || isReadlineClosed();
    if (nonInteractive || !tui) {
      logLine(`[clarify] ${prompt}`);
      normalizedOptions.forEach((option, index) => {
        logLine(`[clarify] ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);
      });
      logLine("[clarify] unavailable in non-interactive mode; no option selected");
      return { cancelled: true, selected: [], nonInteractive: true };
    }
    clarificationActiveRef.value = true;
    try {
      const result = await waitForTuiClarification({
        stdinStream: keypressSource,
        tui,
        question: prompt,
        options: normalizedOptions,
        multiple,
        required,
      });
      tui.render(currentInputRef.value, result.cancelled ? "clarification cancelled" : "clarification answered");
      return result;
    } finally {
      clarificationActiveRef.value = false;
      tui.clearClarificationPrompt?.();
    }
  };

  const askApproval = async (q, details = null) => {
    let approvalMeta = null;
    if (q === "shell" && details && typeof details === "object") {
      const classificationLevel = String(details?.classification?.level || "unclassified");
      if (classificationLevel === "safe") return "allow_once";
      const reason = String(details?.classification?.reason || "");
      const cmdPreview = summarizeForLog(String(details?.command || ""), 220);
      q = `shell: ${cmdPreview}${reason ? ` (${reason})` : ""}`;
      approvalMeta = {
        question: "Approve shell command?",
        command: cmdPreview,
        reason,
        risk: classificationLevel,
      };
    }
    let ans = "";
    const defaultYes = false;
    const nonInteractiveApproval =
      !tui && (oneShotPromptMode || !filteredInput.isTTY || isReadlineClosed());
    if (nonInteractiveApproval) {
      const approved = Boolean(autoApproveRef.value || oneShotPromptMode);
      logLine(
        approved
          ? `[approve] auto-approved ${q} (non-interactive mode)`
          : `[approve] denied ${q} (non-interactive mode)`
      );
      return approved ? "allow_once" : "deny";
    }
    if (tui) {
      const compactPrompt = q.replace(/\s+/g, " ").trim();
      approvalActiveRef.value = true;
      tui.setApprovalPrompt(compactPrompt, defaultYes, approvalMeta);
      const approved = await waitForTuiApproval({ stdinStream: keypressSource, defaultYes });
      approvalActiveRef.value = false;
      tui.clearApprovalPrompt();
      tui.render(currentInputRef.value, "approval handled");
      return approved;
    } else {
      const prompt = `${q}\nApprove? [y] once, [r] remember command for session, [a] allow all for session, [n] no: `;
      ans = (await rl.question(prompt)).trim().toLowerCase();
      if (rl.history?.[0] === ans) rl.history.shift();
    }
    if (!ans && defaultYes) return "allow_once";
    if (ans === "y" || ans === "yes") return "allow_once";
    if (ans === "r" || ans === "remember") return "remember_command";
    if (ans === "a" || ans === "all" || ans === "always") return "allow_all_session";
    return "deny";
  };

  // Durable working state for long-horizon runs: loaded once, then written
  // back on a short debounce so a crashed or resumed session keeps its plan.
  const ledgerRef = { value: await loadLedger(workspaceDir) };
  let ledgerSaveTimer = null;
  let ledgerSavePending = false;
  const flushLedgerSave = async () => {
    if (ledgerSaveTimer) {
      clearTimeout(ledgerSaveTimer);
      ledgerSaveTimer = null;
    }
    if (!ledgerSavePending) return;
    ledgerSavePending = false;
    await saveLedger(workspaceDir, ledgerRef.value);
  };
  const scheduleLedgerSave = () => {
    ledgerSavePending = true;
    if (ledgerSaveTimer) return;
    ledgerSaveTimer = setTimeout(() => {
      ledgerSaveTimer = null;
      flushLedgerSave().catch(() => {});
    }, 400);
    if (typeof ledgerSaveTimer.unref === "function") ledgerSaveTimer.unref();
  };

  const logMcpConfiguredServers = (hub) => {
    if (!hub || typeof hub.hasServers !== "function" || !hub.hasServers()) {
      logLine("[mcp] no configured servers");
      return;
    }
    const names = hub.getServerNames();
    logLine(`[mcp] configured servers: ${names.join(", ")}`);
  };

  if (oneShotPromptMode) {
    const mergedMcpSettings = await mergeCommonMcpServers(settings, {
      workspaceDir,
      onLog: (line) => logLine(line),
    });
    mcpHubRef.value = new McpHub({
      workspaceDir,
      settings: mergedMcpSettings,
      onLog: (line) => logLine(line),
    });
    logMcpConfiguredServers(mcpHubRef.value);
  }

  const agent = new Agent({
    provider: providerRef.value,
    workspaceDir,
    autoApproveRef,
    askApproval,
    askClarification,
    activeSkillsRef,
    activePluginsRef,
    projectInstructionsRef,
    memoryRef,
    agentDefinitionsRef,
    getSteers: () => {
      const items = steerQueueRef.value;
      steerQueueRef.value = [];
      return items;
    },
    mcpHub: mcpHubRef.value,
    webSearch: settings?.webSearch || settings?.tools?.web?.search || null,
    contextWindowRef,
    shellPermissionRef,
    ledgerRef,
    onLedgerUpdate: scheduleLedgerSave,
    onTodoWrite: (nextTodos) => {
      applyTodoState(todosRef, nextTodos, {
        sessionBus,
        tui,
        autoTrackRef: todoAutoTrackRef,
        autoTrack: false,
      });
    },
    onMemoryWrite: (result) => {
      if (result?.scope) {
        logLine(`[memory] saved ${result.scope}: ${result.relPath || result.path}`);
      }
    },
    onEvent: createAgentEventHandler({
      sessionBus,
      recordTaskEvent,
      taskTraceRef,
      updateSubagentState,
      subagentsRef,
      logLine,
      summarizeForLog,
      formatProviderModel,
      tui,
      display,
      shouldAutoTrackTodosFromPlan,
      seedTodosFromPlan,
      applyTodoState,
      todosRef,
      todoAutoTrackRef,
      refreshTuiContextUsage,
      formatCompactNumber,
      inferEndpointForProvider,
      providerOptionsRef,
      providerRef,
      llmLastRef,
      trackLlmDebugEvent,
      llmHistoryRef,
      persistLlmSessionEvent,
      workspaceDir,
      traceStateRef,
      recordTaskLlm,
      traceRef,
      llmStreamRef,
      estimateTokenCount,
      addPendingRequestTokens,
      summarizeThinkingResponseForLog,
      appendThinkingToLlmDebugEvent,
      extractThinkingFromFinalModelPayload,
      extractReadableThinkingPreview,
      formatStageUpdate,
      normalizeTokenUsage,
      consumePendingRequestTokens,
      providerPrefix,
      verboseToolLogs,
      formatToolBatchSummary,
      formatToolCounts,
      formatToolInputSummary,
      formatReadableToolRunLine,
      formatToolResultLinesForTimeline,
      advanceTodosOnToolStart,
    }),
  });

  const baseAgentOnEvent = agent.onEvent;
  agent.onEvent = (evt) => {
    if (evt?.type === "steer_applied") {
      logLine(`[steer] applied to current task: ${summarizeForLog(evt.content || "", 180)}`);
    }
    baseAgentOnEvent?.(evt);
  };
  requestCurrentTaskAbort = () => {
    const shellAbort = directShellAbortRef.value;
    if (shellAbort && !shellAbort.signal?.aborted) {
      shellAbort.abort();
      return true;
    }
    return agent.requestAbort();
  };
  onSigint = () => {
    if (taskRunningRef.value) {
      const requested = requestCurrentTaskAbort();
      if (tui) {
        tui.clearInputHint();
        tui.render(currentInputRef.value, requested ? "aborting task..." : "no active task to abort");
      }
      return;
    }
    if (tui) {
      userExitRequestedRef.value = true;
      currentInputRef.value = "";
      tui.clearInputHint();
      tui.render("", "exiting");
    }
    try {
      rl.close();
    } catch {
      // no-op
    }
  };
  process.on("SIGINT", onSigint);

  onSigtstp = () => {
    if (process.platform === "win32") return;
    const draft = stripMouseInputNoise(String(rl?.line || currentInputRef.value || ""));
    currentInputRef.value = draft;
    if (escAbortTimer) {
      clearTimeout(escAbortTimer);
      escAbortTimer = null;
    }
    escAbortArmedRef.value = false;
    try {
      if (tui) tui.stop();
    } catch {
      // best effort
    }
    try {
      destroyKeypressSource.suspend?.();
    } catch {
      // best effort
    }
    process.once("SIGCONT", onSigcont);
    process.kill(process.pid, "SIGSTOP");
  };
  onSigcont = () => {
    try {
      destroyKeypressSource.resume?.();
    } catch {
      // best effort
    }
    if (tui) {
      tui.start();
      tui.render(currentInputRef.value, taskRunningRef.value ? "resumed; task still running" : "resumed");
    }
  };
  if (useTui && process.platform !== "win32") process.on("SIGTSTP", onSigtstp);

  if (startupResumeSession) {
    agent.history = Array.isArray(startupResumeSession.agentHistory) ? startupResumeSession.agentHistory : [];
    applyTodoState(todosRef, Array.isArray(startupResumeSession.todos) ? startupResumeSession.todos : [], {
      sessionBus,
      tui,
      autoTrackRef: todoAutoTrackRef,
      autoTrack: false,
    });
  }

  const refreshMcpHub = async ({ announce = true } = {}) => {
    const merged = await mergeCommonMcpServers(settings, {
      workspaceDir,
      onLog: announce ? (line) => logLine(line) : null,
    });
    const nextHub = new McpHub({
      workspaceDir,
      settings: merged,
      onLog: (line) => logLine(line),
    });
    const previousHub = mcpHubRef.value;
    mcpHubRef.value = nextHub;
    if (typeof agent.setMcpHub === "function") {
      agent.setMcpHub(nextHub);
    } else {
      agent.mcpHub = nextHub;
    }
    if (announce) {
      logMcpConfiguredServers(nextHub);
    }
    if (previousHub && previousHub !== nextHub) {
      await previousHub.close();
    }
    return nextHub;
  };

  const startupMcpReady = oneShotPromptMode
    ? Promise.resolve(mcpHubRef.value)
    : refreshMcpHub({ announce: true }).catch((err) => {
        logLine(`[mcp] startup load failed: ${String(err?.message || err)}`);
        return null;
      });

  let shutdownComplete = false;
  const shutdown = async ({ announceSession = false, savedSession = null } = {}) => {
    if (shutdownComplete) return;
    shutdownComplete = true;
    const exitSummaryLines = announceSession
      ? formatSessionExitSummary(savedSession || { sessionId: taskTraceRef.sessionId })
      : [];
    try {
      await saveHistory(historyFile, rl.history);
    } finally {
      if (mcpHubRef.value) await mcpHubRef.value.close();
      if (tmuxSubagentWatcher && typeof tmuxSubagentWatcher.close === "function") tmuxSubagentWatcher.close();
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
      if (onSigint) {
        process.off("SIGINT", onSigint);
      }
      if (onSigtstp) {
        process.off("SIGTSTP", onSigtstp);
      }
      if (onSigcont) {
        process.off("SIGCONT", onSigcont);
      }
      if (tui) tui.stop();
      rl.close();
      for (const line of exitSummaryLines) console.log(line);
    }
  };

  if (args.prompt !== null) {
    try {
      startTaskTrace(taskTraceRef, { sessionBus, input: args.prompt, kind: "agent" });
      const localInfo = maybeHandleLocalInfoTask(args.prompt, { logLine, tui, display, mcpHub: mcpHubRef.value });
      if (localInfo.handled) {
        const saved = await finishTaskTrace(taskTraceRef, workspaceDir, { status: "done", sessionBus });
        if (saved) console.log(`session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
        return;
      }
      if (tui) tui.setProjectInstructionsVisible(false);
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
      const autoPluginResult = await autoEnablePlugins(args.prompt, activePluginsRef, pluginIndex);
      if (autoPluginResult.enabled.length > 0) {
        console.log(`auto-enabled plugins: ${autoPluginResult.enabled.join(", ")}`);
      }

      try {
        clearPendingRequestTokens();
        const mentionContext = await buildFileMentionContext(args.prompt, { cwd: workspaceDir, memoryRef });
        if (mentionContext.mentions.some((item) => item.status === "inline" || item.status === "preview")) {
          const inlineCount = mentionContext.mentions.filter((item) => item.status === "inline").length;
          const previewCount = mentionContext.mentions.filter((item) => item.status === "preview").length;
          console.log(`attached referenced files: ${inlineCount} inline, ${previewCount} preview`);
        }
        const result = await agent.runTurn(mentionContext.prompt, { planOnly: planModeRef.value });
        const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        if (display) {
          display.onResponse(output);
        } else {
          console.log(`\n${output}`);
        }
        const saved = await finishTaskTrace(taskTraceRef, workspaceDir, { status: "done", sessionBus });
        if (saved) console.log(`session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
      } catch (err) {
        const saved = await finishTaskTrace(taskTraceRef, workspaceDir, {
          status: "error",
          error: String(err?.message || "error"),
          sessionBus,
        });
        if (saved) console.error(`session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
        throw err;
      } finally {
        clearPendingRequestTokens();
        if (tui) refreshTuiContextUsage();
      }
    } finally {
      await shutdown();
    }
    return;
  }

  if (tui) {
    contextWindowRef.value = resolveProviderContextLimit(providerRef.value);
    tui.setContextUsage(0, contextWindowRef.value);
    emitStartupLogo(tui, providerRef.value, workspaceDir);
    if (activeSkillsRef.value.length > 0) {
      tui.event(`skills: ${activeSkillsRef.value.map((s) => s.name).join(", ")}`);
    }
    if (activePluginsRef.value.length > 0) {
      tui.event(`plugins: ${activePluginsRef.value.map((p) => p.name).join(", ")}`);
    }
    if (startupAutoSkills.enabled.length > 0) {
      tui.event(`auto-loaded skills: ${startupAutoSkills.enabled.join(", ")}`);
    }
    if (startupAutoSkills.missing.length > 0) {
      tui.event(`warning: auto-load skills missing: ${startupAutoSkills.missing.join(", ")}`);
    }
    if (planModeRef.value) {
      tui.event("plan mode: on (safe read-only tools allowed, no file changes)");
    }
    if (startupResumeSession && typeof tui.restoreSessionTimeline === "function") {
      tui.restoreSessionTimeline(Array.isArray(startupResumeSession.timeline) ? startupResumeSession.timeline : startupResumeSession.messages || []);
    }
    if (startupResumeSession) {
      tui.event(`resumed session ${startupResumeSession.sessionId} (${startupResumeSession.messages?.length || agent.history.length} messages)`);
      refreshTuiContextUsage?.();
    }
    tui.start();
    tui.render(currentInputRef.value, "Type /help for commands");
    startupMark("first-render");
    setImmediate(() => {
      refreshFileMentionIndex().catch(() => {});
    });
  } else {
    console.log(`Pie Code (${formatProviderModel(providerRef.value)})`);
    const providerWarning = formatProviderWarning(providerRef.value);
    if (providerWarning) {
      console.error(providerWarning);
    }
    if (projectInstructionsRef.value?.source) {
      console.log(`loaded project instructions: ${projectInstructionsRef.value.source}`);
    }
    const loadedMemoryScopes = ["global", "project"].filter((scope) => String(memoryRef.value?.[scope]?.content || "").trim());
    if (loadedMemoryScopes.length > 0) {
      console.log(`loaded memory: ${loadedMemoryScopes.join(", ")}`);
    }
    if (activeSkillsRef.value.length > 0) {
      console.log(`skills: ${activeSkillsRef.value.map((s) => s.name).join(", ")}`);
    }
    if (activePluginsRef.value.length > 0) {
      console.log(`plugins: ${activePluginsRef.value.map((p) => p.name).join(", ")}`);
    }
    if (startupAutoSkills.enabled.length > 0) {
      console.log(`auto-loaded skills: ${startupAutoSkills.enabled.join(", ")}`);
    }
    if (startupAutoSkills.missing.length > 0) {
      console.error(`warning: auto-load skills missing: ${startupAutoSkills.missing.join(", ")}`);
    }
    if (planModeRef.value) {
      console.log("plan mode: on (safe read-only tools allowed, no file changes)");
    }
    if (startupResumeSession) {
      console.log(`resumed session ${startupResumeSession.sessionId} (${startupResumeSession.messages?.length || agent.history.length} messages)`);
      refreshTuiContextUsage?.();
    }
    console.log("Type /help for commands.");
    startupMark("first-text");
    refreshFileMentionIndex().catch(() => {});
  }

  while (true) {
    currentInputRef.value = "";
    if (tui) {
      const preserveStatus = keepIdleStatusRef.value;
      keepIdleStatusRef.value = false;
      tui.render(currentInputRef.value, preserveStatus ? "" : "waiting for input");
    }
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
        commandPickerRef.mode = "command";
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
        if (userExitRequestedRef.value) break;
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
      if (planModeRef.value) {
        const commandText = String(finalInput.slice(1) || "").trim();
        const classification = classifyShellCommand(commandText);
        if (classification.level !== "safe") {
          logLine(
            `plan mode only allows safe direct shell commands. blocked (${classification.reason}). Use /plan off to run this command.`
          );
          currentInputRef.value = "";
          continue;
        }
      }
      startTaskTrace(taskTraceRef, { sessionBus, input: finalInput, kind: "shell" });
      currentInputRef.value = "";
      if (tui) tui.setProjectInstructionsVisible(false);
      if (tui) tui.render(currentInputRef.value, "running shell command");
      taskRunningRef.value = true;
      const shellAbort = new AbortController();
      directShellAbortRef.value = shellAbort;
      let shellResult = null;
      try {
        shellResult = await runDirectShellCommand(finalInput.slice(1), {
          workspaceDir,
          logLine,
          tui,
          display,
          signal: shellAbort.signal,
        });
        const saved = await finishTaskTrace(taskTraceRef, workspaceDir, {
          status: shellResult?.ok ? "done" : shellResult?.aborted ? "aborted" : "error",
          error: shellResult?.ok ? "" : String(shellResult?.error || ""),
          sessionBus,
        });
        if (saved) logLine(`[trace] session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
      } finally {
        directShellAbortRef.value = null;
        taskRunningRef.value = false;
        escAbortArmedRef.value = false;
        if (escAbortTimer) {
          clearTimeout(escAbortTimer);
          escAbortTimer = null;
        }
        if (tui) tui.clearInputHint();
      }
      continue;
    }
    const isSlash = finalInput.startsWith("/");
    if (!isSlash) {
      startTaskTrace(taskTraceRef, { sessionBus, input: finalInput, kind: "agent" });
      logLine(`[task] ${finalInput}`);
      if (tui) tui.setProjectInstructionsVisible(false);
    }
    currentInputRef.value = "";
    if (tui) {
      const status = isSlash
        ? "handling command"
        : planModeRef.value
          ? "planning task (safe tools only)"
          : "processing task";
      tui.render(currentInputRef.value, status);
    }
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
      pluginIndex,
      activePluginsRef,
      refreshPluginIndex,
      logLine,
      rl,
      skillRoots,
      refreshSkillIndex,
      tui,
      setModel: switchModel,
      setStatusBar,
      openModelPicker,
      planModeRef,
      settings,
      settingsFile,
      workspaceDir,
      mcpHubRef,
      refreshMcpHub,
      modelCatalogRef,
      modelContextWindowsRef,
      modelContextMetadataRef,
      todosRef,
      todoAutoTrackRef,
      llmLastRef,
      llmHistoryRef,
      taskTraceRef,
      contextWindowRef,
      sessionBus,
      refreshTuiContextUsage,
      commandRunRef,
      subagentsRef,
      pendingAttachmentsRef,
      ledgerRef,
    });
    if (slash.done) {
      await saveCliResumableSession({
        workspaceDir,
        taskTraceRef,
        agent,
        todosRef,
        providerRef,
        logLine,
      });
      break;
    }
    if (slash.handled) {
      if (display) display.clearSuggestions();
      if (!slash.preserveInput) currentInputRef.value = "";
      continue;
    }

    const commandRun = commandRunRef.value;
    commandRunRef.value = null;
    let agentInput = commandRun?.input || finalInput;
    const goalRun = commandRun?.goal ? createGoalRun(commandRun.goal, { env: process.env }) : null;
    if (commandRun) {
      startTaskTrace(taskTraceRef, { sessionBus, input: finalInput, kind: "agent" });
      const owner = commandRun.skillName || commandRun.pluginName || "";
      const goalSummary = commandRun.goal ? ` ${summarizeForLog(commandRun.goal, 180)}` : "";
      if (!goalRun) {
        logLine(`[task] ${commandRun.displayName}${goalSummary} ${owner ? `(${owner})` : ""}`.trim());
      }
      if (goalRun) {
        logLine(`[goal] loop started (max ${goalRun.maxIterations} turns)`);
        updateGoalStatus({
          active: true,
          label: goalRun.goal,
          iteration: goalRun.iteration,
          maxIterations: goalRun.maxIterations,
          status: goalRun.status,
        });
      }
      if (goalRun && planModeRef.value) logLine("[goal] executing with plan mode off for this goal loop");
      if (tui) tui.setProjectInstructionsVisible(false);
    }

    await startupMcpReady;
    const localTask = maybeHandleLocalInfoTask(agentInput, { logLine, tui, display, mcpHub: mcpHubRef.value });
    if (localTask.handled) {
      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, { status: "done", sessionBus });
      if (saved) logLine(`[trace] session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
      if (display) display.clearSuggestions();
      currentInputRef.value = "";
      continue;
    }

    await Promise.all([
      maybeAutoEnableSkills(agentInput, activeSkillsRef, skillIndex, logLine),
      maybeAutoEnablePlugins(agentInput, activePluginsRef, pluginIndex, logLine),
    ]);
    const turnAttachments = Array.isArray(pendingAttachmentsRef.value) ? pendingAttachmentsRef.value : [];
    pendingAttachmentsRef.value = [];
    if (turnAttachments.length > 0) {
      logLine(`[attachments] ${turnAttachments.map((item) => formatAttachmentSummary(item)).join(", ")}`);
    }
    taskRunningRef.value = true;
    let turnResult = null;
    try {
      while (true) {
        clearPendingRequestTokens();
        turnResult = await runAgentTurn(
          agent,
          agentInput,
          tui,
          logLine,
          display,
          workspaceDir,
          {
            planOnly: goalRun ? goalRun.planOnly : planModeRef.value,
            attachments: goalRun && goalRun.iteration > 1 ? [] : turnAttachments,
          }
        );
        if (!turnResult?.ok || !goalRun) break;

        goalRun.lastOutput = turnResult.output || "";
        goalRun.status = parseGoalStatus(goalRun.lastOutput);
        goalRun.lastCheckpoint = summarizeGoalOutput(goalRun.lastOutput);
        updateGoalStatus({
          active: true,
          label: goalRun.goal,
          iteration: goalRun.iteration,
          maxIterations: goalRun.maxIterations,
          status: goalRun.status,
        });
        logLine(`[goal] status=${goalRun.status} turn=${goalRun.iteration}/${goalRun.maxIterations}`);
        if (goalRun.status === "complete" || goalRun.status === "blocked") break;
        if (goalRun.iteration >= goalRun.maxIterations) {
          updateGoalStatus({
            active: true,
            label: goalRun.goal,
            iteration: goalRun.iteration,
            maxIterations: goalRun.maxIterations,
            status: "maxed",
          });
          logLine("[goal] max goal turns reached; stopping for user review");
          break;
        }
        goalRun.iteration += 1;
        updateGoalStatus({
          active: true,
          label: goalRun.goal,
          iteration: goalRun.iteration,
          maxIterations: goalRun.maxIterations,
          status: "continue",
        });
        agentInput = buildGoalContinuationPrompt(goalRun.goal, goalRun.iteration, goalRun.lastOutput, {
          maxIterations: goalRun.maxIterations,
          checkpoint: goalRun.lastCheckpoint,
        });
      }

      const saved = await finishTaskTrace(taskTraceRef, workspaceDir, {
        status: turnResult?.ok ? "done" : turnResult?.aborted ? "aborted" : "error",
        error: turnResult?.ok ? "" : String(turnResult?.error || ""),
        sessionBus,
      });
      if (saved) logLine(`[trace] session trace saved: .piecode/sessions/${saved.sessionId} (${saved.id})`);
    } finally {
      if (goalRun) {
        updateGoalStatus(
          turnResult?.ok
            ? {
                active: true,
                label: goalRun.goal,
                iteration: goalRun.iteration,
                maxIterations: goalRun.maxIterations,
                status: goalRun.status || "complete",
              }
            : null
        );
      } else {
        updateGoalStatus(null);
      }
      clearPendingRequestTokens();
      if (tui) refreshTuiContextUsage();
      taskRunningRef.value = false;
      escAbortArmedRef.value = false;
      if (escAbortTimer) {
        clearTimeout(escAbortTimer);
        escAbortTimer = null;
      }
      if (tui) tui.clearInputHint();
    }
    if (todoAutoTrackRef.value) {
      const advancedAfterTurn = advanceTodosOnTurnDone(todosRef.value);
      if (advancedAfterTurn.length > 0) {
        applyTodoState(todosRef, advancedAfterTurn, {
          sessionBus,
          tui,
        });
      }
    }
    await saveCliResumableSession({
      workspaceDir,
      taskTraceRef,
      agent,
      todosRef,
      providerRef,
      logLine: traceRef.value ? logLine : null,
    });
    if (traceRef.value) {
      const elapsed = traceStateRef.value.turnStartedAt
        ? Date.now() - traceStateRef.value.turnStartedAt
        : 0;
      logLine(`[trace] turn_end id=${traceStateRef.value.turnId} duration=${elapsed}ms`);
    }
    currentInputRef.value = "";
  }

  const finalSavedSession = await saveCliResumableSession({
    workspaceDir,
    taskTraceRef,
    agent,
    todosRef,
    providerRef,
    force: true,
  });
  await shutdown({ announceSession: true, savedSession: finalSavedSession });
}

main().catch((err) => {
  const detail = err?.stack || err?.message || String(err);
  console.error(`fatal: ${detail}`);
  process.exit(1);
});

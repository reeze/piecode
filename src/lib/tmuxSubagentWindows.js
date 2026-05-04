import { spawn as spawnDefault } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const SUBAGENT_EVENT_TYPES = new Set([
  "agent.subagent_start",
  "agent.subagent_event",
  "agent.subagent_end",
]);

function clip(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const limit = Math.max(20, Number(max) || 500);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toLocaleTimeString();
  return date.toLocaleTimeString();
}

function stringifyCompact(value, max = 260) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return clip(value, max);
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return clip(String(value), max);
  }
}

export function shellQuote(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeTmuxWindowName(value, { prefix = "pie", maxLength = 28 } = {}) {
  const raw = String(value || "agent").trim() || "agent";
  const safe = raw
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(4, maxLength - String(prefix).length - 1));
  return `${prefix}:${safe || "agent"}`;
}

export function resolveTmuxSubagentOptions({ args = {}, env = process.env, workspaceDir = process.cwd(), sessionId = "" } = {}) {
  const enabled = Boolean(args.tmuxSubagents) || String(env.PIECODE_TMUX_SUBAGENTS || "").trim() === "1";
  const inTmux = Boolean(String(env.TMUX || "").trim());
  const configuredEventsFile = String(env.PIECODE_SESSION_EVENTS_FILE || "").trim();
  const eventsFile = configuredEventsFile || path.join(path.resolve(workspaceDir), ".piecode", "sessions", String(sessionId || "tmux"), "events.jsonl");
  return {
    enabled,
    available: enabled && inTmux,
    eventsFile,
    reason: enabled ? (inTmux ? "enabled" : "not-in-tmux") : "disabled",
  };
}

export function isSubagentSessionEvent(event, subagentId = "") {
  const e = event && typeof event === "object" ? event : null;
  if (!e || !SUBAGENT_EVENT_TYPES.has(String(e.type || ""))) return false;
  const target = String(subagentId || "").trim();
  if (!target) return true;
  return String(e.payload?.id || "") === target;
}

export function formatSubagentEventLine(event) {
  const e = event && typeof event === "object" ? event : {};
  const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
  const time = formatTime(e.at);
  const id = String(payload.id || "subagent");
  const role = String(payload.role || payload.agentDefinition?.name || "subagent");
  const prefix = `[${time}]`;

  if (e.type === "agent.subagent_start") {
    const details = [
      `${prefix} start ${role} (${id})`,
      payload.mode ? `mode=${payload.mode}` : "",
      payload.toolBudget ? `budget=${payload.toolBudget}` : "",
    ].filter(Boolean).join(" | ");
    const task = clip(payload.task || "", 800);
    return task ? `${details}\n  task: ${task}` : details;
  }

  if (e.type === "agent.subagent_end") {
    const status = String(payload.status || "done");
    const tools = Array.isArray(payload.tools) && payload.tools.length > 0 ? ` | tools=${payload.tools.join(",")}` : "";
    const error = payload.error ? ` | error=${clip(payload.error, 500)}` : "";
    return `${prefix} ${status} ${role} (${id})${tools}${error}`;
  }

  if (e.type === "agent.subagent_event") {
    const child = payload.event && typeof payload.event === "object" ? payload.event : {};
    const childType = String(child.type || "event");
    if (childType === "tool_use" || childType === "tool_start") {
      const input = stringifyCompact(child.input, 360);
      return `${prefix} ${childType} ${child.tool || "tool"}${input ? ` ${input}` : ""}`;
    }
    if (childType === "tool_end") {
      const status = child.error ? "error" : "ok";
      const info = stringifyCompact(child.error || child.result, 360);
      return `${prefix} tool_end ${child.tool || "tool"} ${status}${info ? ` ${info}` : ""}`;
    }
    if (childType === "model_call" || childType === "planning_call" || childType === "replanning_call") {
      return `${prefix} ${childType} ${[child.provider, child.model].filter(Boolean).join(":") || "model"}`;
    }
    if (childType === "thought") {
      return `${prefix} thought ${clip(child.content || "", 500)}`;
    }
    if (childType === "llm_response") {
      return `${prefix} llm_response ${child.stage || ""} ${clip(child.payload || "", 360)}`.trimEnd();
    }
    return `${prefix} ${childType}`;
  }

  return `${prefix} ${String(e.type || "event")}`;
}

function buildWatcherCommand({ cliPath, eventsFile, subagentId }) {
  return [
    shellQuote(process.execPath),
    shellQuote(cliPath),
    "--watch-subagent-events",
    shellQuote(eventsFile),
    "--subagent-id",
    shellQuote(subagentId),
  ].join(" ");
}

export function createTmuxSubagentWatcher({
  sessionBus,
  eventsFile,
  workspaceDir = process.cwd(),
  cliPath,
  spawn = spawnDefault,
  log = null,
} = {}) {
  if (!sessionBus || typeof sessionBus.subscribe !== "function") return { close: () => {}, started: new Set() };
  const targetEventsFile = String(eventsFile || "").trim();
  const targetCliPath = String(cliPath || "").trim();
  const started = new Set();
  let disabled = !targetEventsFile || !targetCliPath;
  let warned = false;
  const warn = (message) => {
    if (warned) return;
    warned = true;
    if (typeof log === "function") log(message);
  };

  const unsubscribe = sessionBus.subscribe((event) => {
    if (disabled || event?.type !== "agent.subagent_start") return;
    const id = String(event.payload?.id || "").trim();
    if (!id || started.has(id)) return;
    started.add(id);
    const role = String(event.payload?.role || event.payload?.agentDefinition?.name || "agent");
    const windowName = sanitizeTmuxWindowName(role);
    const command = buildWatcherCommand({ cliPath: targetCliPath, eventsFile: targetEventsFile, subagentId: id });
    try {
      const child = spawn("tmux", ["new-window", "-n", windowName, command], {
        cwd: workspaceDir,
        detached: true,
        stdio: "ignore",
      });
      if (child && typeof child.on === "function") {
        child.on("error", (err) => {
          disabled = true;
          warn(`tmux subagent windows disabled: ${String(err?.message || err)}`);
        });
        if (typeof child.unref === "function") child.unref();
      }
    } catch (err) {
      disabled = true;
      warn(`tmux subagent windows disabled: ${String(err?.message || err)}`);
    }
  });

  return {
    started,
    close: () => {
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function readSubagentEventLines({ filePath, subagentId = "" } = {}) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((event) => event && isSubagentSessionEvent(event, subagentId))
    .map(formatSubagentEventLine);
}

export async function watchSubagentEventsFile({ filePath, subagentId = "", out = process.stdout, pollMs = 500 } = {}) {
  const target = path.resolve(String(filePath || ""));
  let offset = 0;
  let remainder = "";
  const print = (text) => {
    if (!text) return;
    out.write(`${text}\n`);
  };
  const drain = async () => {
    let stat = null;
    try {
      stat = await fs.stat(target);
    } catch {
      return;
    }
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;
    const handle = await fs.open(target, "r");
    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      offset = stat.size;
      const text = remainder + buffer.toString("utf8");
      const lines = text.split("\n");
      remainder = lines.pop() || "";
      for (const line of lines) {
        const event = parseJsonLine(line.trim());
        if (event && isSubagentSessionEvent(event, subagentId)) print(formatSubagentEventLine(event));
      }
    } finally {
      await handle.close();
    }
  };

  await drain();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      drain().catch(() => {});
    }, Math.max(100, Number(pollMs) || 500));
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

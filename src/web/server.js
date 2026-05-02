#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Agent } from "../lib/agent.js";
import { getProvider } from "../lib/providers.js";
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
} from "../lib/skills.js";
import { McpHub, mergeCommonMcpServers } from "../lib/mcp.js";
import {
  listResumableSessions,
  loadResumableSession,
  makeSessionId,
  resolveResumableSessionId,
  saveResumableSession,
  shortSessionId,
} from "../lib/resumableSessions.js";

const DEFAULT_PORT = 3737;
const MAX_BODY_BYTES = 1024 * 1024;
const SSE_KEEPALIVE_MS = 15000;
const WEB_SLASH_COMMANDS = [
  { name: "/help", description: "Show web slash commands" },
  { name: "/sessions", description: "List recent resumable sessions" },
  { name: "/resume", description: "Resume a previous session by short or full ID" },
  { name: "/clear", description: "Clear conversation timeline and todos" },
  { name: "/plan", description: "Show or change plan mode" },
  { name: "/approve", description: "Toggle shell auto-approval" },
  { name: "/model", description: "Show active provider/model" },
  { name: "/skills", description: "Show active skills" },
  { name: "/skills list", description: "List discovered skills" },
  { name: "/skills commands", description: "List slash commands exposed by skills" },
  { name: "/skills use", description: "Enable a skill" },
  { name: "/skills off", description: "Disable a skill" },
  { name: "/skills clear", description: "Disable all skills" },
  { name: "/use", description: "Alias for /skills use" },
  { name: "/mcp", description: "Show MCP server status" },
  { name: "/abort", description: "Abort current task" },
];

function getSettingsFilePath() {
  const configured = process.env.PIECODE_SETTINGS_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode", "settings.json");
}

async function loadSettings(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveProviderOptions(settings) {
  const provider = settings.provider || null;
  const providerSettings = provider && settings.providers && typeof settings.providers === "object" ? settings.providers[provider] || {} : {};
  const model = settings.model || providerSettings.model || null;
  const endpoint = providerSettings.endpoint || providerSettings.baseUrl || settings.endpoint || settings.baseUrl || null;
  const apiKey = providerSettings.apiKey || settings.apiKey || null;
  return { provider, apiKey, model, baseUrl: endpoint, endpoint };
}

async function loadProjectInstructions(workspaceDir) {
  try {
    const filePath = path.join(workspaceDir, "AGENTS.md");
    const content = (await fs.readFile(filePath, "utf8")).trim();
    if (!content) return null;
    return { source: "AGENTS.md", path: filePath, content };
  } catch {
    return null;
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

function providerToolMode(provider) {
  return provider?.supportsNativeTools ? "native" : "text";
}

function providerTransport(provider) {
  const kind = String(provider?.kind || "").toLowerCase();
  if (kind === "codex-cli-session") return "cli";
  if (kind.includes("codex-auth-token")) return "chatgpt";
  if (kind.includes("codex-auth-key")) return "api";
  return "api";
}

function formatProviderModel(provider) {
  const prefix = providerPrefix(provider?.kind);
  const model = String(provider?.model || "").trim() || "unknown";
  return `${model}(${prefix}, tools:${providerToolMode(provider)}, ${providerTransport(provider)})`;
}

function normalizeBoolean(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(text)) return true;
  if (["off", "false", "no", "0", "disable", "disabled"].includes(text)) return false;
  return null;
}

function makeAssistantContent(lines) {
  return Array.isArray(lines) ? lines.filter(Boolean).join("\n") : String(lines || "");
}

function normalizeTodos(items) {
  const allowed = new Set(["pending", "in_progress", "completed"]);
  if (!Array.isArray(items)) return [];
  return items
    .map((raw, index) => {
      const content = String(raw?.content || "").trim();
      if (!content) return null;
      const status = allowed.has(String(raw?.status || "").toLowerCase()) ? String(raw.status).toLowerCase() : "pending";
      return { id: String(raw?.id || `todo-${index + 1}`), content, status };
    })
    .filter(Boolean);
}

function makeId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function redactInput(input) {
  if (!input || typeof input !== "object") return input;
  const out = { ...input };
  for (const key of ["content", "newText", "new_text", "oldText", "old_text"]) {
    if (typeof out[key] === "string" && out[key].length > 500) {
      out[key] = `${out[key].slice(0, 500)}...`;
    }
  }
  return out;
}

function clipText(value, max = 20000) {
  const text = String(value || "");
  const limit = Math.max(500, Number(max) || 20000);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[clipped ${text.length - limit} chars]`;
}

function parseToolResultDetails(tool, result) {
  const raw = String(result || "");
  const details = {
    kind: "text",
    preview: clipText(raw, 4000),
    expandable: false,
  };

  if (tool === "edit_file") {
    try {
      const parsed = JSON.parse(raw);
      const diff = String(parsed?.details?.diff || "");
      return {
        kind: "file_edit",
        path: String(parsed?.path || ""),
        changed: Boolean(parsed?.changed),
        message: String(parsed?.message || ""),
        diffStat: String(parsed?.details?.diffStat || ""),
        diff: clipText(diff, 30000),
        expandable: Boolean(diff),
        preview: String(parsed?.message || parsed?.details?.diffStat || raw).trim(),
      };
    } catch {
      return details;
    }
  }

  if (tool === "replace_in_files") {
    try {
      const parsed = JSON.parse(raw);
      return {
        kind: "bulk_replace",
        mode: String(parsed?.mode || ""),
        path: String(parsed?.path || ""),
        scannedFiles: Number(parsed?.scanned_files || 0),
        matchedFiles: Number(parsed?.matched_files || 0),
        replacements: Number(parsed?.replacements || 0),
        files: Array.isArray(parsed?.files) ? parsed.files.slice(0, 200) : [],
        expandable: Array.isArray(parsed?.files) && parsed.files.length > 0,
        preview: `${parsed?.mode || "replace"}: ${parsed?.matched_files || 0} file(s), ${parsed?.replacements || 0} replacement(s)`,
      };
    } catch {
      return details;
    }
  }

  if (tool === "write_file" || tool === "apply_patch") {
    return {
      ...details,
      kind: "file_write",
      expandable: raw.length > 0,
    };
  }

  return details;
}

function makePublicEvent(type, payload = {}) {
  return {
    id: makeId("event"),
    at: new Date().toISOString(),
    type,
    payload,
  };
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function textResponse(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}");
}

function sendSse(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

class ApprovalBroker {
  constructor({ publish }) {
    this.publish = publish;
    this.pending = new Map();
  }

  request(kind, details = {}) {
    const id = makeId("approval");
    const normalized = {
      id,
      kind: String(kind || "approval"),
      details: details && typeof details === "object" ? details : {},
      createdAt: new Date().toISOString(),
    };
    const promise = new Promise((resolve) => {
      this.pending.set(id, { ...normalized, resolve });
    });
    this.publish("approval.request", normalized);
    return promise;
  }

  resolve(id, decision) {
    const item = this.pending.get(String(id || ""));
    if (!item) return false;
    this.pending.delete(item.id);
    const value = String(decision || "deny").trim().toLowerCase() || "deny";
    item.resolve(value);
    this.publish("approval.resolved", { id: item.id, decision: value });
    return true;
  }

  list() {
    return [...this.pending.values()].map(({ resolve, ...item }) => item);
  }
}

class WebAgentSession {
  constructor({ workspaceDir, settings, settingsFile }) {
    this.workspaceDir = workspaceDir;
    this.settings = settings;
    this.settingsFile = settingsFile;
    this.sessionId = makeSessionId();
    this.createdAt = new Date().toISOString();
    this.recentSessions = [];
    this.clients = new Set();
    this.events = [];
    this.maxEvents = 1000;
    this.messages = [];
    this.timeline = [];
    this.maxTimeline = 1000;
    this.activeToolRuns = new Map();
    this.todos = [];
    this.planOnly = false;
    this.running = false;
    this.activeTask = "";
    this.lastError = "";
    this.autoApproveRef = { value: false };
    this.shellPermissionRef = { value: { allowAllSession: false, rememberedCommands: new Set() } };
    this.activeSkillsRef = { value: [] };
    this.projectInstructionsRef = { value: null };
    this.mcpHub = null;
    this.approvals = new ApprovalBroker({ publish: (type, payload) => this.publish(type, payload) });
  }

  async init() {
    this.recentSessions = await listResumableSessions(this.workspaceDir, 3);
    const skillRoots = resolveSkillRoots(this.settings);
    this.skillIndex = await discoverSkills(skillRoots);
    const requestedSkills = resolveRequestedSkills([], this.settings);
    const loaded = await loadActiveSkills(this.skillIndex, requestedSkills);
    this.activeSkillsRef.value = loaded.active;
    this.projectInstructionsRef.value = await loadProjectInstructions(this.workspaceDir);
    await autoLoadSkillsFromInstructions(this.projectInstructionsRef.value, this.activeSkillsRef, this.skillIndex);

    const providerOptions = resolveProviderOptions(this.settings);
    this.provider = getProvider(providerOptions);
    const mergedMcpSettings = await mergeCommonMcpServers(this.settings, {
      workspaceDir: this.workspaceDir,
      onLog: (line) => this.publish("log", { line }),
    });
    this.mcpHub = new McpHub({
      workspaceDir: this.workspaceDir,
      settings: mergedMcpSettings,
      onLog: (line) => this.publish("log", { line }),
    });

    this.agent = new Agent({
      provider: this.provider,
      workspaceDir: this.workspaceDir,
      autoApproveRef: this.autoApproveRef,
      shellPermissionRef: this.shellPermissionRef,
      askApproval: (kind, details) => this.askApproval(kind, details),
      activeSkillsRef: this.activeSkillsRef,
      projectInstructionsRef: this.projectInstructionsRef,
      mcpHub: this.mcpHub,
      webSearch: this.settings?.webSearch || this.settings?.tools?.web?.search || null,
      onTodoWrite: (todos) => {
        this.todos = normalizeTodos(todos);
        this.publish("todos", { todos: this.todos });
      },
      onEvent: (evt) => this.handleAgentEvent(evt),
    });

    this.publish("ready", this.snapshot());
  }

  async close() {
    try {
      if (this.timeline.length > 0 || this.messages.length > 0) {
        const saved = await this.saveCurrentSession();
        console.log(`Session saved: ${saved.sessionId}`);
        console.log(`Resume later with: /resume ${saved.shortId || shortSessionId(saved.sessionId)} or /resume ${saved.sessionId}`);
      }
    } catch (err) {
      console.error(`warning: failed to save session: ${String(err?.message || err)}`);
    }
    try {
      await this.mcpHub?.close?.();
    } catch {}
  }

  askApproval(kind, details = {}) {
    const safeDetails = details && typeof details === "object" ? { ...details } : {};
    if (safeDetails.input) safeDetails.input = redactInput(safeDetails.input);
    return this.approvals.request(kind, safeDetails);
  }

  publish(type, payload = {}) {
    const event = makePublicEvent(type, payload);
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events = this.events.slice(this.events.length - this.maxEvents);
    for (const client of this.clients) {
      try {
        sendSse(client, event);
      } catch {
        this.clients.delete(client);
      }
    }
    return event;
  }

  subscribe(res) {
    this.clients.add(res);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    sendSse(res, makePublicEvent("snapshot", this.snapshot()));
    for (const event of this.events.slice(-100)) sendSse(res, event);
    const timer = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(timer);
        this.clients.delete(res);
      }
    }, SSE_KEEPALIVE_MS);
    res.on("close", () => {
      clearInterval(timer);
      this.clients.delete(res);
    });
  }

  getSlashCommands() {
    const skillCommands = [...discoverSkillCommands(this.skillIndex).values()]
      .map((command) => ({
        name: command.slash,
        description: command.description || `Use ${command.skillName} skill`,
        skillName: command.skillName,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set();
    return [...WEB_SLASH_COMMANDS, ...skillCommands].filter((command) => {
      if (!command.name || seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      shortSessionId: shortSessionId(this.sessionId),
      createdAt: this.createdAt,
      recentSessions: this.recentSessions,
      workspaceDir: this.workspaceDir,
      provider: this.provider?.kind || "",
      model: this.provider?.model || "",
      providerLabel: formatProviderModel(this.provider),
      running: this.running,
      activeTask: this.activeTask,
      lastError: this.lastError,
      autoApprove: Boolean(this.autoApproveRef.value),
      planOnly: Boolean(this.planOnly),
      shellPermissions: {
        allowAllSession: Boolean(this.shellPermissionRef.value?.allowAllSession),
        rememberedCommands: [...(this.shellPermissionRef.value?.rememberedCommands || [])],
      },
      skills: this.activeSkillsRef.value.map((skill) => ({ name: skill.name, description: skill.description || "" })),
      availableSkills: [...this.skillIndex.values()]
        .map((skill) => ({ name: skill.name, description: skill.description || "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      slashCommands: this.getSlashCommands(),
      mcpServers: this.mcpHub?.hasServers?.() ? this.mcpHub.getServerNames() : [],
      todos: this.todos,
      messages: this.messages.slice(-100),
      timeline: this.timeline.slice(-200),
      approvals: this.approvals.list(),
    };
  }

  async saveCurrentSession() {
    const saved = await saveResumableSession(this.workspaceDir, {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      providerLabel: formatProviderModel(this.provider),
      messages: this.messages,
      timeline: this.timeline,
      todos: this.todos,
      agentHistory: this.agent?.history || [],
    });
    this.recentSessions = await listResumableSessions(this.workspaceDir, 3);
    this.publish("sessions", { current: saved, recent: this.recentSessions });
    return { ...saved, shortId: shortSessionId(saved.sessionId) };
  }

  async resumeSession(query) {
    const sessionId = await resolveResumableSessionId(this.workspaceDir, query);
    const loaded = await loadResumableSession(this.workspaceDir, sessionId);
    this.sessionId = loaded.sessionId || sessionId;
    this.createdAt = loaded.createdAt || new Date().toISOString();
    this.messages = Array.isArray(loaded.messages) ? loaded.messages : [];
    this.timeline = Array.isArray(loaded.timeline) ? loaded.timeline : this.messages.map((msg) => ({ ...msg, type: "message" }));
    this.todos = normalizeTodos(loaded.todos || []);
    if (Array.isArray(loaded.agentHistory)) this.agent.history = loaded.agentHistory;
    this.recentSessions = await listResumableSessions(this.workspaceDir, 3);
    this.publish("snapshot", this.snapshot());
    return loaded;
  }

  formatSessionList(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (list.length === 0) return "No resumable sessions yet.";
    return [
      "## Recent Sessions",
      ...list.map((item, index) => {
        const shortId = item.shortId || shortSessionId(item.sessionId);
        const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "unknown time";
        return `${index + 1}. \`${shortId}\` — ${item.summary || "PieCode session"}\n   ${updated} · ${item.messageCount || 0} messages · ${item.toolCount || 0} tools\n   Resume: \`/resume ${shortId}\` or \`/resume ${item.sessionId}\``;
      }),
    ].join("\n");
  }

  addAssistantMessage(content) {
    const text = String(content || "").trim();
    if (!text) return null;
    const message = { id: makeId("msg"), role: "assistant", content: text, at: new Date().toISOString() };
    this.messages.push(message);
    this.addTimelineItem({ ...message, type: "message" });
    this.publish("message", message);
    return message;
  }

  addTimelineItem(item = {}) {
    const normalized = {
      id: String(item.id || makeId("tl")),
      at: String(item.at || new Date().toISOString()),
      type: String(item.type || "event"),
      ...item,
    };
    this.timeline.push(normalized);
    if (this.timeline.length > this.maxTimeline) {
      this.timeline = this.timeline.slice(this.timeline.length - this.maxTimeline);
    }
    this.publish("timeline", normalized);
    return normalized;
  }

  makeToolRunKey(evt = {}) {
    const tool = String(evt.tool || "tool");
    const input = evt.input && typeof evt.input === "object" ? evt.input : {};
    const signature = JSON.stringify({ tool, input: redactInput(input), parallel: Boolean(evt.parallel) });
    return `${tool}:${signature}`;
  }

  handleAgentEvent(evt = {}) {
    const type = String(evt?.type || "event");
    if (type === "tool_use") {
      const key = this.makeToolRunKey(evt);
      const item = this.addTimelineItem({
        type: "tool",
        status: "queued",
        tool: String(evt.tool || "tool"),
        input: redactInput(evt.input),
        reason: String(evt.reason || ""),
        parallel: Boolean(evt.parallel),
      });
      this.activeToolRuns.set(key, item.id);
      this.publish(type, { ...evt, input: redactInput(evt.input), timelineId: item.id });
      return;
    }
    if (type === "tool_start") {
      const key = this.makeToolRunKey(evt);
      const existingId = this.activeToolRuns.get(key);
      if (existingId) {
        this.publish("timeline.update", { id: existingId, patch: { status: "running", startedAt: new Date().toISOString() } });
      } else {
        const item = this.addTimelineItem({
          type: "tool",
          status: "running",
          tool: String(evt.tool || "tool"),
          input: redactInput(evt.input),
        });
        this.activeToolRuns.set(key, item.id);
      }
      this.publish(type, { ...evt, input: redactInput(evt.input), timelineId: existingId || null });
      return;
    }
    if (type === "tool_end") {
      const result = String(evt.result || "");
      const details = parseToolResultDetails(evt.tool, result);
      const candidates = [...this.activeToolRuns.entries()].filter(([key]) => key.startsWith(`${evt.tool}:`));
      const [key, timelineId] = candidates[candidates.length - 1] || [];
      if (key) this.activeToolRuns.delete(key);
      if (timelineId) {
        this.publish("timeline.update", {
          id: timelineId,
          patch: {
            status: evt.error ? "error" : "done",
            error: evt.error || "",
            result: details,
            finishedAt: new Date().toISOString(),
          },
        });
      } else {
        this.addTimelineItem({
          type: "tool",
          status: evt.error ? "error" : "done",
          tool: String(evt.tool || "tool"),
          error: evt.error || "",
          result: details,
        });
      }
      this.publish(type, {
        tool: evt.tool,
        error: evt.error || "",
        resultPreview: details.preview,
        result: details,
        parallel: Boolean(evt.parallel),
        timelineId: timelineId || null,
      });
      return;
    }
    if (type === "llm_request") {
      this.publish(type, { stage: evt.stage, preview: String(evt.payload || "").slice(0, 600) });
      return;
    }
    if (type === "llm_response") {
      this.publish(type, { stage: evt.stage, usage: evt.usage || null, preview: String(evt.payload || "").slice(0, 800) });
      return;
    }
    if (type === "llm_response_delta") {
      this.publish(type, { stage: evt.stage, delta: String(evt.delta || "").slice(0, 1000) });
      return;
    }
    this.publish(type, evt);
  }

  async handleSlashCommand(input) {
    const raw = String(input || "").trim();
    const normalized = raw.replace(/\s+/g, " ");
    const lower = normalized.toLowerCase();
    const argAfter = (prefix) => normalized.slice(prefix.length).trim();

    if (lower === "/help") {
      const lines = ["## Web Slash Commands", ...this.getSlashCommands().map((command) => `- \`${command.name}\`${command.description ? ` — ${command.description}` : ""}`)];
      return { handled: true, message: makeAssistantContent(lines) };
    }
    if (lower === "/sessions" || lower === "/session list" || lower === "/resume") {
      const sessions = await listResumableSessions(this.workspaceDir, 10);
      this.recentSessions = sessions.slice(0, 3);
      this.publish("sessions", { recent: this.recentSessions });
      return { handled: true, message: this.formatSessionList(sessions) };
    }
    if (lower.startsWith("/resume ")) {
      const query = argAfter("/resume ");
      try {
        const loaded = await this.resumeSession(query);
        return { handled: true, message: `Resumed session \`${shortSessionId(loaded.sessionId)}\`: ${loaded.summary || loaded.sessionId}` };
      } catch (err) {
        return { handled: true, message: `Unable to resume session: ${String(err?.message || err)}` };
      }
    }
    if (lower === "/clear") {
      this.messages = [];
      this.timeline = [];
      this.todos = [];
      this.agent.clearHistory();
      this.publish("todos", { todos: [] });
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: "Conversation context cleared." };
    }
    if (lower === "/plan") {
      return { handled: true, patch: { planOnly: Boolean(this.planOnly) }, message: `Plan mode: ${this.planOnly ? "on" : "off"}. Use \`/plan on\` or \`/plan off\`.` };
    }
    if (lower.startsWith("/plan ")) {
      const enabled = normalizeBoolean(argAfter("/plan "));
      if (enabled === null) return { handled: true, message: "Usage: `/plan on` or `/plan off`." };
      this.planOnly = enabled;
      this.publish("snapshot", this.snapshot());
      return { handled: true, patch: { planOnly: enabled }, message: `Plan mode ${enabled ? "enabled" : "disabled"}.` };
    }
    if (lower.startsWith("/approve")) {
      const arg = argAfter("/approve");
      if (!arg) return { handled: true, patch: { autoApprove: Boolean(this.autoApproveRef.value) }, message: `Shell auto-approval: ${this.autoApproveRef.value ? "on" : "off"}.` };
      const enabled = normalizeBoolean(arg);
      if (enabled === null) return { handled: true, message: "Usage: `/approve on` or `/approve off`." };
      this.autoApproveRef.value = enabled;
      this.publish("snapshot", this.snapshot());
      return { handled: true, patch: { autoApprove: enabled }, message: `Shell auto-approval ${enabled ? "enabled" : "disabled"}.` };
    }
    if (lower === "/model") {
      return { handled: true, message: `Current model: ${formatProviderModel(this.provider)}` };
    }
    if (lower === "/mcp") {
      const names = this.mcpHub?.hasServers?.() ? this.mcpHub.getServerNames() : [];
      return { handled: true, message: names.length ? `MCP servers: ${names.join(", ")}` : "No MCP servers configured." };
    }
    if (lower === "/abort") {
      const ok = Boolean(this.agent?.requestAbort?.());
      return { handled: true, message: ok ? "Abort requested." : "No active task to abort." };
    }
    if (lower === "/skills") {
      const names = this.activeSkillsRef.value.map((skill) => skill.name);
      return { handled: true, message: names.length ? `Active skills: ${names.join(", ")}` : "Active skills: none." };
    }
    if (lower === "/skills list") {
      const skills = [...this.skillIndex.values()].sort((a, b) => a.name.localeCompare(b.name));
      const lines = skills.length ? ["## Skills", ...skills.map((skill) => `- **${skill.name}**${skill.description ? `: ${skill.description}` : ""}`)] : ["No skills discovered."];
      return { handled: true, message: makeAssistantContent(lines) };
    }
    if (lower === "/skills commands") {
      const commands = [...discoverSkillCommands(this.skillIndex).values()].sort((a, b) => a.name.localeCompare(b.name));
      const lines = commands.length ? ["## Skill Commands", ...commands.map((command) => `- \`${command.slash}\` → ${command.skillName}${command.description ? `: ${command.description}` : ""}`)] : ["No skill commands discovered."];
      return { handled: true, message: makeAssistantContent(lines) };
    }
    if (lower === "/skills clear") {
      this.activeSkillsRef.value = [];
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: "All skills disabled." };
    }
    if (lower.startsWith("/skills use ") || lower.startsWith("/use ")) {
      const name = lower.startsWith("/use ") ? argAfter("/use ") : argAfter("/skills use ");
      const result = await addSkillByName(this.activeSkillsRef.value, this.skillIndex, name);
      if (result.added) {
        this.activeSkillsRef.value = result.active;
        this.publish("snapshot", this.snapshot());
        return { handled: true, message: `Enabled skill: ${name}` };
      }
      return { handled: true, message: result.reason === "already-enabled" ? `Skill already enabled: ${name}` : `Unable to enable skill: ${name} (${result.reason})` };
    }
    if (lower.startsWith("/skills off ")) {
      const name = argAfter("/skills off ");
      const result = removeSkillByName(this.activeSkillsRef.value, name);
      this.activeSkillsRef.value = result.active;
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: result.removed ? `Disabled skill: ${name}` : `Skill not active: ${name}` };
    }

    const skillCommand = resolveSkillCommand(raw, this.skillIndex);
    if (skillCommand) {
      const result = await addSkillByName(this.activeSkillsRef.value, this.skillIndex, skillCommand.skillName);
      if (result.added) this.activeSkillsRef.value = result.active;
      if (result.reason === "not-found" || result.reason === "unreadable") {
        return { handled: true, message: `Skill command unavailable: ${skillCommand.slash} (${result.reason})` };
      }
      return { handled: false, input: skillCommand.prompt, displayInput: raw };
    }

    if (raw.startsWith("/")) return { handled: true, message: `Unknown command: ${raw}. Try \`/help\`.` };
    return { handled: false, input: raw };
  }

  async sendMessage(content, options = {}) {
    const text = String(content || "").trim();
    if (!text) throw new Error("Message is required");
    if (this.running) throw new Error("A task is already running");

    if (text.startsWith("/")) {
      const slash = await this.handleSlashCommand(text);
      if (slash.handled) return this.addAssistantMessage(slash.message);
      options = { ...options, displayInput: slash.displayInput || text };
      content = slash.input || text;
    }

    await autoEnableSkills(content, this.activeSkillsRef, this.skillIndex);
    this.running = true;
    this.activeTask = text;
    this.lastError = "";
    const userMessage = { id: makeId("msg"), role: "user", content: text, at: new Date().toISOString() };
    this.messages.push(userMessage);
    this.addTimelineItem({ ...userMessage, type: "message" });
    this.publish("message", userMessage);
    this.publish("task.start", { input: text });

    try {
      const result = await this.agent.runTurn(content, { planOnly: Boolean(options.planOnly) });
      const contentOut = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const assistantMessage = { id: makeId("msg"), role: "assistant", content: contentOut, at: new Date().toISOString() };
      this.messages.push(assistantMessage);
      this.addTimelineItem({ ...assistantMessage, type: "message" });
      this.publish("message", assistantMessage);
      this.publish("task.done", { ok: true });
      return assistantMessage;
    } catch (err) {
      this.lastError = String(err?.message || "error");
      const errorMessage = { id: makeId("msg"), role: "error", content: this.lastError, at: new Date().toISOString() };
      this.messages.push(errorMessage);
      this.addTimelineItem({ ...errorMessage, type: "message" });
      this.publish("message", errorMessage);
      this.publish("task.error", { error: this.lastError });
      throw err;
    } finally {
      this.running = false;
      this.activeTask = "";
      this.publish("snapshot", this.snapshot());
    }
  }
}

function getLocalNetworkUrls(port) {
  const urls = [`http://localhost:${port}`];
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const item of entries || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      urls.push(`http://${item.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(reqPath, res) {
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  const target = reqPath === "/" ? "/index.html" : reqPath;
  const decoded = decodeURIComponent(target.split("?")[0]);
  const abs = path.resolve(webRoot, `.${decoded}`);
  if (!abs.startsWith(webRoot)) return textResponse(res, 403, "Forbidden");
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error("not file");
    const body = await fs.readFile(abs);
    res.writeHead(200, { "content-type": contentTypeFor(abs), "content-length": body.length });
    res.end(body);
  } catch {
    textResponse(res, 404, "Not found");
  }
}

async function main() {
  const settingsFile = getSettingsFilePath();
  const settings = await loadSettings(settingsFile);
  const workspaceDir = process.cwd();
  const session = new WebAgentSession({ workspaceDir, settings, settingsFile });
  await session.init();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/events") {
        session.subscribe(res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        jsonResponse(res, 200, session.snapshot());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJsonBody(req);
        if (typeof body.planOnly === "boolean") session.planOnly = body.planOnly;
        session.sendMessage(body.message, { planOnly: session.planOnly }).catch(() => {});
        jsonResponse(res, 202, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/approvals") {
        const body = await readJsonBody(req);
        const ok = session.approvals.resolve(body.id, body.decision);
        jsonResponse(res, ok ? 200 : 404, { ok });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/abort") {
        const ok = Boolean(session.agent?.requestAbort?.());
        jsonResponse(res, 200, { ok });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const limit = Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10;
        const sessions = await listResumableSessions(session.workspaceDir, limit);
        jsonResponse(res, 200, { sessions });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/resume") {
        const body = await readJsonBody(req);
        const loaded = await session.resumeSession(body.id || body.sessionId || body.query);
        session.addAssistantMessage(`Resumed session \`${shortSessionId(loaded.sessionId)}\`: ${loaded.summary || loaded.sessionId}`);
        jsonResponse(res, 200, { ok: true, session: loaded });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/approve-mode") {
        const body = await readJsonBody(req);
        session.autoApproveRef.value = Boolean(body.enabled);
        session.publish("snapshot", session.snapshot());
        jsonResponse(res, 200, { ok: true, enabled: session.autoApproveRef.value });
        return;
      }
      if (req.method === "GET") {
        await serveStatic(url.pathname, res);
        return;
      }
      textResponse(res, 405, "Method not allowed");
    } catch (err) {
      jsonResponse(res, 500, { error: String(err?.message || "error") });
    }
  });

  const port = Number.parseInt(process.env.PIECODE_WEB_PORT || "", 10) || DEFAULT_PORT;
  const host = process.env.PIECODE_WEB_HOST || "0.0.0.0";
  server.listen(port, host, () => {
    const urls = getLocalNetworkUrls(port);
    console.log("PieCode Web is running:");
    for (const item of urls) console.log(`  ${item}`);
    console.log(`Current Session ID: ${session.sessionId} (short: ${shortSessionId(session.sessionId)})`);
    if (session.recentSessions.length > 0) {
      console.log("Recent resumable sessions:");
      for (const item of session.recentSessions) {
        console.log(`  ${item.shortId || shortSessionId(item.sessionId)}  ${item.summary || "PieCode session"}`);
      }
      console.log("Resume with: /resume <short-id> or /resume <full-session-id>");
    } else {
      console.log("No previous sessions. Future sessions can be resumed with /sessions and /resume <id>.");
    }
  });

  const shutdown = async () => {
    server.close();
    await session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});

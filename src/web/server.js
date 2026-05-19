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
} from "../lib/plugins.js";
import { installPlugin, updatePlugin } from "../lib/pluginInstaller.js";
import { McpHub, mergeCommonMcpServers } from "../lib/mcp.js";
import { buildFileMentionContext } from "../lib/fileMentionContext.js";
import {
  listResumableSessions,
  loadResumableSession,
  makeSessionId,
  resolveResumableSessionId,
  saveResumableSession,
  shortSessionId,
} from "../lib/resumableSessions.js";
import {
  buildGoalContinuationPrompt,
  buildGoalPrompt,
  createGoalRun,
  parseGoalStatus,
  summarizeGoalOutput,
} from "../lib/goalMode.js";
import { getSessionDiff, parseToolResultDetails } from "./core.js";

const DEFAULT_PORT = 3737;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGE_BODY_BYTES = 24 * 1024 * 1024;
const MAX_WEB_ATTACHMENTS = 6;
const MAX_WEB_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_WEB_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
const WEB_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SSE_KEEPALIVE_MS = 15000;
const WEB_SLASH_COMMANDS = [
  { name: "/help", description: "Show web slash commands" },
  { name: "/sessions", description: "List recent resumable sessions" },
  { name: "/resume", description: "Resume a previous session by short or full ID" },
  { name: "/clear", description: "Clear conversation timeline and todos" },
  { name: "/btw", description: "Run a background strict-read-only side question" },
  { name: "/detail", description: "Toggle expanded tool details" },
  { name: "/plan", description: "Show or change plan mode" },
  { name: "/goal", description: "Run a goal loop until completion, blockage, or the turn limit" },
  { name: "/approve", description: "Toggle shell auto-approval" },
  { name: "/model", description: "Show active provider/model" },
  { name: "/skills", description: "Show active skills" },
  { name: "/skills list", description: "List discovered skills" },
  { name: "/skills commands", description: "List slash commands exposed by skills" },
  { name: "/skills use", description: "Enable a skill" },
  { name: "/skills off", description: "Disable a skill" },
  { name: "/skills clear", description: "Disable all skills" },
  { name: "/use", description: "Alias for /skills use" },
  { name: "/plugins", description: "Show active plugins" },
  { name: "/plugins list", description: "List discovered plugins" },
  { name: "/plugins commands", description: "List slash commands exposed by plugins" },
  { name: "/plugins install", description: "Install plugin from local directory or git URL" },
  { name: "/plugins update", description: "Update git-backed plugin(s)" },
  { name: "/plugins use", description: "Enable a plugin" },
  { name: "/plugins off", description: "Disable a plugin" },
  { name: "/plugins clear", description: "Disable all plugins" },
  { name: "/plugin", description: "Alias for /plugins" },
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

function parsePluginInstallArgs(input) {
  const parsed = splitCommandArgs(input);
  if (parsed.error) return { error: parsed.error };
  const out = { source: "", name: "", project: false, error: "" };
  for (let i = 0; i < parsed.args.length; i += 1) {
    const item = parsed.args[i];
    if (item === "--project") {
      out.project = true;
      continue;
    }
    if (item === "--name") {
      out.name = parsed.args[i + 1] || "";
      i += 1;
      continue;
    }
    if (!out.source) out.source = item;
  }
  if (!out.source) out.error = "missing plugin source";
  return out;
}

function toPositiveInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num);
}

function resolveConfiguredContextWindow(settings = {}, providerOptions = {}) {
  const provider = providerOptions.provider || settings.provider || "";
  const providerSettings = provider && settings.providers && typeof settings.providers === "object" ? settings.providers[provider] || {} : {};
  return toPositiveInteger(
    providerSettings.contextWindow ??
      providerSettings.context_window ??
      providerSettings.contextLength ??
      providerSettings.context_length ??
      settings.contextWindow ??
      settings.context_window ??
      settings.contextLength ??
      settings.context_length
  );
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

export function summarizeToolIntent(tool, input = {}) {
  const name = String(tool || "tool");
  const args = input && typeof input === "object" ? input : {};
  const pathValue = args.path || args.file || args.filePath || args.pattern || "";
  const shortValue = String(pathValue || "").trim().slice(0, 120);

  if (name === "shell") return "Running a shell command.";
  if (name === "read_file" || name === "read_files") return shortValue ? `Reading ${shortValue}.` : "Reading workspace file content.";
  if (["rg", "grep", "search_files"].includes(name)) return shortValue ? `Searching for ${shortValue}.` : "Searching the codebase.";
  if (name === "glob_files" || name === "find_files" || name === "list_files") return shortValue ? `Listing ${shortValue}.` : "Inspecting workspace files.";
  if (name === "edit_file") return shortValue ? `Editing ${shortValue}.` : "Editing a file.";
  if (name === "write_file") return shortValue ? `Writing ${shortValue}.` : "Writing a file.";
  if (name === "replace_in_files") return "Applying replacements across files.";
  if (name === "run_tests") return "Running tests.";
  if (name.includes("mcp")) return "Calling an MCP tool.";
  return `Using ${name}.`;
}

function makePublicEvent(type, payload = {}) {
  return {
    id: makeId("event"),
    at: new Date().toISOString(),
    type,
    payload,
  };
}

export function resolveWebBindOptions(env = process.env) {
  const port = Number.parseInt(env.PIECODE_WEB_PORT || "", 10) || DEFAULT_PORT;
  const host = String(env.PIECODE_WEB_HOST || "127.0.0.1").trim() || "127.0.0.1";
  return { host, port };
}

export function createWebAuthToken(env = process.env) {
  return String(env.PIECODE_WEB_TOKEN || "").trim();
}

export function isAuthorizedWebRequest(req, url, token) {
  const expected = String(token || "").trim();
  if (!expected) return true;
  const header = String(req?.headers?.["x-piecode-token"] || "").trim();
  const query = String(url?.searchParams?.get("token") || "").trim();
  return header === expected || query === expected;
}

export function validateWebOrigin(req, host = "127.0.0.1", port = DEFAULT_PORT) {
  const origin = String(req?.headers?.origin || "").trim();
  if (!origin) return { ok: true, reason: "" };
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", String(host || "").toLowerCase()]);
    const requestHost = String(req?.headers?.host || "").trim();
    if (requestHost) {
      try {
        allowedHosts.add(new URL(`http://${requestHost}`).hostname.toLowerCase());
      } catch {}
    }
    const configuredOrigins = String(process.env.PIECODE_WEB_ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const item of configuredOrigins) {
      try {
        const allowed = new URL(item);
        if (allowed.origin === parsed.origin) return { ok: true, reason: "" };
      } catch {}
    }
    if (allowedHosts.has(hostname) && String(originPort) === String(port)) return { ok: true, reason: "" };
  } catch {
    return { ok: false, reason: "invalid origin" };
  }
  return { ok: false, reason: "origin not allowed" };
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

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}");
}

function detectWebImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function sanitizeAttachmentName(name) {
  return String(name || "image")
    .replace(/[\\/\0\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "image";
}

export function normalizeWebAttachments(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("attachments must be an array");
  if (raw.length > MAX_WEB_ATTACHMENTS) throw new Error(`Too many attachments (max ${MAX_WEB_ATTACHMENTS})`);

  let totalBytes = 0;
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Attachment ${index + 1} is invalid`);
    if (String(item.type || "image") !== "image") throw new Error(`Attachment ${index + 1} has unsupported type`);
    const mimeType = String(item.mimeType || item.mime || "").toLowerCase();
    if (!WEB_IMAGE_MIME_TYPES.has(mimeType)) throw new Error(`Attachment ${index + 1} has unsupported image type`);
    let data = String(item.data || "").trim();
    const dataUrlMatch = data.match(/^data:([^;,]+);base64,(.*)$/i);
    if (dataUrlMatch) data = dataUrlMatch[2] || "";
    data = data.replace(/\s+/g, "");
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error(`Attachment ${index + 1} is not valid base64`);
    }
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) throw new Error(`Attachment ${index + 1} is empty`);
    if (buffer.length > MAX_WEB_IMAGE_BYTES) throw new Error(`Attachment ${index + 1} is too large (max ${MAX_WEB_IMAGE_BYTES} bytes)`);
    totalBytes += buffer.length;
    if (totalBytes > MAX_WEB_ATTACHMENTS_BYTES) throw new Error(`Attachments are too large (max ${MAX_WEB_ATTACHMENTS_BYTES} bytes total)`);
    const detected = detectWebImageType(buffer);
    if (detected !== mimeType) throw new Error(`Attachment ${index + 1} content does not match ${mimeType}`);
    return {
      type: "image",
      source: "web",
      name: sanitizeAttachmentName(item.name),
      mimeType,
      data,
      bytes: buffer.length,
    };
  });
}

function publicAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => ({
    type: "image",
    source: item.source || "web",
    name: item.name || "image",
    mimeType: item.mimeType,
    data: item.data,
    bytes: item.bytes,
  }));
}

function sendSse(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export class ApprovalBroker {
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
    return [...this.pending.values()].map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      details: entry.details,
      createdAt: entry.createdAt,
    }));
  }
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

export class ClarificationBroker {
  constructor({ publish }) {
    this.publish = publish;
    this.pending = new Map();
  }

  request({ question, options, multiple = false, required = true } = {}) {
    const id = makeId("clarification");
    const normalized = {
      id,
      question: String(question || "").trim(),
      options: normalizeClarificationOptions(options),
      multiple: Boolean(multiple),
      required: Boolean(required),
      createdAt: new Date().toISOString(),
    };
    const promise = new Promise((resolve) => {
      this.pending.set(id, { ...normalized, resolve });
    });
    this.publish("clarification.request", normalized);
    return promise;
  }

  resolve(id, selectedIndexes = []) {
    const item = this.pending.get(String(id || ""));
    if (!item) return false;
    const indexes = (Array.isArray(selectedIndexes) ? selectedIndexes : [selectedIndexes])
      .map((idx) => Math.floor(Number(idx)))
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < item.options.length);
    const unique = [...new Set(item.multiple ? indexes : indexes.slice(0, 1))];
    if (item.required && unique.length === 0) return false;
    this.pending.delete(item.id);
    const selected = unique.map((idx) => {
      const option = item.options[idx];
      return {
        label: option.label,
        value: option.value,
        ...(option.description ? { description: option.description } : {}),
      };
    });
    item.resolve({ selected });
    this.publish("clarification.resolved", { id: item.id, selectedIndexes: unique });
    return true;
  }

  list() {
    return [...this.pending.values()].map((entry) => ({
      id: entry.id,
      question: entry.question,
      options: entry.options,
      multiple: entry.multiple,
      required: entry.required,
      createdAt: entry.createdAt,
    }));
  }
}

export class WebAgentSession {
  constructor({ workspaceDir, settings, settingsFile, providerFactory = getProvider }) {
    this.workspaceDir = workspaceDir;
    this.settings = settings;
    this.settingsFile = settingsFile;
    this.providerFactory = typeof providerFactory === "function" ? providerFactory : getProvider;
    this.providerOptions = resolveProviderOptions(this.settings);
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
    this.messageQueue = [];
    this.maxQueue = 20;
    this.processingQueue = false;
    this.pendingSteers = [];
    this.planOnly = false;
    this.detailMode = false;
    this.running = false;
    this.activeTask = "";
    this.lastError = "";
    this.tokenUsage = { sent: 0, received: 0, last: null };
    this.autoApproveRef = { value: false };
    this.contextWindowRef = { value: 0 };
    this.shellPermissionRef = { value: { allowAllSession: false, rememberedCommands: new Set() } };
    this.activeSkillsRef = { value: [] };
    this.activePluginsRef = { value: [] };
    this.pluginIndex = new Map();
    this.projectInstructionsRef = { value: null };
    this.mcpHub = null;
    this.approvals = new ApprovalBroker({ publish: (type, payload) => this.publish(type, payload) });
    this.clarifications = new ClarificationBroker({ publish: (type, payload) => this.publish(type, payload) });
  }

  async init() {
    this.recentSessions = await listResumableSessions(this.workspaceDir, 3);
    const skillRoots = resolveSkillRoots(this.settings, this.workspaceDir);
    this.skillIndex = await discoverSkills(skillRoots);
    const pluginRoots = resolvePluginRoots(this.settings, this.workspaceDir);
    this.pluginIndex = await discoverPlugins(pluginRoots);
    const requestedSkills = resolveRequestedSkills([], this.settings);
    const loaded = await loadActiveSkills(this.skillIndex, requestedSkills);
    this.activeSkillsRef.value = loaded.active;
    const requestedPlugins = [
      ...resolveRequestedPlugins([], this.settings),
      ...getDefaultPluginNames(this.pluginIndex, this.settings),
    ];
    const loadedPlugins = await loadActivePlugins(this.pluginIndex, requestedPlugins);
    this.activePluginsRef.value = loadedPlugins.active;
    this.projectInstructionsRef.value = await loadProjectInstructions(this.workspaceDir);
    await autoLoadSkillsFromInstructions(this.projectInstructionsRef.value, this.activeSkillsRef, this.skillIndex);

    this.providerOptions = resolveProviderOptions(this.settings);
    this.provider = this.providerFactory(this.providerOptions);
    this.contextWindowRef.value = resolveConfiguredContextWindow(this.settings, this.providerOptions);
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
      contextWindowRef: this.contextWindowRef,
      autoApproveRef: this.autoApproveRef,
      shellPermissionRef: this.shellPermissionRef,
      askApproval: (kind, details) => this.askApproval(kind, details),
      askClarification: (prompt) => this.askClarification(prompt),
      activeSkillsRef: this.activeSkillsRef,
      activePluginsRef: this.activePluginsRef,
      projectInstructionsRef: this.projectInstructionsRef,
      mcpHub: this.mcpHub,
      getSteers: () => this.consumeSteers(),
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

  askClarification(prompt = {}) {
    return this.clarifications.request(prompt);
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
    const pluginCommands = [...discoverPluginCommands(this.pluginIndex).values()]
      .map((command) => ({
        name: command.slash,
        description: command.description || `Use ${command.pluginName} plugin`,
        pluginName: command.pluginName,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set();
    return [...WEB_SLASH_COMMANDS, ...pluginCommands, ...skillCommands].filter((command) => {
      if (!command.name || seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
  }

  publicQueue() {
    return this.messageQueue.map(({ options, ...item }) => ({
      ...item,
      hasAttachments: Array.isArray(options?.attachments) && options.attachments.length > 0,
      planOnly: Boolean(options?.planOnly),
    }));
  }

  enqueueMessage(content, options = {}) {
    const item = {
      id: makeId("queue"),
      content: String(content || "").trim(),
      options,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    if (!item.content && !Array.isArray(options.attachments)) throw new Error("Message is required");
    if (this.messageQueue.filter((entry) => entry.status === "queued").length >= this.maxQueue) {
      throw new Error(`Message queue is full (max ${this.maxQueue})`);
    }
    this.messageQueue.push(item);
    this.publish("queue.update", { queue: this.publicQueue() });
    return item;
  }

  addSteer(content) {
    const text = String(content || "").trim();
    if (!text) throw new Error("Steer message is required");
    const item = { id: makeId("steer"), content: text, at: new Date().toISOString() };
    this.pendingSteers.push(item);
    const message = { id: item.id, role: "user", content: text, steer: true, at: item.at };
    this.messages.push(message);
    this.addTimelineItem({ ...message, type: "message" });
    this.publish("steer", item);
    return item;
  }

  consumeSteers() {
    const items = this.pendingSteers;
    this.pendingSteers = [];
    return items;
  }

  refreshProvider() {
    const nextOptions = resolveProviderOptions(this.settings);
    const nextProvider = this.providerFactory(nextOptions);
    this.providerOptions = nextOptions;
    this.provider = nextProvider;
    if (this.agent) this.agent.provider = nextProvider;
    this.contextWindowRef.value = resolveConfiguredContextWindow(this.settings, nextOptions);
    this.publish("provider.update", {
      provider: nextProvider?.kind || "",
      model: nextProvider?.model || "",
      providerLabel: formatProviderModel(nextProvider),
    });
    return nextProvider;
  }

  async processQueue() {
    if (this.processingQueue || this.running) return;
    this.processingQueue = true;
    try {
      while (!this.running) {
        const next = this.messageQueue.find((item) => item.status === "queued");
        if (!next) break;
        next.status = "running";
        next.startedAt = new Date().toISOString();
        this.publish("queue.update", { queue: this.publicQueue() });
        try {
          await this.sendMessage(next.content, { ...next.options, fromQueue: true });
          next.status = "done";
          next.finishedAt = new Date().toISOString();
        } catch (err) {
          next.status = "error";
          next.error = String(err?.message || err);
          next.finishedAt = new Date().toISOString();
        }
        this.publish("queue.update", { queue: this.publicQueue() });
        this.messageQueue = this.messageQueue.filter((item) => item.status === "queued" || item.status === "running").slice(-this.maxQueue);
        this.publish("queue.update", { queue: this.publicQueue() });
      }
    } finally {
      this.processingQueue = false;
    }
  }

  getContextUsage() {
    const used =
      typeof this.agent?.estimateMessagesTokens === "function"
        ? toPositiveInteger(this.agent.estimateMessagesTokens(this.agent.history || []))
        : 0;
    const limit = toPositiveInteger(this.contextWindowRef?.value);
    const percent = limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 0;
    return {
      used,
      limit,
      percent,
      sent: toPositiveInteger(this.tokenUsage?.sent),
      received: toPositiveInteger(this.tokenUsage?.received),
      last: this.tokenUsage?.last || null,
    };
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
      detailMode: Boolean(this.detailMode),
      shellPermissions: {
        allowAllSession: Boolean(this.shellPermissionRef.value?.allowAllSession),
        rememberedCommands: [...(this.shellPermissionRef.value?.rememberedCommands || [])],
      },
      skills: this.activeSkillsRef.value.map((skill) => ({ name: skill.name, description: skill.description || "" })),
      availableSkills: [...this.skillIndex.values()]
        .map((skill) => ({ name: skill.name, description: skill.description || "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      plugins: this.activePluginsRef.value.map((plugin) => ({ name: plugin.name, description: plugin.description || "", version: plugin.version || "" })),
      availablePlugins: [...this.pluginIndex.values()]
        .map((plugin) => ({ name: plugin.name, description: plugin.description || "", version: plugin.version || "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      slashCommands: this.getSlashCommands(),
      mcpServers: this.mcpHub?.hasServers?.() ? this.mcpHub.getServerNames() : [],
      todos: this.todos,
      messages: this.messages.slice(-100),
      timeline: this.timeline.slice(-200),
      approvals: this.approvals.list(),
      clarifications: this.clarifications.list(),
      queue: this.publicQueue(),
      pendingSteers: this.pendingSteers.length,
      contextUsage: this.getContextUsage(),
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

  async refreshPluginIndex() {
    const pluginRoots = resolvePluginRoots(this.settings, this.workspaceDir);
    this.pluginIndex = await discoverPlugins(pluginRoots);
    return this.pluginIndex;
  }

  formatPluginList() {
    const plugins = [...this.pluginIndex.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (plugins.length === 0) return "No plugins discovered.";
    const commandIndex = discoverPluginCommands(this.pluginIndex);
    return makeAssistantContent([
      "## Plugins",
      ...plugins.map((plugin) => {
        const commands = [...commandIndex.values()]
          .filter((command) => command.pluginName === plugin.name)
          .map((command) => command.slash)
          .sort((a, b) => a.localeCompare(b));
        const commandText = commands.length > 0 ? ` (commands: ${commands.join(", ")})` : "";
        const versionText = plugin.version ? ` v${plugin.version}` : "";
        return `- **${plugin.name}**${versionText}${plugin.description ? `: ${plugin.description}` : ""}${commandText}`;
      }),
    ]);
  }

  formatPluginCommandList() {
    const commands = [...discoverPluginCommands(this.pluginIndex).values()].sort((a, b) => a.name.localeCompare(b.name));
    if (commands.length === 0) return "No plugin commands discovered.";
    return makeAssistantContent([
      "## Plugin Commands",
      ...commands.map((command) => `- \`${command.slash}\` → ${command.pluginName}${command.description ? `: ${command.description}` : ""}`),
    ]);
  }

  startBtwTask(input) {
    const raw = String(input || "").trim();
    const task = raw.replace(/^\/btw(?:\s+|$)/i, "").trim();
    if (!task) return "Usage: `/btw <read-only question>`.";
    if (!this.agent || typeof this.agent.runSubagent !== "function") {
      return "/btw unavailable: subagent support is not configured.";
    }
    const started = `Started background read-only task: ${task}`;
    void this.agent
      .runSubagent(
        {
          task,
          context: [
            "This is a user-invoked /btw background task from the Web UI.",
            "It must be strict read-only and must not modify files, todos, memory, settings, shell state, services, or external systems.",
            "Answer concisely so the main task can continue uninterrupted.",
            this.activeTask ? `Main task currently running: ${this.activeTask}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          mode: "analysis",
          toolBudget: 3,
        },
        { strictReadOnly: true }
      )
      .then((result) => {
        this.addAssistantMessage(`BTW result for: ${task}\n\n${String(result || "").trim()}`);
      })
      .catch((err) => {
        this.addAssistantMessage(`BTW failed for: ${task}\n\n${String(err?.message || err)}`);
      });
    return started;
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

  updateTimelineItem(id, patch = {}) {
    const targetId = String(id || "");
    if (!targetId) return null;
    const idx = this.timeline.findIndex((item) => String(item?.id || "") === targetId);
    if (idx < 0) return null;
    const updated = { ...this.timeline[idx], ...(patch || {}) };
    this.timeline[idx] = updated;
    this.publish("timeline.update", { id: targetId, patch });
    return updated;
  }

  makeToolRunKey(evt = {}) {
    const tool = String(evt.tool || "tool");
    const input = evt.input && typeof evt.input === "object" ? evt.input : {};
    const signature = JSON.stringify({ tool, input: redactInput(input), parallel: Boolean(evt.parallel) });
    return `${tool}:${signature}`;
  }

  findLatestToolTimelineId(tool, statuses = []) {
    const targetTool = String(tool || "tool");
    const wanted = new Set(statuses.map((status) => String(status)));
    for (let i = this.timeline.length - 1; i >= 0; i -= 1) {
      const item = this.timeline[i];
      if (item?.type !== "tool" || String(item.tool || "tool") !== targetTool) continue;
      if (wanted.size > 0 && !wanted.has(String(item.status || ""))) continue;
      return item.id;
    }
    return "";
  }

  handleAgentEvent(evt = {}) {
    const type = String(evt?.type || "event");
    if (type === "tool_use") {
      const key = this.makeToolRunKey(evt);
      const tool = String(evt.tool || "tool");
      const input = redactInput(evt.input);
      const reason = String(evt.reason || "");
      const thought = String(evt.thought || "");
      const note = thought || reason;
      const item = this.addTimelineItem({
        type: "tool",
        status: "queued",
        tool,
        input,
        reason,
        thought,
        note,
        parallel: Boolean(evt.parallel),
      });
      this.activeToolRuns.set(key, item.id);
      this.publish(type, { ...evt, input, reason, thought, note, timelineId: item.id });
      return;
    }
    if (type === "tool_start") {
      const key = this.makeToolRunKey(evt);
      const existingId = this.activeToolRuns.get(key) || this.findLatestToolTimelineId(evt.tool, ["queued"]);
      if (existingId) {
        this.activeToolRuns.set(key, existingId);
        this.updateTimelineItem(existingId, {
          status: "running",
          input: redactInput(evt.input),
          startedAt: new Date().toISOString(),
        });
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
      const [key, activeTimelineId] = candidates[candidates.length - 1] || [];
      const timelineId = activeTimelineId || this.findLatestToolTimelineId(evt.tool, ["running", "queued"]);
      if (key) this.activeToolRuns.delete(key);
      if (timelineId) {
        this.updateTimelineItem(timelineId, {
          status: evt.error ? "error" : "done",
          error: evt.error || "",
          result: details,
          finishedAt: new Date().toISOString(),
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
    if (type === "plan" || type === "replan") {
      const plan = evt.plan && typeof evt.plan === "object" ? evt.plan : {};
      this.addTimelineItem({
        type: "progress",
        kind: type,
        title: type === "replan" ? "Plan updated" : "Plan",
        content: String(plan.summary || "Execution plan"),
        steps: Array.isArray(plan.steps) ? plan.steps.slice(0, 8).map((step) => String(step || "")).filter(Boolean) : [],
      });
      this.publish(type, evt);
      return;
    }
    if (type === "thought") {
      this.addTimelineItem({ type: "progress", kind: "thought", title: "Thinking", content: String(evt.content || "") });
      this.publish(type, evt);
      return;
    }
    if (type === "steer_applied") {
      this.addTimelineItem({ type: "progress", kind: "steer", title: "Steer applied", content: String(evt.content || "") });
      this.publish(type, evt);
      return;
    }
    if (type === "log") {
      const line = String(evt.line || evt.message || "").trim();
      if (line) this.addTimelineItem({ type: "progress", kind: "log", title: "Log", content: line });
      this.publish(type, evt);
      return;
    }
    if (type === "model_call" || type === "planning_call" || type === "replanning_call") {
      this.addTimelineItem({
        type: "progress",
        kind: "model",
        title: type === "model_call" ? "Model call" : "Planning",
        content: [evt.provider, evt.model].filter(Boolean).join(" · ") || "Calling model",
      });
      this.publish(type, evt);
      return;
    }
    if (type === "llm_request") {
      this.publish(type, { stage: evt.stage, preview: String(evt.payload || "").slice(0, 600) });
      return;
    }
    if (type === "llm_response") {
      const usage = evt.usage && typeof evt.usage === "object" ? evt.usage : null;
      const inputTokens = toPositiveInteger(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.tokens_in);
      let outputTokens = toPositiveInteger(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.tokens_out);
      const totalTokens = toPositiveInteger(usage?.total_tokens ?? usage?.tokens);
      if (!outputTokens && totalTokens && inputTokens) outputTokens = Math.max(0, totalTokens - inputTokens);
      if (inputTokens || outputTokens || totalTokens) {
        this.tokenUsage.sent += inputTokens;
        this.tokenUsage.received += outputTokens;
        this.tokenUsage.last = {
          input_tokens: inputTokens || null,
          output_tokens: outputTokens || null,
          total_tokens: totalTokens || inputTokens + outputTokens || null,
        };
      }
      this.publish(type, { stage: evt.stage, usage: evt.usage || null, preview: String(evt.payload || "").slice(0, 800) });
      this.publish("context.update", { contextUsage: this.getContextUsage() });
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
      const pluginCommandCount = discoverPluginCommands(this.pluginIndex).size;
      const skillCommandCount = discoverSkillCommands(this.skillIndex).size;
      const lines = [
        "## Web Slash Commands",
        ...WEB_SLASH_COMMANDS.map((command) => `- \`${command.name}\`${command.description ? ` — ${command.description}` : ""}`),
      ];
      if (pluginCommandCount || skillCommandCount) {
        lines.push("");
        lines.push(`Discovered ${pluginCommandCount} plugin command(s) and ${skillCommandCount} skill command(s). Use \`/plugins commands\` or \`/skills commands\` to list them.`);
      }
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
      this.pendingSteers = [];
      this.agent.clearHistory();
      this.publish("todos", { todos: [] });
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: "Conversation context cleared." };
    }
    if (lower === "/btw" || lower.startsWith("/btw ")) {
      return { handled: true, message: this.startBtwTask(raw) };
    }
    if (lower === "/detail") {
      return { handled: true, patch: { detailMode: Boolean(this.detailMode) }, message: `Detail mode: ${this.detailMode ? "on" : "off"}. Use \`/detail on\` or \`/detail off\`.` };
    }
    if (lower.startsWith("/detail ")) {
      const enabled = normalizeBoolean(argAfter("/detail "));
      if (enabled === null) return { handled: true, message: "Usage: `/detail on` or `/detail off`." };
      this.detailMode = enabled;
      this.publish("snapshot", this.snapshot());
      return { handled: true, patch: { detailMode: enabled }, message: `Detail mode ${enabled ? "enabled" : "disabled"}.` };
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
    if (lower === "/goal" || lower.startsWith("/goal ")) {
      const goal = raw.replace(/^\/goal(?:\s+|$)/i, "").trim();
      if (!goal) {
        return {
          handled: true,
          message: "Usage: `/goal <task>`. Goal mode loops until acceptance is complete, blocked, or the max turn limit is reached.",
        };
      }
      return {
        handled: false,
        input: buildGoalPrompt(goal),
        displayInput: raw,
        goal,
      };
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
    if (lower === "/plugins" || lower === "/plugin") {
      const names = this.activePluginsRef.value.map((plugin) => plugin.name);
      return { handled: true, message: names.length ? `Active plugins: ${names.join(", ")}` : "Active plugins: none." };
    }
    if (lower === "/plugins list" || lower === "/plugin list") {
      return { handled: true, message: this.formatPluginList() };
    }
    if (lower === "/plugins commands" || lower === "/plugin commands") {
      return { handled: true, message: this.formatPluginCommandList() };
    }
    if (lower === "/plugins clear" || lower === "/plugin clear") {
      this.activePluginsRef.value = [];
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: "All plugins disabled." };
    }
    if (lower.startsWith("/plugins install ") || lower.startsWith("/plugin install ")) {
      const payload = raw.replace(/^\/plugins?\s+install\s+/i, "").trim();
      const parsed = parsePluginInstallArgs(payload);
      if (parsed.error) return { handled: true, message: `Usage: \`/plugins install <source> [--name <name>] [--project]\` (${parsed.error}).` };
      try {
        const result = await installPlugin({
          source: parsed.source,
          name: parsed.name,
          project: parsed.project,
          workspaceDir: this.workspaceDir,
        });
        await this.refreshPluginIndex();
        this.publish("snapshot", this.snapshot());
        return { handled: true, message: `Installed plugin: ${result.name}. Enable with \`/plugins use ${result.name}\`.` };
      } catch (err) {
        return { handled: true, message: `Plugin install failed: ${String(err?.message || err)}` };
      }
    }
    if (lower.startsWith("/plugins update") || lower.startsWith("/plugin update")) {
      const target = raw.replace(/^\/plugins?\s+update\s*/i, "").trim() || "all";
      const targets = target.toLowerCase() === "all" ? [...this.pluginIndex.values()] : [this.pluginIndex.get(target)].filter(Boolean);
      if (targets.length === 0) return { handled: true, message: `Plugin not found: ${target}` };
      const lines = [];
      for (const plugin of targets) {
        try {
          const result = await updatePlugin({ plugin });
          lines.push(result.ok ? `Updated plugin: ${plugin.name}` : `Plugin update skipped: ${plugin.name} (${result.reason})`);
        } catch (err) {
          lines.push(`Plugin update failed: ${plugin.name}: ${String(err?.message || err)}`);
        }
      }
      await this.refreshPluginIndex();
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: makeAssistantContent(lines) };
    }
    if (lower.startsWith("/plugins use ") || lower.startsWith("/plugin use ")) {
      const name = raw.replace(/^\/plugins?\s+use\s+/i, "").trim();
      const result = await addPluginByName(this.activePluginsRef.value, this.pluginIndex, name);
      this.activePluginsRef.value = result.active;
      if (result.added) {
        this.publish("snapshot", this.snapshot());
        return { handled: true, message: `Enabled plugin: ${name}` };
      }
      return { handled: true, message: result.reason === "already-enabled" ? `Plugin already enabled: ${name}` : `Unable to enable plugin: ${name} (${result.reason})` };
    }
    if (lower.startsWith("/plugins off ") || lower.startsWith("/plugin off ")) {
      const name = raw.replace(/^\/plugins?\s+off\s+/i, "").trim();
      const result = removePluginByName(this.activePluginsRef.value, name);
      this.activePluginsRef.value = result.active;
      this.publish("snapshot", this.snapshot());
      return { handled: true, message: result.removed ? `Disabled plugin: ${name}` : `Plugin not active: ${name}` };
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

    const pluginCommand = resolvePluginCommand(raw, this.pluginIndex);
    if (pluginCommand) {
      const result = await addPluginByName(this.activePluginsRef.value, this.pluginIndex, pluginCommand.pluginName);
      if (result.added) {
        this.activePluginsRef.value = result.active;
        this.publish("snapshot", this.snapshot());
      }
      if (result.reason === "not-found" || result.reason === "unreadable") {
        if (!pluginCommand.plugin) {
          return { handled: true, message: `Plugin command unavailable: ${pluginCommand.slash} (${result.reason})` };
        }
        this.activePluginsRef.value = [...this.activePluginsRef.value, pluginCommand.plugin];
        this.publish("snapshot", this.snapshot());
      }
      return { handled: false, input: pluginCommand.prompt, displayInput: raw };
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
    let text = String(content || "").trim();
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    if (!text && attachments.length > 0) text = "Please inspect the attached image.";
    if (!text) throw new Error("Message is required");
    if (attachments.length > 0 && text.startsWith("/")) throw new Error("Attachments cannot be used with slash commands.");
    const isBtw = /^\/btw(?:\s+|$)/i.test(text);
    if (this.running && !isBtw && !options.fromQueue) throw new Error("A task is already running");

    if (text.startsWith("/")) {
      const slash = await this.handleSlashCommand(text);
      if (slash.handled) return this.addAssistantMessage(slash.message);
      options = { ...options, displayInput: slash.displayInput || text, ...(slash.goal ? { goal: slash.goal } : {}) };
      content = slash.input || text;
    }

    this.refreshProvider();
    await autoEnableSkills(content, this.activeSkillsRef, this.skillIndex);
    await autoEnablePlugins(content, this.activePluginsRef, this.pluginIndex);
    const mentionContext = await buildFileMentionContext(content, { cwd: this.workspaceDir });
    const modelContent = mentionContext.prompt;
    const attachedMentions = mentionContext.mentions.filter((item) => item.status === "inline" || item.status === "preview");
    if (attachedMentions.length > 0) {
      this.publish("log", {
        line: `attached referenced files: ${attachedMentions.filter((item) => item.status === "inline").length} inline, ${attachedMentions.filter((item) => item.status === "preview").length} preview`,
      });
    }
    this.running = true;
    this.activeTask = text;
    this.lastError = "";
    const userMessage = { id: makeId("msg"), role: "user", content: text, attachments: publicAttachments(attachments), at: new Date().toISOString() };
    this.messages.push(userMessage);
    this.addTimelineItem({ ...userMessage, type: "message" });
    this.publish("message", userMessage);
    this.publish("task.start", { input: text });

    try {
      const goalRun = options.goal ? createGoalRun(options.goal, { env: process.env }) : null;
      if (goalRun) {
        this.publish("log", { line: `[goal] loop started (max ${goalRun.maxIterations} turns)` });
        if (options.planOnly || this.planOnly) {
          this.publish("log", { line: "[goal] executing with plan mode off for this goal loop" });
        }
      }
      let turnInput = modelContent;
      let result = "";
      while (true) {
        result = await this.agent.runTurn(turnInput, {
          planOnly: goalRun ? goalRun.planOnly : Boolean(options.planOnly ?? this.planOnly),
          attachments: goalRun && goalRun.iteration > 1 ? [] : attachments,
        });
        if (!goalRun) break;
        const contentOut = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        goalRun.lastOutput = contentOut;
        goalRun.status = parseGoalStatus(contentOut);
        goalRun.lastCheckpoint = summarizeGoalOutput(contentOut);
        this.publish("log", { line: `[goal] status=${goalRun.status} turn=${goalRun.iteration}/${goalRun.maxIterations}` });
        if (goalRun.status === "complete" || goalRun.status === "blocked") break;
        if (goalRun.iteration >= goalRun.maxIterations) {
          this.publish("log", { line: "[goal] max goal turns reached; stopping for user review" });
          break;
        }
        goalRun.iteration += 1;
        turnInput = buildGoalContinuationPrompt(goalRun.goal, goalRun.iteration, goalRun.lastOutput, {
          maxIterations: goalRun.maxIterations,
          checkpoint: goalRun.lastCheckpoint,
        });
      }
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
      if (!options.fromQueue) void this.processQueue();
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

export async function main() {
  const settingsFile = getSettingsFilePath();
  const settings = await loadSettings(settingsFile);
  const workspaceDir = process.cwd();
  const session = new WebAgentSession({ workspaceDir, settings, settingsFile });
  await session.init();

  const { host, port } = resolveWebBindOptions(process.env);
  const authToken = createWebAuthToken(process.env);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      if (url.pathname.startsWith("/api/")) {
        const origin = validateWebOrigin(req, host, port);
        if (!origin.ok) {
          jsonResponse(res, 403, { error: origin.reason || "forbidden" });
          return;
        }
        if (!isAuthorizedWebRequest(req, url, authToken)) {
          jsonResponse(res, 401, { error: "unauthorized" });
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        session.subscribe(res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        jsonResponse(res, 200, session.snapshot());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/session/diff") {
        jsonResponse(res, 200, await getSessionDiff(session.workspaceDir));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJsonBody(req, MAX_MESSAGE_BODY_BYTES);
        const message = String(body.message || "").trim();
        const attachments = normalizeWebAttachments(body.attachments);
        if (typeof body.planOnly === "boolean") session.planOnly = body.planOnly;
        const mode = String(body.mode || "auto").trim().toLowerCase();
        const isBtw = /^\/btw(?:\s+|$)/i.test(message);
        if (session.running && !isBtw) {
          if ((mode === "steer" || mode === "auto") && attachments.length === 0) {
            const steer = session.addSteer(message);
            jsonResponse(res, 202, { ok: true, steered: true, id: steer.id });
            return;
          }
          const queued = session.enqueueMessage(message, { planOnly: session.planOnly, attachments });
          jsonResponse(res, 202, { ok: true, queued: true, id: queued.id });
          return;
        }
        session.sendMessage(message, { planOnly: session.planOnly, attachments }).catch((err) => {
          const error = String(err?.message || err || "message failed");
          session.lastError = error;
          session.publish("task.error", { error });
        });
        jsonResponse(res, 202, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/approvals") {
        const body = await readJsonBody(req);
        const ok = session.approvals.resolve(body.id, body.decision);
        jsonResponse(res, ok ? 200 : 404, { ok });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/clarifications") {
        const body = await readJsonBody(req);
        const ok = session.clarifications.resolve(body.id, body.selectedIndexes || body.selected);
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
      if (req.method === "POST" && url.pathname === "/api/detail-mode") {
        const body = await readJsonBody(req);
        session.detailMode = Boolean(body.enabled);
        session.publish("snapshot", session.snapshot());
        jsonResponse(res, 200, { ok: true, enabled: session.detailMode });
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

  server.listen(port, host, () => {
    const urls = host === "127.0.0.1" || host === "localhost" ? [`http://localhost:${port}`] : getLocalNetworkUrls(port);
    console.log("PieCode Web is running:");
    for (const item of urls) console.log(`  ${authToken ? `${item}?token=${authToken}` : item}`);
    if (authToken) console.log("Web API token auth is enabled by PIECODE_WEB_TOKEN.");
    if (host === "0.0.0.0") console.log(authToken ? "warning: web UI is bound to all interfaces; keep the token private." : "warning: web UI is bound to all interfaces without token auth.");
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`fatal: ${err.message}`);
    process.exit(1);
  });
}

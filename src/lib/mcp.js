import { promises as fs } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_INIT_TIMEOUT_MS = 15000;
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "piecode", version: "0.1.0" };

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqStrings(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function expandHome(filePath, homeDir = os.homedir()) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return path.join(homeDir, raw.slice(2));
  return raw;
}

function toAbsolutePath(filePath, workspaceDir, homeDir = os.homedir()) {
  const expanded = expandHome(filePath, homeDir);
  if (!expanded) return "";
  return path.isAbsolute(expanded) ? expanded : path.resolve(workspaceDir, expanded);
}

function toStringMap(value) {
  if (!isRecord(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    out[key] = String(raw ?? "");
  }
  return out;
}

function normalizeServerConfig(name, raw, workspaceDir) {
  if (!isRecord(raw)) return null;
  if (raw.disabled === true) return null;
  const command = String(raw.command || "").trim();
  if (!command) return null;
  const args = Array.isArray(raw.args) ? raw.args.map((item) => String(item ?? "")) : [];
  const env = toStringMap(raw.env);
  const cwdRaw = String(raw.cwd || "").trim();
  const cwd = cwdRaw ? (path.isAbsolute(cwdRaw) ? cwdRaw : path.resolve(workspaceDir, cwdRaw)) : workspaceDir;
  return {
    name,
    command,
    args,
    env,
    cwd,
  };
}

export function resolveMcpServerConfigs(settings = {}, workspaceDir = process.cwd()) {
  const direct = isRecord(settings?.mcpServers) ? settings.mcpServers : {};
  const nested = isRecord(settings?.mcp?.servers) ? settings.mcp.servers : {};
  const merged = {
    ...nested,
    ...direct,
  };
  const out = new Map();
  for (const [name, raw] of Object.entries(merged)) {
    const key = String(name || "").trim();
    if (!key) continue;
    const normalized = normalizeServerConfig(key, raw, workspaceDir);
    if (!normalized) continue;
    out.set(key, normalized);
  }
  return out;
}

function extractMcpServerObject(value) {
  if (!isRecord(value)) return {};
  const direct = isRecord(value?.mcpServers) ? value.mcpServers : {};
  const nested = isRecord(value?.mcp?.servers) ? value.mcp.servers : {};
  const snake = isRecord(value?.mcp_servers) ? value.mcp_servers : {};
  return {
    ...nested,
    ...snake,
    ...direct,
  };
}

function defaultCommonMcpConfigPaths(workspaceDir, homeDir = os.homedir()) {
  return uniqStrings([
    path.join(workspaceDir, ".mcp.json"),
    path.join(workspaceDir, ".cursor", "mcp.json"),
    path.join(workspaceDir, ".cursor", "mcp_settings.json"),
    path.join(homeDir, ".cursor", "mcp.json"),
    path.join(homeDir, ".cursor", "mcp_settings.json"),
    path.join(homeDir, ".codex", "mcp.json"),
    path.join(homeDir, ".claude", "claude_desktop_config.json"),
    path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(homeDir, ".config", "claude", "claude_desktop_config.json"),
    path.join(homeDir, ".config", "Claude", "claude_desktop_config.json"),
  ]);
}

async function readJsonFileSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveMcpImportPaths(settings = {}, { workspaceDir = process.cwd(), env = process.env, homeDir = os.homedir() } = {}) {
  const importCfg = isRecord(settings?.mcpImport) ? settings.mcpImport : {};
  const includeDefaults = importCfg.includeDefaults !== false;
  const explicitPaths = toArray(importCfg.paths);
  const envPaths = splitList(env?.PIECODE_MCP_CONFIG_PATHS);
  const defaults = includeDefaults ? defaultCommonMcpConfigPaths(workspaceDir, homeDir) : [];
  const ordered = [...defaults, ...envPaths, ...explicitPaths];
  return uniqStrings(ordered.map((item) => toAbsolutePath(item, workspaceDir, homeDir)).filter(Boolean));
}

export async function mergeCommonMcpServers(
  settings = {},
  { workspaceDir = process.cwd(), env = process.env, homeDir = os.homedir(), onLog = null } = {}
) {
  if (!isRecord(settings)) return {};
  const importCfg = isRecord(settings?.mcpImport) ? settings.mcpImport : {};
  const importEnabled = importCfg.enabled !== false && String(env?.PIECODE_MCP_IMPORT || "1") !== "0";
  if (!importEnabled) return settings;

  const paths = resolveMcpImportPaths(settings, { workspaceDir, env, homeDir });
  if (paths.length === 0) return settings;

  let importedCount = 0;
  const imported = {};
  for (const filePath of paths) {
    const parsed = await readJsonFileSafe(filePath);
    const servers = extractMcpServerObject(parsed);
    const names = Object.keys(servers);
    if (names.length === 0) continue;
    importedCount += names.length;
    Object.assign(imported, servers);
  }
  if (Object.keys(imported).length === 0) return settings;

  const localNested = isRecord(settings?.mcp?.servers) ? settings.mcp.servers : {};
  const localDirect = isRecord(settings?.mcpServers) ? settings.mcpServers : {};
  const merged = {
    ...imported,
    ...localNested,
    ...localDirect,
  };

  if (typeof onLog === "function") {
    onLog(
      `[mcp] imported ${importedCount} server entr${importedCount === 1 ? "y" : "ies"} from shared config files`
    );
  }

  const next = {
    ...settings,
    mcpServers: merged,
  };
  const nextMcp = isRecord(settings?.mcp) ? { ...settings.mcp } : {};
  nextMcp.servers = merged;
  next.mcp = nextMcp;
  return next;
}

class JsonRpcStdioPeer {
  constructor(child, { serverName = "mcp", onLog = null } = {}) {
    this.child = child;
    this.serverName = String(serverName || "mcp");
    this.onLog = typeof onLog === "function" ? onLog : null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onNotification = null;

    if (this.child?.stdout) {
      this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    }
    if (this.child?.stderr) {
      this.child.stderr.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (!text || !this.onLog) return;
        this.onLog(`[mcp:${this.serverName}] ${text}`);
      });
    }
    this.child?.on("error", (err) => {
      this.rejectAll(err || new Error("MCP process error"));
    });
    this.child?.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(
        new Error(
          `MCP server "${this.serverName}" exited (code=${code == null ? "-" : code}, signal=${signal || "-"})`
        )
      );
    });
    this.child?.on("close", () => {
      this.closed = true;
    });
  }

  rejectAll(err) {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.rejectAll(new Error(`MCP server "${this.serverName}" closed`));
  }

  handleStdout(chunk) {
    if (!chunk || this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    this.drainBuffer();
  }

  drainBuffer() {
    const sep = Buffer.from("\r\n\r\n");
    while (true) {
      const headerEnd = this.buffer.indexOf(sep);
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const lines = headerText
        .split("\r\n")
        .map((line) => line.trim())
        .filter(Boolean);
      let contentLength = 0;
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === "content-length") {
          contentLength = Number.parseInt(value, 10);
        }
      }
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.buffer = this.buffer.slice(headerEnd + sep.length);
        continue;
      }

      const messageStart = headerEnd + sep.length;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;

      const payload = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.handleMessage(payload);
    }
  }

  handleMessage(payload) {
    let msg = null;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (Object.prototype.hasOwnProperty.call(msg, "id")) {
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error) {
        const errorMessage = String(msg.error?.message || "JSON-RPC error");
        pending.reject(new Error(errorMessage));
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    if (msg.method && typeof this.onNotification === "function") {
      this.onNotification(msg.method, msg.params);
    }
  }

  writeMessage(message) {
    if (this.closed) throw new Error(`MCP server "${this.serverName}" is not available`);
    const payload = JSON.stringify(message);
    const bytes = Buffer.byteLength(payload, "utf8");
    const framed = `Content-Length: ${bytes}\r\n\r\n${payload}`;
    this.child.stdin.write(framed, "utf8");
  }

  notify(method, params = {}) {
    this.writeMessage({
      jsonrpc: "2.0",
      method: String(method || ""),
      params: isRecord(params) ? params : {},
    });
  }

  request(method, params = {}, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, Math.max(1000, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          method: String(method || ""),
          params: isRecord(params) ? params : {},
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}

class McpServerClient {
  constructor(config, { onLog = null } = {}) {
    this.config = config;
    this.onLog = typeof onLog === "function" ? onLog : null;
    this.process = null;
    this.peer = null;
    this.ready = false;
    this.initPromise = null;
    this.serverInfo = null;
    this.capabilities = {};
  }

  async ensureReady() {
    if (this.ready) return;
    if (!this.initPromise) {
      this.initPromise = this.start();
    }
    try {
      await this.initPromise;
    } finally {
      if (!this.ready) this.initPromise = null;
    }
  }

  async start() {
    if (this.ready) return;
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...this.config.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.peer = new JsonRpcStdioPeer(child, {
      serverName: this.config.name,
      onLog: this.onLog,
    });

    const initializeResult = await this.peer.request(
      "initialize",
      {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      { timeoutMs: DEFAULT_INIT_TIMEOUT_MS }
    );

    this.serverInfo = isRecord(initializeResult?.serverInfo) ? initializeResult.serverInfo : null;
    this.capabilities = isRecord(initializeResult?.capabilities) ? initializeResult.capabilities : {};
    this.peer.notify("notifications/initialized", {});
    this.ready = true;
  }

  async request(method, params = {}, options = {}) {
    await this.ensureReady();
    return this.peer.request(method, params, options);
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, input = {}) {
    return this.request("tools/call", {
      name: String(name || ""),
      arguments: isRecord(input) ? input : {},
    });
  }

  async listResources(cursor = null) {
    const params = {};
    if (cursor != null) params.cursor = String(cursor);
    return this.request("resources/list", params);
  }

  async listResourceTemplates(cursor = null) {
    const params = {};
    if (cursor != null) params.cursor = String(cursor);
    return this.request("resources/templates/list", params);
  }

  async readResource(uri) {
    return this.request("resources/read", {
      uri: String(uri || ""),
    });
  }

  async close() {
    this.ready = false;
    this.initPromise = null;
    try {
      this.peer?.close();
    } catch {
      // no-op
    }
    const proc = this.process;
    this.peer = null;
    this.process = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // no-op
    }
  }
}

function normalizeToolEntry(server, raw) {
  const name = String(raw?.name || "").trim();
  if (!name) return null;
  const description = String(raw?.description || "").trim();
  const inputSchema =
    (isRecord(raw?.inputSchema) && raw.inputSchema) ||
    (isRecord(raw?.input_schema) && raw.input_schema) ||
    {
      type: "object",
      properties: {},
    };
  return {
    server,
    name,
    description,
    input_schema: inputSchema,
  };
}

function normalizeResourceEntry(server, raw) {
  const uri = String(raw?.uri || "").trim();
  if (!uri) return null;
  const name = String(raw?.name || "").trim();
  const description = String(raw?.description || "").trim();
  const mimeType = String(raw?.mimeType || raw?.mime_type || "").trim();
  return {
    server,
    uri,
    name,
    description,
    mimeType,
  };
}

function normalizeResourceTemplateEntry(server, raw) {
  const uriTemplate = String(raw?.uriTemplate || raw?.uri_template || "").trim();
  if (!uriTemplate) return null;
  const name = String(raw?.name || "").trim();
  const description = String(raw?.description || "").trim();
  const mimeType = String(raw?.mimeType || raw?.mime_type || "").trim();
  return {
    server,
    uriTemplate,
    name,
    description,
    mimeType,
  };
}

export class McpHub {
  constructor({ workspaceDir, settings = {}, onLog = null } = {}) {
    this.workspaceDir = String(workspaceDir || process.cwd());
    this.settings = settings && typeof settings === "object" ? settings : {};
    this.onLog = typeof onLog === "function" ? onLog : null;
    this.serverConfigs = resolveMcpServerConfigs(this.settings, this.workspaceDir);
    this.clients = new Map();
  }

  hasServers() {
    return this.serverConfigs.size > 0;
  }

  getServerNames() {
    return [...this.serverConfigs.keys()].sort((a, b) => a.localeCompare(b));
  }

  getConfig(name) {
    const key = String(name || "").trim();
    if (!key) throw new Error("MCP server name is required");
    const config = this.serverConfigs.get(key);
    if (!config) throw new Error(`Unknown MCP server: ${key}`);
    return config;
  }

  getClient(name) {
    const config = this.getConfig(name);
    if (this.clients.has(config.name)) return this.clients.get(config.name);
    const client = new McpServerClient(config, { onLog: this.onLog });
    this.clients.set(config.name, client);
    return client;
  }

  async listTools({ server = null } = {}) {
    if (!this.hasServers()) return [];
    const targets = server ? [String(server).trim()] : this.getServerNames();
    const out = [];
    for (const name of targets) {
      if (!name) continue;
      const client = this.getClient(name);
      const tools = await client.listTools();
      for (const raw of tools) {
        const row = normalizeToolEntry(name, raw);
        if (row) out.push(row);
      }
    }
    return out;
  }

  async callTool({ server, tool, input = {} } = {}) {
    const name = String(server || "").trim();
    const toolName = String(tool || "").trim();
    if (!name) throw new Error("server is required");
    if (!toolName) throw new Error("tool is required");
    const client = this.getClient(name);
    return client.callTool(toolName, isRecord(input) ? input : {});
  }

  async listResources({ server = null, cursor = null } = {}) {
    if (!this.hasServers()) return [];
    const targets = server ? [String(server).trim()] : this.getServerNames();
    const out = [];
    for (const name of targets) {
      if (!name) continue;
      const client = this.getClient(name);
      const result = await client.listResources(cursor);
      const resources = Array.isArray(result?.resources) ? result.resources : [];
      for (const raw of resources) {
        const row = normalizeResourceEntry(name, raw);
        if (row) out.push(row);
      }
    }
    return out;
  }

  async listResourceTemplates({ server = null, cursor = null } = {}) {
    if (!this.hasServers()) return [];
    const targets = server ? [String(server).trim()] : this.getServerNames();
    const out = [];
    for (const name of targets) {
      if (!name) continue;
      const client = this.getClient(name);
      const result = await client.listResourceTemplates(cursor);
      const templates = Array.isArray(result?.resourceTemplates) ? result.resourceTemplates : [];
      for (const raw of templates) {
        const row = normalizeResourceTemplateEntry(name, raw);
        if (row) out.push(row);
      }
    }
    return out;
  }

  async readResource({ server, uri } = {}) {
    const name = String(server || "").trim();
    const resourceUri = String(uri || "").trim();
    if (!name) throw new Error("server is required");
    if (!resourceUri) throw new Error("uri is required");
    const client = this.getClient(name);
    return client.readResource(resourceUri);
  }

  async close() {
    const closers = [...this.clients.values()].map((client) => client.close());
    this.clients.clear();
    await Promise.allSettled(closers);
  }
}

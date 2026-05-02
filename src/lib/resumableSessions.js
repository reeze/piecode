import { promises as fs } from "node:fs";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

export function makeSessionId() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `session-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function sessionRoot(workspaceDir) {
  return path.join(workspaceDir, ".piecode", "sessions");
}

function sessionFile(workspaceDir, sessionId) {
  return path.join(sessionRoot(workspaceDir), `${sessionId}.json`);
}

function summarizeTimeline(timeline = []) {
  const items = Array.isArray(timeline) ? timeline : [];
  const firstUser = items.find((item) => item?.type === "message" && item?.role === "user");
  const lastAssistant = [...items].reverse().find((item) => item?.type === "message" && item?.role === "assistant");
  const tools = items.filter((item) => item?.type === "tool").map((item) => String(item.tool || "tool"));
  const uniqueTools = [...new Set(tools)].slice(0, 4);
  const firstTask = String(firstUser?.content || "").replace(/\s+/g, " ").trim();
  const lastReply = String(lastAssistant?.content || "").replace(/\s+/g, " ").trim();
  if (firstTask && uniqueTools.length > 0) return `${firstTask.slice(0, 90)} · tools: ${uniqueTools.join(", ")}`;
  if (firstTask) return firstTask.slice(0, 120);
  if (lastReply) return lastReply.slice(0, 120);
  return "Empty web session";
}

export async function saveResumableSession(workspaceDir, session = {}) {
  const sessionId = String(session.sessionId || "").trim() || makeSessionId();
  const timeline = Array.isArray(session.timeline) ? session.timeline : [];
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const existing = await loadResumableSession(workspaceDir, sessionId).catch(() => null);
  const data = {
    schema: "piecode.resumable.session.v1",
    sessionId,
    createdAt: existing?.createdAt || session.createdAt || nowIso(),
    updatedAt: nowIso(),
    workspaceDir,
    summary: String(session.summary || summarizeTimeline(timeline) || "PieCode session"),
    providerLabel: String(session.providerLabel || ""),
    messages,
    timeline,
    todos: Array.isArray(session.todos) ? session.todos : [],
    agentHistory: Array.isArray(session.agentHistory) ? session.agentHistory : [],
  };
  await fs.mkdir(sessionRoot(workspaceDir), { recursive: true });
  await fs.writeFile(sessionFile(workspaceDir, sessionId), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return data;
}

export async function loadResumableSession(workspaceDir, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session id is required");
  const raw = await fs.readFile(sessionFile(workspaceDir, id), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid session: ${id}`);
  return parsed;
}

export async function listResumableSessions(workspaceDir, limit = 20) {
  let entries = [];
  try {
    entries = await fs.readdir(sessionRoot(workspaceDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const id = entry.name.replace(/\.json$/, "");
      const data = await loadResumableSession(workspaceDir, id);
      rows.push({
        sessionId: data.sessionId || id,
        shortId: shortSessionId(data.sessionId || id),
        createdAt: data.createdAt || "",
        updatedAt: data.updatedAt || "",
        summary: data.summary || summarizeTimeline(data.timeline),
        providerLabel: data.providerLabel || "",
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        toolCount: Array.isArray(data.timeline) ? data.timeline.filter((item) => item?.type === "tool").length : 0,
      });
    } catch {
      // Skip corrupt session files.
    }
  }
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return rows.slice(0, Math.max(1, Number(limit) || 20));
}

export function shortSessionId(sessionId) {
  const raw = String(sessionId || "");
  const tail = raw.match(/([a-z0-9]{4,})$/i)?.[1] || raw.slice(-6);
  return tail.slice(-6);
}

export async function resolveResumableSessionId(workspaceDir, query) {
  const q = String(query || "").trim();
  if (!q) throw new Error("Session id is required");
  const sessions = await listResumableSessions(workspaceDir, 200);
  const exact = sessions.find((item) => item.sessionId === q || item.shortId === q);
  if (exact) return exact.sessionId;
  const starts = sessions.filter((item) => item.sessionId.startsWith(q) || item.shortId.startsWith(q));
  if (starts.length === 1) return starts[0].sessionId;
  if (starts.length > 1) throw new Error(`Ambiguous session id: ${q}`);
  throw new Error(`Session not found: ${q}`);
}

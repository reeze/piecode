import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_CLIP = 32000;

function clipString(value, max = DEFAULT_CLIP) {
  const text = String(value || "");
  const limit = Math.max(200, Number(max) || DEFAULT_CLIP);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[clipped ${text.length - limit} chars]`;
}

function toJsonSafe(value, depth = 0) {
  if (depth > 8) return "[MaxDepth]";
  if (value == null) return value;
  if (typeof value === "string") return clipString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[Function]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => toJsonSafe(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      out[key] = toJsonSafe(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function normalizeSessionEvent(type, payload = {}, options = {}) {
  const eventType = String(type || "event").trim() || "event";
  const sessionId = String(options?.sessionId || payload?.sessionId || "").trim();
  return {
    schema: "piecode.session.event.v1",
    id: String(options?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    at: String(options?.at || new Date().toISOString()),
    type: eventType,
    ...(sessionId ? { sessionId } : {}),
    payload: toJsonSafe(payload),
  };
}

export class SessionEventBus {
  constructor({ sessionId = "" } = {}) {
    this.sessionId = String(sessionId || "");
    this.listeners = new Set();
    this.events = [];
    this.maxEvents = 2000;
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, payload = {}) {
    const event = normalizeSessionEvent(type, payload, { sessionId: this.sessionId });
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(this.events.length - this.maxEvents);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event consumers are optional integrations; never break the agent.
      }
    }
    return event;
  }
}

export class AgentSessionState {
  constructor({ sessionId = "" } = {}) {
    this.sessionId = String(sessionId || "");
    this.status = "idle";
    this.model = "";
    this.provider = "";
    this.currentTask = "";
    this.lastError = "";
    this.activeTool = "";
    this.todos = [];
    this.tokenUsage = { sent: 0, received: 0 };
    this.timeline = [];
    this.maxTimeline = 1000;
  }

  apply(event) {
    const e = event && typeof event === "object" ? event : normalizeSessionEvent("event", event);
    const type = String(e.type || "");
    const payload = e.payload && typeof e.payload === "object" ? e.payload : {};

    if (type === "task.start") {
      this.status = "running";
      this.currentTask = String(payload.input || payload.text || "");
      this.lastError = "";
    } else if (type === "task.done") {
      this.status = "idle";
      this.lastError = "";
    } else if (type === "task.error") {
      this.status = "error";
      this.lastError = String(payload.error || payload.message || "");
    } else if (type === "agent.model_call") {
      this.status = "running";
      this.provider = String(payload.provider || this.provider || "");
      this.model = String(payload.model || this.model || "");
    } else if (type === "agent.planning_call" || type === "agent.replanning_call") {
      this.status = "running";
      this.provider = String(payload.provider || this.provider || "");
      this.model = String(payload.model || this.model || "");
    } else if (type === "agent.tool_use" || type === "agent.tool_start") {
      this.activeTool = String(payload.tool || "");
    } else if (type === "agent.tool_end") {
      this.activeTool = "";
      if (payload.error) this.lastError = String(payload.error || "");
    } else if (type === "agent.thinking_done") {
      if (this.status === "running") this.status = "idle";
    } else if (type === "todos.update") {
      this.todos = Array.isArray(payload.todos) ? payload.todos : [];
    } else if (type === "tokens.update") {
      this.tokenUsage = {
        sent: Math.max(0, Number(payload.sent) || 0),
        received: Math.max(0, Number(payload.received) || 0),
      };
    }

    this.timeline.push(e);
    if (this.timeline.length > this.maxTimeline) {
      this.timeline = this.timeline.slice(this.timeline.length - this.maxTimeline);
    }
    return this;
  }

  snapshot() {
    return {
      schema: "piecode.session.state.v1",
      sessionId: this.sessionId,
      status: this.status,
      model: this.model,
      provider: this.provider,
      currentTask: this.currentTask,
      lastError: this.lastError,
      activeTool: this.activeTool,
      todos: this.todos,
      tokenUsage: this.tokenUsage,
      timelineLength: this.timeline.length,
    };
  }
}

export function createJsonlSessionSink(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return null;
  const resolved = path.resolve(target);
  let chain = Promise.resolve();
  return (event) => {
    const line = `${JSON.stringify(normalizeSessionEvent(event?.type, event?.payload || {}, event))}\n`;
    chain = chain
      .then(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.appendFile(resolved, line, "utf8");
      })
      .catch(() => {});
    return chain;
  };
}

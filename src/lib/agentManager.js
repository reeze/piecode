export class AgentManager {
  constructor({ maxCompleted = 20 } = {}) {
    this.maxCompleted = Math.max(1, Math.min(200, Number(maxCompleted) || 20));
    this.nextId = 1;
    this.active = new Map();
    this.completed = [];
  }

  start({ task, mode = "analysis", toolBudget = 3, role = "subagent" } = {}) {
    const id = `${role}-${this.nextId++}`;
    const now = Date.now();
    const record = {
      id,
      role,
      task: String(task || ""),
      mode: String(mode || "analysis"),
      toolBudget: Math.max(1, Math.min(12, Number(toolBudget) || 3)),
      status: "running",
      startedAt: now,
      updatedAt: now,
      lastTool: "",
      tools: [],
      result: "",
      error: "",
    };
    this.active.set(id, record);
    return { ...record };
  }

  recordEvent(id, event = {}) {
    const key = String(id || "");
    if (!key || !this.active.has(key)) return null;
    const current = this.active.get(key);
    const type = String(event?.type || "");
    if (type === "tool_use") {
      const tool = String(event?.tool || "");
      current.lastTool = tool;
      if (tool) current.tools.push(tool);
    }
    if (type === "tool_end") {
      current.lastTool = String(event?.tool || current.lastTool || "");
    }
    current.updatedAt = Date.now();
    this.active.set(key, current);
    return { ...current, tools: [...current.tools] };
  }

  finish(id, { status = "done", result = "", error = "" } = {}) {
    const key = String(id || "");
    const current = this.active.get(key);
    if (!current) return null;
    this.active.delete(key);
    const now = Date.now();
    const completed = {
      ...current,
      status: String(status || "done"),
      result: String(result || ""),
      error: String(error || ""),
      endedAt: now,
      updatedAt: now,
      tools: [...current.tools],
    };
    this.completed.push(completed);
    if (this.completed.length > this.maxCompleted) {
      this.completed = this.completed.slice(-this.maxCompleted);
    }
    return { ...completed, tools: [...completed.tools] };
  }

  snapshot() {
    return {
      active: [...this.active.values()].map((item) => ({ ...item, tools: [...item.tools] })),
      completed: this.completed.map((item) => ({ ...item, tools: [...item.tools] })),
    };
  }

  clearCompleted() {
    this.completed = [];
  }
}

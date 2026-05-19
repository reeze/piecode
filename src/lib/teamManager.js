export class TeamManager {
  constructor({ maxCompleted = 50 } = {}) {
    this.maxCompleted = Math.max(1, Math.min(200, Number(maxCompleted) || 50));
    this.nextId = 1;
    this.assignments = new Map();
    this.completed = [];
  }

  startAssignment({ task, context = "", mode = "analysis", toolBudget = 3, role = "team-agent", agentDefinition = null, reason = "" } = {}) {
    const safeRole = String(role || "team-agent").trim() || "team-agent";
    const id = `${safeRole}-${this.nextId++}`;
    const now = Date.now();
    const record = {
      id,
      role: safeRole,
      task: String(task || ""),
      context: String(context || ""),
      mode: String(mode || "analysis"),
      toolBudget: Math.max(1, Math.min(6, Number(toolBudget) || 3)),
      reason: String(reason || ""),
      agentDefinition: agentDefinition && typeof agentDefinition === "object" ? { ...agentDefinition } : null,
      status: "working",
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      messages: [],
      events: [],
      result: "",
      error: "",
      subagentId: "",
    };
    this.assignments.set(id, record);
    return this.clone(record);
  }

  attachSubagent(id, subagentId) {
    const record = this.assignments.get(String(id || ""));
    if (!record) return null;
    record.subagentId = String(subagentId || "");
    record.updatedAt = Date.now();
    return this.clone(record);
  }

  recordEvent(id, event = {}) {
    const record = this.assignments.get(String(id || ""));
    if (!record) return null;
    const compact = {
      type: String(event?.type || ""),
      tool: String(event?.tool || ""),
      at: Date.now(),
    };
    if (compact.type || compact.tool) record.events.push(compact);
    if (record.events.length > 100) record.events = record.events.slice(-100);
    record.updatedAt = Date.now();
    return this.clone(record);
  }

  appendMessage(id, { from = "chief", to = "team", content = "", kind = "message" } = {}) {
    const record = this.assignments.get(String(id || ""));
    if (!record) return null;
    const message = {
      from: String(from || "chief"),
      to: String(to || "team"),
      kind: String(kind || "message"),
      content: String(content || ""),
      at: Date.now(),
    };
    record.messages.push(message);
    record.updatedAt = Date.now();
    return this.clone(record);
  }

  finishAssignment(id, { status = "done", result = "", error = "" } = {}) {
    const key = String(id || "");
    const record = this.assignments.get(key);
    if (!record) return null;
    const now = Date.now();
    record.status = String(status || "done");
    record.result = String(result || "");
    record.error = String(error || "");
    record.endedAt = now;
    record.updatedAt = now;
    this.assignments.set(key, record);
    const snapshot = this.clone(record);
    this.completed.push(snapshot);
    if (this.completed.length > this.maxCompleted) this.completed = this.completed.slice(-this.maxCompleted);
    return snapshot;
  }

  getAssignment(id) {
    const record = this.assignments.get(String(id || ""));
    return record ? this.clone(record) : null;
  }

  getStatus({ agentDefinitions = [] } = {}) {
    const definitions = Array.isArray(agentDefinitions) ? agentDefinitions : [];
    return {
      availableAgents: definitions.map((definition) => ({
        name: String(definition?.name || ""),
        description: String(definition?.description || ""),
        color: definition?.color || null,
        model: definition?.model || null,
        path: definition?.path || null,
      })).filter((definition) => definition.name),
      active: [...this.assignments.values()]
        .filter((item) => item.status === "working" || item.status === "waiting")
        .map((item) => this.clone(item)),
      completed: this.completed.map((item) => this.clone(item)),
    };
  }

  activeCount() {
    return [...this.assignments.values()].filter((item) => item.status === "working" || item.status === "waiting").length;
  }

  clone(record) {
    return {
      ...record,
      messages: Array.isArray(record.messages) ? record.messages.map((item) => ({ ...item })) : [],
      events: Array.isArray(record.events) ? record.events.map((item) => ({ ...item })) : [],
      agentDefinition: record.agentDefinition && typeof record.agentDefinition === "object" ? { ...record.agentDefinition } : null,
    };
  }
}

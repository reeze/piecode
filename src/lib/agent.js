import { createBackgroundTaskManager, createToolset } from "./tools.js";
import { buildSystemPrompt, formatHistory } from "./prompt.js";
import { TaskPlanner } from "./taskPlanner.js";
import { TurnEngine } from "./turnEngine.js";
import { shouldPlanTaskMessage } from "./plannedTaskRunner.js";
import { AgentManager } from "./agentManager.js";
import { TeamManager } from "./teamManager.js";
import { appendMemory, renderMemoryForPrompt } from "./memory.js";
import { runPluginToolHooks } from "./pluginHooks.js";

function summarizeToolUseNames(events = [], maxItems = 12) {
  const counts = new Map();
  for (const evt of Array.isArray(events) ? events : []) {
    if (evt?.type !== "tool_use") continue;
    const name = String(evt.tool || "unknown").trim() || "unknown";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxItems)
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
}

export class Agent {
  constructor({
    provider,
    workspaceDir,
    autoApproveRef,
    askApproval,
    askClarification,
    onEvent,
    activeSkillsRef,
    activePluginsRef,
    onTodoWrite,
    projectInstructionsRef,
    memoryRef,
    onMemoryWrite,
    mcpHub = null,
    webSearch = null,
    contextWindowRef = null,
    shellPermissionRef = null,
    subagentDepth = 0,
    agentManager = null,
    teamManager = null,
    agentDefinitionsRef = null,
    currentAgentDefinition = null,
    getSteers = null,
    backgroundTaskManager = null,
  }) {
    this.provider = provider;
    this.workspaceDir = workspaceDir;
    this.autoApproveRef = autoApproveRef;
    this.askApproval = askApproval;
    this.askClarification = askClarification;
    this.onEvent = onEvent;
    this.onTodoWrite = onTodoWrite;
    this.onMemoryWrite = onMemoryWrite;
    this.activeSkillsRef = activeSkillsRef || { value: [] };
    this.activePluginsRef = activePluginsRef || { value: [] };
    this.projectInstructionsRef = projectInstructionsRef || { value: null };
    this.memoryRef = memoryRef || { value: null };
    this.mcpHub = mcpHub && typeof mcpHub.hasServers === "function" ? mcpHub : null;
    this.webSearch = webSearch && typeof webSearch === "object" ? webSearch : null;
    this.contextWindowRef = contextWindowRef && typeof contextWindowRef === "object" ? contextWindowRef : { value: 0 };
    this.shellPermissionRef = shellPermissionRef && typeof shellPermissionRef === "object" ? shellPermissionRef : { value: {} };
    this.subagentDepth = Math.max(0, Number.parseInt(String(subagentDepth), 10) || 0);
    this.agentManager = agentManager instanceof AgentManager ? agentManager : new AgentManager();
    this.teamManager = teamManager instanceof TeamManager ? teamManager : new TeamManager();
    this.agentDefinitionsRef = agentDefinitionsRef && typeof agentDefinitionsRef === "object" ? agentDefinitionsRef : { value: [] };
    this.currentAgentDefinition = currentAgentDefinition && typeof currentAgentDefinition === "object" ? currentAgentDefinition : null;
    this.getSteers = typeof getSteers === "function" ? getSteers : null;
    this.backgroundTaskManager =
      backgroundTaskManager && typeof backgroundTaskManager.start === "function"
        ? backgroundTaskManager
        : createBackgroundTaskManager({ workspaceDir: this.workspaceDir });
    this.history = [];
    this.rebuildToolset();
    this.enablePlanner = process.env.PIECODE_ENABLE_PLANNER === "1";
    this.taskPlanner = this.enablePlanner ? new TaskPlanner(this) : null;
    this.planFirstEnabled = process.env.PIECODE_PLAN_FIRST === "1";
    this.defaultToolBudget = Math.max(
      1,
      Math.min(12, Number.parseInt(process.env.PIECODE_TOOL_BUDGET || "6", 10) || 6)
    );
    this.autoCompactThreshold = Math.max(
      0,
      Math.min(0.98, Number.parseFloat(process.env.PIECODE_AUTO_COMPACT_THRESHOLD || "0.8") || 0.8)
    );
    this.autoCompactPreserveRecent = Math.max(
      2,
      Math.min(30, Number.parseInt(process.env.PIECODE_AUTO_COMPACT_KEEP || "12", 10) || 12)
    );
    this.activeAbortController = null;
    this.systemPromptCache = new Map();
  }

  rebuildToolset() {
    this.tools = createToolset({
      workspaceDir: this.workspaceDir,
      autoApproveRef: this.autoApproveRef,
      askApproval: this.askApproval,
      askClarification: this.askClarification,
      onToolStart: (tool, input) => this.onEvent?.({ type: "tool_start", tool, input }),
      onTodoWrite: this.onTodoWrite,
      onMemoryWrite: this.onMemoryWrite,
      mcpHub: this.mcpHub,
      webSearch: this.webSearch,
      shellPermissionRef: this.shellPermissionRef,
      runSubagent: (input, options) => this.runSubagent(input, options),
      runCollaboration: (input, options) => this.runCollaboration(input, options),
      writeMemory: (input) => this.writeMemory(input),
      backgroundTaskManager: this.backgroundTaskManager,
    });
  }

  setWebSearch(webSearch = null) {
    this.webSearch = webSearch && typeof webSearch === "object" ? webSearch : null;
    this.rebuildToolset();
  }

  setMcpHub(mcpHub = null) {
    this.mcpHub = mcpHub && typeof mcpHub.hasServers === "function" ? mcpHub : null;
    this.rebuildToolset();
  }

  clearHistory() {
    this.history = [];
  }

  getMemoryPrompt() {
    return renderMemoryForPrompt(this.memoryRef?.value || null);
  }

  async writeMemory({ scope = "project", content } = {}) {
    const result = await appendMemory({
      workspaceDir: this.workspaceDir,
      scope,
      content,
    });
    const memory = this.memoryRef?.value;
    if (!result.skipped && memory && typeof memory === "object" && memory[result.scope]) {
      const current = String(memory[result.scope].content || "").trimEnd();
      const note = String(content || "").trim().replace(/\n+/g, "\n  ");
      memory[result.scope] = {
        ...memory[result.scope],
        content: `${current}${current ? "\n" : "# Memory\n\n"}- ${note}`.trimEnd(),
        state: "loaded",
        path: result.path,
        relPath: result.relPath,
      };
    }
    this.systemPromptCache.clear();
    return result;
  }

  requestAbort() {
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort();
      return true;
    }
    return false;
  }

  throwIfAborted(signal) {
    if (signal?.aborted) {
      const err = new Error("Task aborted by user.");
      err.code = "TASK_ABORTED";
      throw err;
    }
  }

  normalizeUsageSnapshot(raw) {
    if (!raw || typeof raw !== "object") return null;
    const toInt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
    };
    const input = toInt(raw.input_tokens ?? raw.prompt_tokens);
    const output = toInt(raw.output_tokens ?? raw.completion_tokens);
    const total = toInt(raw.total_tokens);
    const usage = {};
    if (input != null) usage.input_tokens = input;
    if (output != null) usage.output_tokens = output;
    if (total != null) usage.total_tokens = total;
    if (usage.total_tokens == null && usage.input_tokens != null && usage.output_tokens != null) {
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
    }
    return Object.keys(usage).length > 0 ? usage : null;
  }

  getProviderUsageSnapshot() {
    try {
      if (!this.provider || typeof this.provider.getLastUsage !== "function") return null;
      return this.normalizeUsageSnapshot(this.provider.getLastUsage());
    } catch {
      return null;
    }
  }

  emitLlmResponse(stage, payload) {
    this.onEvent?.({
      type: "llm_response",
      stage,
      payload: String(payload || ""),
      usage: this.getProviderUsageSnapshot(),
    });
  }

  estimateTokenCount(text) {
    const source = String(text || "");
    if (!source) return 0;
    return Math.max(1, Math.round(source.length / 4));
  }

  estimateMessagesTokens(messages = []) {
    return (Array.isArray(messages) ? messages : []).reduce((total, msg) => {
      let content = "";
      if (typeof msg?.content === "string") content = msg.content;
      else {
        try {
          content = JSON.stringify(msg?.content ?? "");
        } catch {
          content = String(msg?.content ?? "");
        }
      }
      return total + this.estimateTokenCount(`${msg?.role || "user"}: ${content}`);
    }, 0);
  }

  estimatePayloadTokens(...parts) {
    let total = 0;
    for (const part of parts) {
      if (part == null) continue;
      if (typeof part === "string") {
        total += this.estimateTokenCount(part);
        continue;
      }
      try {
        total += this.estimateTokenCount(JSON.stringify(part));
      } catch {
        total += this.estimateTokenCount(String(part));
      }
    }
    return total;
  }

  getContextWindow() {
    const value = Number(this.contextWindowRef?.value);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  shouldAutoCompact() {
    const limit = this.getContextWindow();
    if (!limit || this.autoCompactThreshold <= 0) return false;
    if (this.history.length <= this.autoCompactPreserveRecent) return false;
    const used = this.estimateMessagesTokens(this.history);
    return used >= limit * this.autoCompactThreshold;
  }

  async maybeAutoCompact({ preserveRecent = this.autoCompactPreserveRecent } = {}) {
    if (!this.shouldAutoCompact()) return null;
    const beforeTokens = this.estimateMessagesTokens(this.history);
    const limit = this.getContextWindow();
    const result = await this.compactHistory({ preserveRecent, reason: "auto" });
    if (result?.compacted) {
      this.onEvent?.({
        type: "context_compacted",
        reason: "auto",
        beforeMessages: result.beforeMessages,
        afterMessages: result.afterMessages,
        removedMessages: result.removedMessages,
        beforeTokens,
        afterTokens: this.estimateMessagesTokens(this.history),
        limit,
      });
    }
    return result;
  }

  async maybeAutoCompactForPayload({
    payloadTokens = 0,
    preserveRecent = this.autoCompactPreserveRecent,
  } = {}) {
    const limit = this.getContextWindow();
    const used = Math.max(0, Math.round(Number(payloadTokens) || 0));
    if (!limit || this.autoCompactThreshold <= 0) return null;
    if (this.history.length <= preserveRecent) return null;
    if (used < limit * this.autoCompactThreshold) return null;

    const result = await this.compactHistory({ preserveRecent, reason: "auto" });
    if (result?.compacted) {
      this.onEvent?.({
        type: "context_compacted",
        reason: "auto",
        beforeMessages: result.beforeMessages,
        afterMessages: result.afterMessages,
        removedMessages: result.removedMessages,
        beforeTokens: used,
        afterTokens: this.estimateMessagesTokens(this.history),
        limit,
      });
    }
    return result;
  }

  async compactHistory({ preserveRecent = 12, reason = "manual" } = {}) {
    const keep = Math.max(2, Number.parseInt(String(preserveRecent), 10) || 12);
    if (this.history.length <= keep) {
      return {
        compacted: false,
        beforeMessages: this.history.length,
        afterMessages: this.history.length,
        removedMessages: 0,
        summary: "Not enough context to compact.",
      };
    }

    const cutoff = Math.max(1, this.history.length - keep);
    const older = this.history.slice(0, cutoff);
    const recent = this.history.slice(cutoff);
    const olderText = formatHistory(older).slice(0, 24000);
    const fallbackSummary = this.buildFallbackCompactionSummary(older);

    const compactPrompt = [
      reason === "auto"
        ? "The conversation is near the model context limit. Summarize older history for future coding turns."
        : "Summarize this conversation history for future coding turns.",
      "Keep only concrete facts, decisions, constraints, and unresolved items.",
      "Output concise plain text bullets (max 8 lines).",
      "",
      olderText,
    ].join("\n");

    let summary = fallbackSummary;
    try {
      this.onEvent?.({
        type: "llm_request",
        stage: "planning",
        payload: `SYSTEM:\nContext compaction\n\nUSER:\n${compactPrompt}`,
      });
      const raw = await this.provider.complete({
        systemPrompt: "You compress coding-session memory into concise durable notes.",
        prompt: compactPrompt,
      });
      const text = String(raw || "").trim();
      if (text) summary = text.slice(0, 4000);
      this.emitLlmResponse("planning", raw);
    } catch {
      // fall back to deterministic summary without failing user command
    } finally {
      this.onEvent?.({ type: "thinking_done" });
    }

    const summaryMessage = [
      "[CONTEXT SUMMARY]",
      summary,
      "End of summary. Continue from this plus recent turns.",
    ].join("\n");

    const beforeMessages = this.history.length;
    this.history = [{ role: "assistant", content: summaryMessage }, ...recent];
    const afterMessages = this.history.length;
    return {
      compacted: true,
      beforeMessages,
      afterMessages,
      removedMessages: Math.max(0, beforeMessages - afterMessages),
      summary,
    };
  }

  buildFallbackCompactionSummary(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const lastUser = [...list]
      .reverse()
      .find((m) => String(m?.role || "").toLowerCase() === "user");
    const lastAssistant = [...list]
      .reverse()
      .find((m) => String(m?.role || "").toLowerCase() === "assistant");
    const userText = String(lastUser?.content || "").replace(/\s+/g, " ").trim();
    const assistantText = String(lastAssistant?.content || "").replace(/\s+/g, " ").trim();

    const lines = [
      `- Compacted ${list.length} prior messages.`,
      userText ? `- Last user request: ${userText.slice(0, 220)}` : "",
      assistantText ? `- Last assistant response: ${assistantText.slice(0, 220)}` : "",
      "- Keep project instructions and active skills unchanged.",
    ].filter(Boolean);
    return lines.join("\n");
  }

  getActiveSkills() {
    return Array.isArray(this.activeSkillsRef?.value) ? this.activeSkillsRef.value : [];
  }

  getActivePlugins() {
    return Array.isArray(this.activePluginsRef?.value) ? this.activePluginsRef.value : [];
  }

  async applyPreToolHooks({ tool, input = {}, callId = "", turnId = "" } = {}) {
    return await runPluginToolHooks({
      event: "PreToolUse",
      plugins: this.getActivePlugins(),
      tool,
      input,
      workspaceDir: this.workspaceDir,
      callId,
      turnId,
      model: this.provider?.model || "",
      onEvent: (event) => this.onEvent?.(event),
    });
  }

  async applyPostToolHooks({ tool, input = {}, result = null, error = null, callId = "", turnId = "" } = {}) {
    return await runPluginToolHooks({
      event: "PostToolUse",
      plugins: this.getActivePlugins(),
      tool,
      input,
      result,
      error,
      workspaceDir: this.workspaceDir,
      callId,
      turnId,
      model: this.provider?.model || "",
      onEvent: (event) => this.onEvent?.(event),
    });
  }

  getAgentDefinitions() {
    return Array.isArray(this.agentDefinitionsRef?.value) ? this.agentDefinitionsRef.value : [];
  }

  findAgentDefinition(name) {
    const target = String(name || "").trim();
    if (!target) return null;
    return this.getAgentDefinitions().find((definition) => definition?.name === target) || null;
  }

  buildSubagentPrompt({ task, context = "", mode = "analysis", definition = null } = {}) {
    const recentContext = formatHistory(this.history.slice(-8)).slice(0, 12000);
    const roleDefinition = definition
      ? [
          `You are \`${definition.name}\`, a PieCode project subagent.`,
          `Role definition from ${definition.path || ".AGENTS"}:`,
          String(definition.prompt || "").trim(),
        ].filter(Boolean).join("\n\n")
      : "You are a read-only subagent spawned by the main PieCode agent.";
    return [
      roleDefinition,
      "Investigate the assigned task and return concise findings for the main agent.",
      "You share the parent agent's durable MEMORY context and recent conversation context.",
      "Invariant safety constraints: do not edit files, do not write files, and do not run commands that modify repository or system state.",
      "Prefer read_file, read_files, list_files, glob_files, find_files, rg, git_status, and git_diff.",
      "If shell is needed, use only read-only inspection commands.",
      "",
      `Mode: ${String(mode || "analysis")}`,
      `Task:\n${String(task || "")}`,
      context ? `Additional context:\n${String(context)}` : "",
      this.getMemoryPrompt() ? `Durable memory:\n${this.getMemoryPrompt()}` : "",
      recentContext ? `Recent parent context:\n${recentContext}` : "",
      "",
      "Return findings with file paths, relevant symbols, and any uncertainty. Do not make changes.",
    ].filter(Boolean).join("\n\n");
  }

  async runCollaboration({ task, context = "" } = {}, options = {}) {
    const normalizedTask = String(task || "").trim();
    if (!normalizedTask) throw new Error("Missing required parameter: task");
    const sharedContext = [
      context ? `User/agent context:\n${String(context)}` : "",
      this.getMemoryPrompt() ? `Durable memory:\n${this.getMemoryPrompt()}` : "",
      `Recent conversation:\n${formatHistory(this.history.slice(-8)).slice(0, 12000)}`,
    ].filter(Boolean).join("\n\n");

    const design = await this.runSubagent({
      task: `Design agent: propose a concise implementation design for this task. Do not edit files.\n\n${normalizedTask}`,
      context: sharedContext,
      mode: "analysis",
      toolBudget: 3,
    }, options);
    const implementation = await this.runSubagent({
      task: `Implementation agent: inspect the design and identify exact files/changes to implement. Do not edit files.\n\nTask:\n${normalizedTask}`,
      context: `${sharedContext}\n\nDesign findings:\n${design}`,
      mode: "analysis",
      toolBudget: 3,
    }, options);
    const review = await this.runSubagent({
      task: `Review agent: review the proposed design and implementation plan for correctness, risks, and tests. Do not edit files.\n\nTask:\n${normalizedTask}`,
      context: `${sharedContext}\n\nDesign findings:\n${design}\n\nImplementation findings:\n${implementation}`,
      mode: "analysis",
      toolBudget: 3,
    }, options);

    return [
      "Collaboration result (shared context used):",
      "",
      "## Design agent",
      design,
      "",
      "## Implementation agent",
      implementation,
      "",
      "## Review agent",
      review,
    ].join("\n");
  }

  async runSubagent({ task, context = "", mode = "analysis", toolBudget = 3, role = "", agent = "", name = "" } = {}, options = {}) {
    const normalizedTask = String(task || "").trim();
    if (!normalizedTask) throw new Error("Missing required parameter: task");
    const requestedRole = String(role || agent || name || "").trim();
    const definition = requestedRole ? this.findAgentDefinition(requestedRole) : null;
    if (requestedRole && !definition) {
      throw new Error(`Unknown agent role: ${requestedRole}`);
    }
    const parentCanDelegate = Array.isArray(this.currentAgentDefinition?.tools) && this.currentAgentDefinition.tools.includes("subagent");
    if (this.subagentDepth >= 1 && (!parentCanDelegate || this.subagentDepth >= 2)) {
      return "Subagent skipped: nested subagents are disabled.";
    }
    const effectiveRole = definition?.name || requestedRole || "subagent";
    const definitionMeta = definition
      ? { name: definition.name, description: definition.description, color: definition.color, path: definition.path, model: definition.model }
      : null;

    const managed = this.agentManager.start({
      task: normalizedTask,
      mode,
      toolBudget: Math.min(Math.max(Number(toolBudget) || 3, 1), 6),
      role: effectiveRole,
    });
    const subagentId = managed.id;
    const childEvents = [];
    this.onEvent?.({
      type: "subagent_start",
      id: subagentId,
      role: effectiveRole,
      agentDefinition: definitionMeta,
      task: normalizedTask,
      mode,
      toolBudget: managed.toolBudget,
      state: managed,
    });
    const child = new Agent({
      provider: this.provider,
      workspaceDir: this.workspaceDir,
      autoApproveRef: { value: false },
      askApproval: this.askApproval,
      onEvent: (evt) => {
        if (evt?.type === "tool_use" || evt?.type === "tool_end") {
          childEvents.push(evt);
        }
        const state = this.agentManager.recordEvent(subagentId, evt);
        this.onEvent?.({ type: "subagent_event", id: subagentId, role: effectiveRole, agentDefinition: definitionMeta, task: normalizedTask, event: evt, state });
      },
      activeSkillsRef: this.activeSkillsRef,
      activePluginsRef: this.activePluginsRef,
      onTodoWrite: null,
      projectInstructionsRef: this.projectInstructionsRef,
      memoryRef: this.memoryRef,
      mcpHub: this.mcpHub,
      webSearch: this.webSearch,
      contextWindowRef: this.contextWindowRef,
      shellPermissionRef: this.shellPermissionRef,
      subagentDepth: this.subagentDepth + 1,
      agentManager: this.agentManager,
      agentDefinitionsRef: this.agentDefinitionsRef,
      currentAgentDefinition: definition,
    });

    const blockedReadOnlyTool = async () => "Tool error: subagent is read-only and cannot modify files or todos.";
    const blockedStrictReadOnlyTool = async () => "Tool error: this background task is strict read-only; use read/search/git_status/git_diff tools only.";
    child.tools.write_file = blockedReadOnlyTool;
    child.tools.edit_file = blockedReadOnlyTool;
    child.tools.apply_patch = blockedReadOnlyTool;
    child.tools.replace_in_files = blockedReadOnlyTool;
    child.tools.todo_write = blockedReadOnlyTool;
    child.tools.todowrite = blockedReadOnlyTool;
    child.tools.memory_write = blockedReadOnlyTool;
    child.tools.remember = blockedReadOnlyTool;
    child.tools.collaborate = blockedReadOnlyTool;
    const canDelegate = Boolean(definition?.tools?.includes("subagent") && this.subagentDepth < 1);
    if (!canDelegate) {
      child.tools.subagent = async () => "Tool error: nested subagents are disabled.";
    }
    if (definition && Array.isArray(definition.tools) && definition.tools.length > 0) {
      const allowed = new Set(definition.tools);
      for (const toolName of Object.keys(child.tools)) {
        if (allowed.has(toolName)) continue;
        child.tools[toolName] = async () => `Tool error: tool ${toolName} is not allowed for agent ${definition.name}.`;
      }
      child.tools.write_file = blockedReadOnlyTool;
      child.tools.edit_file = blockedReadOnlyTool;
      child.tools.apply_patch = blockedReadOnlyTool;
      child.tools.replace_in_files = blockedReadOnlyTool;
      child.tools.todo_write = blockedReadOnlyTool;
      child.tools.todowrite = blockedReadOnlyTool;
      child.tools.memory_write = blockedReadOnlyTool;
      child.tools.remember = blockedReadOnlyTool;
      child.tools.collaborate = blockedReadOnlyTool;
      if (!canDelegate) child.tools.subagent = async () => "Tool error: nested subagents are disabled.";
    }
    if (options?.strictReadOnly) {
      child.tools.shell = blockedStrictReadOnlyTool;
      child.tools.run_tests = blockedStrictReadOnlyTool;
      child.tools.mcp_call_tool = blockedStrictReadOnlyTool;
      child.tools.subagent = async () => "Tool error: nested subagents are disabled for background read-only tasks.";
      child.tools.collaborate = blockedStrictReadOnlyTool;
    }
    child.defaultToolBudget = Math.min(Math.max(Number(toolBudget) || 3, 1), 6);
    child.enablePlanner = false;
    child.taskPlanner = null;
    child.planFirstEnabled = false;

    const prompt = this.buildSubagentPrompt({ task: normalizedTask, context, mode, definition });
    try {
      const result = await child.runTurn(prompt, { signal: options?.signal || null });
      const toolSummary = summarizeToolUseNames(childEvents);
      const toolLine = toolSummary.length > 0 ? `\n\nSubagent tools used: ${toolSummary.join(", ")}` : "";
      this.onEvent?.({
        type: "subagent_end",
        id: subagentId,
        role: effectiveRole,
        agentDefinition: definitionMeta,
        task: normalizedTask,
        status: "done",
        tools: toolSummary,
        state: this.agentManager.finish(subagentId, { status: "done", result }),
      });
      return `Subagent result:\n${String(result || "").trim()}${toolLine}`;
    } catch (err) {
      const message = String(err?.message || err);
      this.onEvent?.({
        type: "subagent_end",
        id: subagentId,
        role: effectiveRole,
        agentDefinition: definitionMeta,
        task: normalizedTask,
        status: "error",
        error: message,
        state: this.agentManager.finish(subagentId, { status: "error", error: message }),
      });
      throw err;
    }
  }

  stableStringify(value) {
    const seen = new WeakSet();
    const normalize = (input) => {
      if (input === null || typeof input !== "object") return input;
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      if (Array.isArray(input)) return input.map((item) => normalize(item));
      const keys = Object.keys(input).sort();
      const out = {};
      for (const key of keys) out[key] = normalize(input[key]);
      return out;
    };
    try {
      return JSON.stringify(normalize(value));
    } catch {
      return String(value || "");
    }
  }

  getCachedSystemPrompt(options = {}) {
    const cacheKey = this.stableStringify(options);
    const cached = this.systemPromptCache.get(cacheKey);
    if (cached) return cached;

    const prompt = buildSystemPrompt(options);
    this.systemPromptCache.set(cacheKey, prompt);

    if (this.systemPromptCache.size > 8) {
      const oldestKey = this.systemPromptCache.keys().next().value;
      if (oldestKey) this.systemPromptCache.delete(oldestKey);
    }

    return prompt;
  }

  shouldPlanTask(message) {
    return shouldPlanTaskMessage(message, this.enablePlanner);
  }

  async runTurn(userMessage, options = {}) {
    this.activeAbortController = new AbortController();
    try {
      const engine = new TurnEngine(this, { userMessage, options });
      return await engine.run();
    } catch (err) {
      if (this.activeAbortController?.signal?.aborted || err?.code === "ABORT_ERR" || err?.name === "AbortError") {
        const abortErr = new Error("Task aborted by user.");
        abortErr.code = "TASK_ABORTED";
        throw abortErr;
      }
      throw err;
    } finally {
      this.activeAbortController = null;
    }
  }

}

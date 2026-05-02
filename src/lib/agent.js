import { createToolset } from "./tools.js";
import { buildSystemPrompt, formatHistory } from "./prompt.js";
import { TaskPlanner } from "./taskPlanner.js";
import { TurnEngine } from "./turnEngine.js";
import { shouldPlanTaskMessage } from "./plannedTaskRunner.js";

export class Agent {
  constructor({
    provider,
    workspaceDir,
    autoApproveRef,
    askApproval,
    onEvent,
    activeSkillsRef,
    onTodoWrite,
    projectInstructionsRef,
    mcpHub = null,
    webSearch = null,
  }) {
    this.provider = provider;
    this.workspaceDir = workspaceDir;
    this.autoApproveRef = autoApproveRef;
    this.askApproval = askApproval;
    this.onEvent = onEvent;
    this.onTodoWrite = onTodoWrite;
    this.activeSkillsRef = activeSkillsRef || { value: [] };
    this.projectInstructionsRef = projectInstructionsRef || { value: null };
    this.mcpHub = mcpHub && typeof mcpHub.hasServers === "function" ? mcpHub : null;
    this.webSearch = webSearch && typeof webSearch === "object" ? webSearch : null;
    this.history = [];
    this.rebuildToolset();
    this.enablePlanner = process.env.PIECODE_ENABLE_PLANNER === "1";
    this.taskPlanner = this.enablePlanner ? new TaskPlanner(this) : null;
    this.planFirstEnabled = process.env.PIECODE_PLAN_FIRST === "1";
    this.defaultToolBudget = Math.max(
      1,
      Math.min(12, Number.parseInt(process.env.PIECODE_TOOL_BUDGET || "6", 10) || 6)
    );
    this.activeAbortController = null;
    this.systemPromptCache = new Map();
  }

  rebuildToolset() {
    this.tools = createToolset({
      workspaceDir: this.workspaceDir,
      autoApproveRef: this.autoApproveRef,
      askApproval: this.askApproval,
      onToolStart: (tool, input) => this.onEvent?.({ type: "tool_start", tool, input }),
      onTodoWrite: this.onTodoWrite,
      mcpHub: this.mcpHub,
      webSearch: this.webSearch,
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

  async compactHistory({ preserveRecent = 12 } = {}) {
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
      "Summarize this conversation history for future coding turns.",
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

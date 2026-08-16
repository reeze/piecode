import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatHistory,
  parseModelAction,
  buildToolDefinitions,
  buildMessages,
  parseNativeResponse,
} from "./prompt.js";
import { classifyShellCommand } from "./tools.js";
import { PlannedTaskRunner, shouldPlanTaskMessage } from "./plannedTaskRunner.js";

export class TurnEngine {
  constructor(agent, { userMessage, options = {} }) {
    this.agent = agent;
    this.userMessage = userMessage;
    this.options = options;
    this.pendingToolActions = [];
    this.activePlan = null;
    this.turnPolicy = this.detectTurnPolicy(userMessage);
    this.planOnly = Boolean(options?.planOnly);
    this.attachments = Array.isArray(options?.attachments) ? options.attachments : [];
    this.mcpEnabled = Boolean(agent.mcpHub?.hasServers?.());
    this.mcpServerNames = this.mcpEnabled ? agent.mcpHub.getServerNames() : [];
    this.toolCalls = 0;
    this.budget = agent.defaultToolBudget;
    this.didReplan = false;
    this.lastToolSignature = "";
    this.lastToolResultDigest = "";
    this.repeatedNoProgressCount = 0;
    this.seenOutcomeCounts = new Map();
    this.todoNoopCount = 0;
    this.turnToolLimitReached = false;
    this.postLimitToolRetryCount = 0;
    this.commitFlowSignalCount = 0;
    this.lastCommitFlowSignal = "";
    this.commitFlowActive = false;
    this.commitAttemptedThisTurn = false;
    this.commitStatusCheckedThisTurn = false;
    this.commitFinalizeNudgeGiven = false;
    this.commitCommandRequired = false;
    this.consecutiveThoughtActions = 0;
  }

  detectTurnPolicy(userMessage) {
    const text = String(userMessage || "").trim();
    const lower = text.toLowerCase();

    const asksDiffSummary =
      (/\b(summarize|summarise|summerize|explain|describe|tell)\b/.test(lower) &&
        /\b(diff|changes|what happened|git diff)\b/.test(lower)) ||
      /\b(summarize|summarise|summerize)\b.*\b(diff|changes)\b/.test(lower) ||
      /\bwhat happened\b.*\b(diff|changes)\b/.test(lower);

    if (asksDiffSummary) {
      const asksCommitMessage =
        /\bcommit\s+message\b/.test(lower) ||
        /\bgenerate\b.*\bcommit\b/.test(lower) ||
        /\bwrite\b.*\bcommit\b/.test(lower);
      return {
        name: "repo_diff_summary",
        maxToolCalls: 2,
        allowedTools: ["shell"],
        forceFinalizeAfterTool: !asksCommitMessage,
        requireCommitMessage: asksCommitMessage,
        readOnlyShellOnly: true,
        disableTodos: true,
        note: asksCommitMessage
          ? "Use at most two shell checks (prefer git diff/git status once each), then provide a concise summary and a commit message."
          : "Use at most two shell checks (prefer git diff/git status once each), then provide a concise summary.",
      };
    }

    const asksGitStatus =
      /\bgit\s+status\b/.test(lower) ||
      /\b(check|show|get)\b.*\b(status)\b.*\b(repo|repository)\b/.test(lower) ||
      /\b(status)\b.*\b(repo|repository)\b/.test(lower);

    if (asksGitStatus) {
      return {
        name: "repo_status_check",
        maxToolCalls: 1,
        allowedTools: ["shell"],
        forceFinalizeAfterTool: true,
        disableTodos: true,
        note: "This is a single-check request; one shell command is sufficient.",
      };
    }

    return null;
  }

  formatToolResultForUser(action, result, toolError = null) {
    if (toolError) {
      return `Tool ${action?.tool || "unknown"} failed: ${toolError}`;
    }
    if (action?.tool === "shell") {
      const cmd = String(action?.input?.command || "").trim();
      const output = String(result || "");
      return cmd ? `Ran \`${cmd}\`.\n\n${output}` : output;
    }
    return String(result || "");
  }

  normalizeShellCommand(command) {
    let cmd = String(command || "").trim();
    if (!cmd) return cmd;
    cmd = cmd.replace(/\s+/g, " ");

    let previous = "";
    while (cmd !== previous) {
      previous = cmd;
      const match = cmd.match(/^cd\s+("[^"]+"|'[^']+'|[^\s&;|]+)\s*&&\s*(.+)$/i);
      if (!match) break;
      const rawPath = String(match[1] || "").replace(/^['"]|['"]$/g, "");
      const rest = String(match[2] || "").trim();
      if (!rest) break;
      if (rawPath === "." || rawPath === this.agent.workspaceDir) {
        cmd = rest;
      } else {
        break;
      }
    }

    return cmd.trim();
  }

  isRepoSummaryShellCommand(command) {
    const cmd = this.normalizeShellCommand(command).toLowerCase();
    if (!cmd) return false;
    if (/[;&]|&&|\|\||\|/.test(cmd)) return false;
    return (
      /^git\s+status(\s+.*)?$/.test(cmd) ||
      /^git\s+diff(\s+.*)?$/.test(cmd) ||
      /^git\s+show(\s+.*)?$/.test(cmd) ||
      /^git\s+log(\s+.*)?$/.test(cmd)
    );
  }

  isReadOnlyShellCommandForSummary(command, { originalCommand = "" } = {}) {
    const cmd = this.normalizeShellCommand(command);
    if (!cmd) return false;
    if (this.isRepoSummaryShellCommand(cmd)) return true;
    const original = this.normalizeShellCommand(originalCommand);
    if (!original || !this.isRepoSummaryShellCommand(original)) return false;
    return classifyShellCommand(cmd).level === "safe";
  }

  appendPreToolContexts(result, contexts = []) {
    let next = String(result ?? "");
    for (const context of Array.isArray(contexts) ? contexts : []) {
      const pluginName = typeof context === "string" ? "plugin" : String(context?.plugin || "plugin");
      const text = typeof context === "string" ? context.trim() : String(context?.text || "").trim();
      if (text) next = `${next}\n\n[HOOK CONTEXT from ${pluginName}]\n${text}`;
    }
    return next;
  }

  async prepareToolAction(action, { callId, turnId } = {}) {
    let preparedAction = action;
    let blocked = false;
    let blockReason = "";
    let contexts = [];
    if (typeof this.agent.applyPreToolHooks === "function") {
      const preHookResult = await this.agent.applyPreToolHooks({
        tool: preparedAction.tool,
        input: preparedAction.input || {},
        callId,
        turnId,
      });
      if (preHookResult?.input && typeof preHookResult.input === "object") {
        preparedAction = { ...preparedAction, input: preHookResult.input };
      }
      blocked = Boolean(preHookResult?.blocked);
      blockReason = String(preHookResult?.reason || "Tool call blocked by plugin hook.");
      contexts = Array.isArray(preHookResult?.additionalContextDetails)
        ? preHookResult.additionalContextDetails
        : Array.isArray(preHookResult?.additionalContext)
          ? preHookResult.additionalContext
          : [];
    }
    return { action: preparedAction, blocked, blockReason, contexts };
  }

  async applyPostToolHooks(action, { result, toolError = null, callId = "", turnId = "" } = {}) {
    let nextResult = result;
    let nextToolError = toolError;
    if (typeof this.agent.applyPostToolHooks === "function") {
      const postHookResult = await this.agent.applyPostToolHooks({
        tool: action.tool,
        input: action.input || {},
        result: nextResult,
        error: nextToolError,
        callId,
        turnId,
      });
      if (postHookResult && Object.prototype.hasOwnProperty.call(postHookResult, "result")) {
        nextResult = postHookResult.result;
      }
      if (postHookResult && Object.prototype.hasOwnProperty.call(postHookResult, "error")) {
        nextToolError = postHookResult.error;
      }
    }
    // Keep the durable ledger current from real tool outcomes, so long runs
    // retain their plan and evidence even after context compaction.
    try {
      this.agent.recordToolInLedger?.({
        tool: action.tool,
        input: action.input || {},
        result: nextResult,
        error: nextToolError,
      });
    } catch {
      // Ledger bookkeeping must never fail a tool call.
    }
    return { result: nextResult, toolError: nextToolError };
  }

  isAllowedShellCommandForCommitFlow(command) {
    const cmd = this.normalizeShellCommand(command).toLowerCase();
    if (!cmd) return false;
    if (/[;&]|&&|\|\||\|/.test(cmd)) return false;
    return /^git\s+(status|diff|add|commit)\b/.test(cmd);
  }

  buildToolSignature(action) {
    const input = action?.input && typeof action.input === "object" ? { ...action.input } : {};
    if (String(action?.tool || "") === "shell" && typeof input.command === "string") {
      input.command = this.normalizeShellCommand(input.command);
    }
    return `${action?.tool || ""}:${this.agent.stableStringify(input)}`;
  }

  extractFirstJsonObject(text) {
    const source = String(text || "");
    const start = source.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    return null;
  }

  resolveInsideWorkspace(candidatePath) {
    const resolved = path.resolve(this.agent.workspaceDir, candidatePath || ".");
    const rel = path.relative(this.agent.workspaceDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace: ${candidatePath}`);
    }
    return resolved;
  }

  shouldAllowWriteOverwrite(userMessage, action = null) {
    const userText = String(userMessage || "").toLowerCase();
    const reasonText = String(action?.reason || "").toLowerCase();
    const combined = `${userText}\n${reasonText}`;
    return (
      /\b(rewrite|overwrite|regenerate|recreate)\b/.test(combined) ||
      /\b(full|entire|whole)\s+file\b/.test(combined) ||
      /\bfrom\s+scratch\b/.test(combined)
    );
  }

  async validateWriteFileAction(userMessage, action = null) {
    if (String(action?.tool || "") !== "write_file") return null;
    const input = action?.input && typeof action.input === "object" ? action.input : {};
    const relPath = String(input.path || "").trim();
    if (!relPath) return null;
    if (Boolean(input.allow_overwrite)) return null;

    let absPath;
    try {
      absPath = this.resolveInsideWorkspace(relPath);
    } catch (error) {
      return String(error?.message || "Invalid write_file path");
    }

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      return null;
    }

    if (!stat?.isFile?.()) return null;
    if (this.shouldAllowWriteOverwrite(userMessage, action)) return null;

    return `write_file is blocked for existing file "${relPath}" to prevent accidental overwrite. Use read_file first, then edit_file with exact oldText/newText for targeted changes. If full rewrite is intended, explicitly request rewrite/overwrite and retry.`;
  }

  parsePlan(raw) {
    const source = String(raw || "").trim();
    const candidates = [source, this.extractFirstJsonObject(source)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        const steps = Array.isArray(parsed?.steps)
          ? parsed.steps.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
          : [];
        const summary = String(parsed?.summary || "").trim();
        const toolBudgetRaw = Number(parsed?.toolBudget);
        const toolBudget = Number.isFinite(toolBudgetRaw)
          ? Math.max(1, Math.min(12, Math.round(toolBudgetRaw)))
          : this.agent.defaultToolBudget;
        if (!summary && steps.length === 0) continue;
        return { summary: summary || "Execution plan", steps, toolBudget };
      } catch {
        // continue
      }
    }
    return null;
  }

  async synthesizeFinalFromEvidence({ requireCommitMessage = false, signal = null } = {}) {
    const evidence = [];
    for (let i = this.agent.history.length - 1; i >= 0; i -= 1) {
      const msg = this.agent.history[i];
      if (msg?.role !== "user") continue;
      let parsed = null;
      try {
        parsed = JSON.parse(String(msg.content || ""));
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.type !== "tool_result") continue;
      evidence.push({
        tool: String(parsed.tool || "unknown"),
        result: String(parsed.result || ""),
      });
      if (evidence.length >= 4) break;
    }
    const ordered = evidence.reverse();
    const evidenceText =
      ordered.length > 0
        ? ordered
            .map((e, idx) => `#${idx + 1} tool=${e.tool}\n${String(e.result || "").slice(0, 4000)}`)
            .join("\n\n")
        : "(no tool evidence available)";

    const finalizeSystemPrompt = [
      "You are finalizing a coding-agent response from already-collected tool outputs.",
      "Do not request any more tools.",
      "Return plain text only.",
    ].join("\n");
    const finalizePrompt = [
      `User request:\n${String(this.userMessage || "")}`,
      `Collected evidence:\n${evidenceText}`,
      requireCommitMessage
        ? "Provide: (1) concise summary of what changed, and (2) 'Suggested commit message:' line."
        : "Provide a concise final answer based on the evidence.",
    ].join("\n\n");

    this.agent.onEvent?.({ type: "model_call", provider: this.agent.provider.kind, model: this.agent.provider.model });
    this.agent.onEvent?.({
      type: "llm_request",
      stage: "turn_finalize",
      payload: `SYSTEM:\n${finalizeSystemPrompt}\n\nUSER:\n${finalizePrompt}`,
    });
    const raw = await this.agent.provider.complete({
      systemPrompt: finalizeSystemPrompt,
      prompt: finalizePrompt,
      signal,
    });
    this.agent.emitLlmResponse("turn_finalize", raw);
    const parsed = parseModelAction(String(raw || ""));
    if (parsed?.type === "final") return String(parsed.message || "").trim();
    if (parsed?.type === "thought") return String(parsed.content || "").trim();
    if (parsed?.type === "tool_use" || parsed?.type === "tool_uses") return "";
    return String(raw || "").trim();
  }

  hasToolEvidence() {
    return this.agent.history.some((msg) => {
      if (msg?.role !== "user") return false;
      try {
        const parsed = JSON.parse(String(msg.content || ""));
        return parsed?.type === "tool_result" || parsed?.type === "tool_results";
      } catch {
        return false;
      }
    });
  }

  async recoverEmptyFinal({ signal = null } = {}) {
    if (this.hasToolEvidence()) {
      const forced = await this.synthesizeFinalFromEvidence({
        requireCommitMessage: Boolean(this.turnPolicy?.requireCommitMessage),
        signal,
      }).catch(() => "");
      const body = String(forced || "").trim();
      if (body) return body;
      return "The model returned an empty final response after tool use. I collected evidence, but final synthesis also returned empty. Please retry or ask me to continue from the current session.";
    }
    return "The model returned an empty final response before producing an answer. Please retry the request.";
  }

  async finalizeAfterRepeatedToolResult({ signal = null, reason = "repeated_tool_result" } = {}) {
    if (this.commitFlowSignalCount <= 0) {
      const forced = await this.synthesizeFinalFromEvidence({
        requireCommitMessage: Boolean(this.turnPolicy?.requireCommitMessage),
        signal,
      }).catch(() => "");
      const body = String(forced || "").trim();
      if (body) return body;
    }
    const label = reason === "repeated_tool_call" ? "The model requested a repeated tool call" : "I’m repeating the same verified step result in this turn";
    return `${label}. I avoided another duplicate call and am finalizing from the evidence already collected. If you want me to try a different direction, tell me what to inspect next.`;
  }

  async planTurn(signal = null) {
    const planSystemPrompt = [
      "You are a planning assistant for a coding agent.",
      "Create a short plan before tool usage.",
      "Output strict JSON only:",
      '{"summary":"...","steps":["..."],"toolBudget":4}',
      "Constraints:",
      "- steps must be concise",
      "- choose minimal toolBudget (1-6 normally)",
      "- avoid shell unless essential",
    ].join("\n");

    const planPrompt = `User request:\n${this.userMessage}`;
    try {
      this.agent.onEvent?.({ type: "planning_call", provider: this.agent.provider.kind, model: this.agent.provider.model });
      this.agent.onEvent?.({
        type: "llm_request",
        stage: "planning",
        payload: `SYSTEM:\n${planSystemPrompt}\n\nUSER:\n${planPrompt}`,
      });
      const raw = await this.agent.provider.complete({ systemPrompt: planSystemPrompt, prompt: planPrompt, signal });
      this.agent.emitLlmResponse("planning", raw);
      const plan = this.parsePlan(raw);
      if (!plan) return null;
      this.agent.onEvent?.({ type: "plan", plan });
      return plan;
    } catch {
      return null;
    }
  }

  async replanTurn({ previousPlan, toolCalls, signal = null }) {
    const replanSystemPrompt = [
      "You are replanning a coding task after partial execution.",
      "Output strict JSON only:",
      '{"summary":"...","steps":["..."],"toolBudget":6}',
      "Requirements:",
      "- Keep plan concise and practical",
      "- Avoid redundant steps already likely completed",
      "- Increase toolBudget only as needed",
    ].join("\n");

    const previousSteps = Array.isArray(previousPlan?.steps) ? previousPlan.steps : [];
    const replanPrompt = [
      `User request:\n${this.userMessage}`,
      `Previous summary: ${previousPlan?.summary || "-"}`,
      `Previous steps:\n${previousSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "-"}`,
      `Tools already used in this turn: ${toolCalls}`,
      "Create an updated plan for the remaining work.",
    ].join("\n\n");

    try {
      this.agent.onEvent?.({ type: "replanning_call", provider: this.agent.provider.kind, model: this.agent.provider.model });
      this.agent.onEvent?.({
        type: "llm_request",
        stage: "replanning",
        payload: `SYSTEM:\n${replanSystemPrompt}\n\nUSER:\n${replanPrompt}`,
      });
      const raw = await this.agent.provider.complete({ systemPrompt: replanSystemPrompt, prompt: replanPrompt, signal });
      this.agent.emitLlmResponse("replanning", raw);
      const plan = this.parsePlan(raw);
      if (!plan) return null;
      this.agent.onEvent?.({ type: "replan", plan });
      return plan;
    } catch {
      return null;
    }
  }

  formatPlanModeFinalMessage(message) {
    const body = String(message || "").trim();
    const prefix = "Plan mode is ON. Only safe read-only tools were allowed. No files were changed.";
    if (!body) return prefix;
    if (/no files were changed|no file changes/i.test(body)) return body;
    return `${prefix}\n\n${body}`;
  }

  isParallelSafeTool(tool) {
    return new Set([
      "read_file",
      "read_files",
      "list_files",
      "glob_files",
      "find_files",
      "rg",
      "grep",
      "search_files",
      "web_search",
      "search_web",
      "git_status",
      "git_diff",
      "list_mcp_servers",
      "list_mcp_tools",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ]).has(String(tool || ""));
  }

  getCurrentTurnMaxToolCalls() {
    const commitFlowMode = !Number.isFinite(this.turnPolicy?.maxToolCalls) && this.commitFlowActive;
    return Number.isFinite(this.turnPolicy?.maxToolCalls) ? this.turnPolicy.maxToolCalls : commitFlowMode ? 4 : NaN;
  }

  canUseToolForTurn(action) {
    const todoDisabledForTurn =
      this.turnPolicy?.disableTodos && (action.tool === "todo_write" || action.tool === "todowrite");
    if (!this.agent.tools[action.tool]) {
      return { ok: false, message: `Unknown tool: ${action.tool}` };
    }
    if (
      Array.isArray(this.turnPolicy?.allowedTools) &&
      this.turnPolicy.allowedTools.length > 0 &&
      !this.turnPolicy.allowedTools.includes(action.tool) &&
      !todoDisabledForTurn
    ) {
      return {
        ok: false,
        message: `Tool ${action.tool} is not allowed for this turn policy. Use ${this.turnPolicy.allowedTools.join(", ")} or finalize.`,
      };
    }
    return { ok: true };
  }

  shouldRunParallelBatch(calls) {
    const batch = Array.isArray(calls) ? calls : [];
    return batch.length > 1 && batch.every((call) => call?.type === "tool_use" && this.isParallelSafeTool(call.tool));
  }

  async executeParallelToolBatch(calls, { useNativeTools, signal }) {
    const currentTurnMaxToolCalls = this.getCurrentTurnMaxToolCalls();
    if (this.turnToolLimitReached && Number.isFinite(currentTurnMaxToolCalls)) {
      this.postLimitToolRetryCount += 1;
      const forced = await this.synthesizeFinalFromEvidence({
        requireCommitMessage: Boolean(this.turnPolicy?.requireCommitMessage),
        signal,
      }).catch(() => "");
      return {
        done: true,
        message:
          String(forced || "").trim() ||
          "Tool budget reached for this turn. I collected enough evidence and stopped additional tools.",
      };
    }

    const remaining = Number.isFinite(currentTurnMaxToolCalls)
      ? Math.max(0, currentTurnMaxToolCalls - this.toolCalls)
      : calls.length;
    if (remaining <= 0) {
      this.turnToolLimitReached = true;
      return { done: false };
    }

    const batch = calls.slice(0, remaining);
    const rest = calls.slice(remaining);
    if (rest.length > 0) this.pendingToolActions.push(...rest);

    for (const action of batch) {
      const allowed = this.canUseToolForTurn(action);
      if (!allowed.ok) return { done: true, message: allowed.message };
    }

    const prepared = [];
    for (let index = 0; index < batch.length; index += 1) {
      const originalAction = batch[index];
      const callId = originalAction._callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const pre = await this.prepareToolAction(originalAction, {
        callId,
        turnId: String(this.toolCalls + index + 1),
      });
      prepared.push({
        action: pre.action,
        callId,
        blocked: pre.blocked,
        blockReason: pre.blockReason,
        contexts: pre.contexts,
        signature: this.buildToolSignature(pre.action),
      });
    }

    for (const item of prepared) {
      if (item.signature === this.lastToolSignature && this.repeatedNoProgressCount >= 2) {
        return {
          done: true,
          message: await this.finalizeAfterRepeatedToolResult({ signal, reason: "repeated_tool_call" }),
        };
      }
    }

    this.toolCalls += prepared.length;
    this.agent.onEvent?.({ type: "thinking_done" });
    this.agent.onEvent?.({
      type: "tool_batch_start",
      calls: prepared.map((item) => ({
        tool: item.action.tool,
        input: item.action.input,
        reason: item.action.reason || "",
        _callId: item.callId,
      })),
    });
    for (const item of prepared) {
      this.agent.onEvent?.({
        type: "tool_use",
        tool: item.action.tool,
        reason: item.action.reason || "",
        thought: item.action.thought || "",
        input: item.action.input,
        parallel: true,
        batchSize: prepared.length,
      });
    }

    const assistantCalls = prepared.map((item) => ({
      type: "tool_use",
      tool: item.action.tool,
      input: item.action.input,
      reason: item.action.reason || "",
      thought: item.action.thought || "",
      _callId: item.callId,
    }));
    this.agent.history.push({
      role: "assistant",
      content: JSON.stringify({ type: "tool_uses", calls: assistantCalls }),
      ...(useNativeTools
        ? {
            toolCalls: prepared.map((item) => ({
              id: item.callId,
              name: item.action.tool,
              input: item.action.input,
            })),
          }
        : {}),
    });

    const results = await Promise.all(
      prepared.map(async (item) => {
        let result;
        let toolError = null;
        try {
          if (item.blocked) {
            result = `Tool blocked by plugin hook: ${item.blockReason}`;
            toolError = item.blockReason;
          } else {
            const toolFn = this.agent.tools[item.action.tool];
            result = await toolFn(item.action.input || {}, { signal });
          }
        } catch (err) {
          if (err?.code === "ABORT_ERR" || err?.name === "AbortError") throw err;
          result = `Tool error: ${err.message}`;
          toolError = err.message;
        }
        result = this.appendPreToolContexts(result, item.contexts);
        const post = await this.applyPostToolHooks(item.action, {
          result,
          toolError,
          callId: item.callId,
          turnId: String(this.toolCalls),
        });
        return { ...item, result: post.result, toolError: post.toolError };
      })
    );
    this.agent.throwIfAborted(signal);

    for (const item of results) {
      this.agent.onEvent?.({
        type: "tool_end",
        tool: item.action.tool,
        result: String(item.result || ""),
        error: item.toolError,
        parallel: true,
        batchSize: prepared.length,
      });
    }

    this.agent.history.push({
      role: "user",
      content: JSON.stringify({
        type: "tool_results",
        results: results.map((item) => ({
          tool: item.action.tool,
          result: item.result,
          _callId: item.callId,
        })),
      }),
      ...(useNativeTools
        ? {
            toolResults: results.map((item) => ({
              toolCallId: item.callId,
              name: item.action.tool,
              result: item.result,
            })),
          }
        : {}),
    });

    for (const item of results) {
      const resultDigest = String(item.result || "").slice(0, 1000);
      const sameAsLastTurnStep = item.signature === this.lastToolSignature && resultDigest === this.lastToolResultDigest;
      if (sameAsLastTurnStep) this.repeatedNoProgressCount += 1;
      else this.repeatedNoProgressCount = 0;
      this.lastToolSignature = item.signature;
      this.lastToolResultDigest = resultDigest;

      const outcomeKey = `${item.signature}::${resultDigest}`;
      const seenCount = (this.seenOutcomeCounts.get(outcomeKey) || 0) + 1;
      this.seenOutcomeCounts.set(outcomeKey, seenCount);
      if (seenCount >= 2) {
        return {
          done: true,
          message: await this.finalizeAfterRepeatedToolResult({ signal, reason: "repeated_tool_result" }),
        };
      }
    }

    const effectiveTurnMaxToolCalls = this.getCurrentTurnMaxToolCalls();
    if (Number.isFinite(effectiveTurnMaxToolCalls) && this.toolCalls >= effectiveTurnMaxToolCalls && !this.turnPolicy?.forceFinalizeAfterTool) {
      this.turnToolLimitReached = true;
      this.postLimitToolRetryCount = 0;
      const commitRequirement = this.turnPolicy?.requireCommitMessage
        ? " Include a clear 'Suggested commit message' line."
        : "";
      this.agent.history.push({
        role: "assistant",
        content:
          `Tool collection complete for this turn. Based on collected outputs only, provide the final user-facing answer now.${commitRequirement}`,
      });
    }

    if (this.activePlan && this.toolCalls >= this.budget && !this.didReplan) {
      const newPlan = await this.replanTurn({
        previousPlan: this.activePlan,
        toolCalls: this.toolCalls,
        signal,
      });
      if (newPlan) {
        this.activePlan = newPlan;
        this.budget = Math.max(newPlan.toolBudget || this.budget, this.budget + 1);
        this.didReplan = true;
        this.agent.onEvent?.({
          type: "plan_progress",
          message: `Replanned after ${this.toolCalls} tools. New budget: ${this.budget}`,
        });
      }
    }

    return { done: false };
  }

  consumeSteersIntoHistory() {
    if (typeof this.agent.getSteers !== "function") return;
    const steers = this.agent.getSteers();
    if (!Array.isArray(steers) || steers.length === 0) return;
    const lines = steers
      .map((item, index) => `${index + 1}. ${String(item?.content || item || "").trim()}`)
      .filter((line) => !/^\d+\.\s*$/.test(line));
    if (lines.length === 0) return;
    const content = [
      "[USER STEERING UPDATE]",
      "The user sent this while the current task was running. Treat it as a live correction or constraint for the current task.",
      ...lines,
    ].join("\n");
    this.agent.history.push({ role: "user", content });
    this.agent.onEvent?.({ type: "steer_applied", count: lines.length, content: lines.join("\n") });
  }

  async nextModelAction(signal) {
    this.consumeSteersIntoHistory();
    let action;
    const useNativeTools = this.agent.provider.supportsNativeTools === true;

    if (this.pendingToolActions.length > 0) {
      action = this.pendingToolActions.shift();
      return { action, useNativeTools };
    }

    const nativeFormat = this.agent.provider.kind === "anthropic" ? "anthropic" : "openai";
    const systemPrompt = this.agent.getCachedSystemPrompt({
      workspaceDir: this.agent.workspaceDir,
      autoApprove: this.agent.autoApproveRef.value,
      activeSkills: this.agent.getActiveSkills(),
      activePlugins: this.agent.getActivePlugins(),
      activePlan: this.activePlan,
      projectInstructions: this.agent.projectInstructionsRef?.value?.content || null,
      memory: this.agent.getMemoryPrompt(),
      nativeTools: useNativeTools,
      turnPolicy: this.turnPolicy,
      mcpEnabled: this.mcpEnabled,
      mcpServerNames: this.mcpServerNames,
      agentDefinitions: this.agent.getAgentDefinitions(),
      taskLedger: this.agent.getLedgerPrompt?.() || null,
    });

    this.agent.onEvent?.({ type: "model_call", provider: this.agent.provider.kind, model: this.agent.provider.model });
    if (useNativeTools) {
      let messages = buildMessages({ history: this.agent.history, format: nativeFormat });
      const tools = buildToolDefinitions(nativeFormat, {
        mcpEnabled: this.mcpEnabled,
        mcpServerNames: this.mcpServerNames,
        agentDefinitions: this.agent.getAgentDefinitions(),
      });
      const payloadTokens = this.agent.estimatePayloadTokens(systemPrompt, messages, tools);
      const compacted = await this.agent.maybeAutoCompactForPayload({
        payloadTokens,
        preserveRecent: this.agent.autoCompactPreserveRecent,
      });
      if (compacted?.compacted) {
        messages = buildMessages({ history: this.agent.history, format: nativeFormat });
      }
      this.agent.onEvent?.({
        type: "llm_request",
        stage: "turn",
        payload: `SYSTEM:\n${systemPrompt}\n\nMESSAGES:\n${JSON.stringify(messages, null, 2)}\n\nTOOLS:\n${JSON.stringify(tools, null, 2)}`,
      });
      const response =
        typeof this.agent.provider.completeStream === "function"
          ? await this.agent.provider.completeStream({
              systemPrompt,
              messages,
              tools,
              signal,
              onDelta: (delta) =>
                this.agent.onEvent?.({ type: "llm_response_delta", stage: "turn", delta: String(delta || "") }),
            })
          : await this.agent.provider.complete({ systemPrompt, messages, tools, signal });
      this.agent.throwIfAborted(signal);
      this.agent.emitLlmResponse("turn", JSON.stringify(response));
      action = parseNativeResponse(response, nativeFormat);
    } else {
      let prompt = formatHistory(this.agent.history);
      const payloadTokens = this.agent.estimatePayloadTokens(systemPrompt, prompt);
      const compacted = await this.agent.maybeAutoCompactForPayload({
        payloadTokens,
        preserveRecent: this.agent.autoCompactPreserveRecent,
      });
      if (compacted?.compacted) {
        prompt = formatHistory(this.agent.history);
      }
      this.agent.onEvent?.({
        type: "llm_request",
        stage: "turn",
        payload: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${prompt}`,
      });
      const raw =
        typeof this.agent.provider.completeStream === "function"
          ? await this.agent.provider.completeStream({
              systemPrompt,
              prompt,
              signal,
              onDelta: (delta) =>
                this.agent.onEvent?.({ type: "llm_response_delta", stage: "turn", delta: String(delta || "") }),
            })
          : await this.agent.provider.complete({ systemPrompt, prompt, signal });
      this.agent.throwIfAborted(signal);
      this.agent.emitLlmResponse("turn", raw);
      action = parseModelAction(raw);
    }

    return { action, useNativeTools };
  }

  async run() {
    const signal = this.agent.activeAbortController.signal;
    this.agent.history.push({
      role: "user",
      content: this.userMessage,
      ...(this.attachments.length > 0 ? { attachments: this.attachments } : {}),
    });

    this.agent.throwIfAborted(signal);
    if (this.planOnly) {
      const prePlan = await this.planTurn(signal);
      if (prePlan) this.activePlan = prePlan;
      const planBudget = Number.isFinite(prePlan?.toolBudget)
        ? Math.max(1, Math.min(6, Math.round(prePlan.toolBudget)))
        : Math.max(1, Math.min(6, this.agent.defaultToolBudget));
      this.turnPolicy = {
        name: "plan_mode_safe_tools",
        maxToolCalls: planBudget,
        allowedTools: [
          "shell",
          "read_file",
          "read_files",
          "list_files",
          "glob_files",
          "find_files",
          "rg",
          "grep",
          "search_files",
          "web_search",
          "search_web",
          "git_status",
          "git_diff",
          ...(this.mcpEnabled
            ? [
                "list_mcp_servers",
                "list_mcp_tools",
                "list_mcp_resources",
                "list_mcp_resource_templates",
                "read_mcp_resource",
              ]
            : []),
        ],
        disableTodos: true,
        forceFinalizeAfterTool: false,
        note:
          "Plan mode is enabled. Use only safe read-only tools to gather context. Never modify files. Final answer must be a concrete plan and must state that no files were changed.",
      };
    }

    if (!this.planOnly && this.agent.planFirstEnabled && !this.agent.enablePlanner) {
      this.activePlan = await this.planTurn(signal);
    }

    if (!this.planOnly && shouldPlanTaskMessage(this.userMessage, this.agent.enablePlanner)) {
      this.agent.throwIfAborted(signal);
      const runner = new PlannedTaskRunner(this.agent, this.userMessage);
      return await runner.run();
    }

    const toolBudget = this.activePlan?.toolBudget ?? this.agent.defaultToolBudget;
    this.budget = toolBudget;

    while (true) {
      this.agent.throwIfAborted(signal);

      let { action, useNativeTools } = await this.nextModelAction(signal);

      if (action.type === "tool_uses") {
        this.consecutiveThoughtActions = 0;
        const calls = Array.isArray(action.calls) ? action.calls : [];
        if (calls.length === 0) {
          const msg = "Model returned an empty tool call batch. Please retry with a final answer or a valid tool call.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
        if (this.shouldRunParallelBatch(calls)) {
          const batchResult = await this.executeParallelToolBatch(calls, { useNativeTools, signal });
          if (batchResult?.done) {
            this.agent.history.push({ role: "assistant", content: batchResult.message });
            return batchResult.message;
          }
          continue;
        }
        const [first, ...rest] = calls;
        if (rest.length > 0) this.pendingToolActions.push(...rest);
        action = first;
      }

      if (action.type === "final") {
        this.consecutiveThoughtActions = 0;
        this.agent.onEvent?.({ type: "thinking_done" });
        const rawFinalMessage = String(action.message || "").trim();
        const recoveredMessage = rawFinalMessage ? rawFinalMessage : await this.recoverEmptyFinal({ signal });
        const finalMessage = this.planOnly ? this.formatPlanModeFinalMessage(recoveredMessage) : recoveredMessage;
        this.agent.history.push({ role: "assistant", content: finalMessage });
        return finalMessage;
      }

      if (action.type === "thought") {
        this.agent.onEvent?.({ type: "thinking_done" });
        this.agent.onEvent?.({ type: "thought", content: action.content });
        this.agent.history.push({
          role: "assistant",
          content: JSON.stringify({ type: "thought", content: action.content }),
        });
        this.consecutiveThoughtActions += 1;
        if (this.consecutiveThoughtActions >= 2) {
          const msg = String(action.content || "").trim()
            ? `${String(action.content || "").trim()}\n\nThe model returned progress updates without taking an action or finalizing, so I stopped to avoid waiting indefinitely. Please ask me to continue if you want another attempt.`
            : "The model returned progress updates without taking an action or finalizing, so I stopped to avoid waiting indefinitely. Please ask me to continue if you want another attempt.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
        this.agent.history.push({
          role: "user",
          content: "Progress update received. Continue now with either a tool call or the final answer; do not send another progress-only thought.",
        });
        continue;
      }

      this.consecutiveThoughtActions = 0;

      const currentTurnMaxToolCalls = this.getCurrentTurnMaxToolCalls();

      if (action.type === "tool_use" && this.turnToolLimitReached && Number.isFinite(currentTurnMaxToolCalls)) {
        this.postLimitToolRetryCount += 1;
        const forced = await this.synthesizeFinalFromEvidence({
          requireCommitMessage: Boolean(this.turnPolicy?.requireCommitMessage),
          signal,
        }).catch(() => "");
        const msg =
          String(forced || "").trim() ||
          "Tool budget reached for this turn. I collected enough evidence and stopped additional tools.";
        this.agent.history.push({ role: "assistant", content: msg });
        return msg;
      }

      const todoDisabledForTurn = this.turnPolicy?.disableTodos && (action.tool === "todo_write" || action.tool === "todowrite");
      const todoDisabledResult =
        "Tool error: todo_write is disabled for this turn policy. Continue with concrete actions or finalize.";
      const allowedTool = this.canUseToolForTurn(action);
      const toolFn = this.agent.tools[action.tool];
      if (!allowedTool.ok) {
        const msg = allowedTool.message;
        this.agent.history.push({ role: "assistant", content: msg });
        return msg;
      }

      const callId = action._callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const originalAction = action;
      const preTool = await this.prepareToolAction(action, {
        callId,
        turnId: String(this.toolCalls + 1),
      });
      action = preTool.action;
      const preToolBlocked = preTool.blocked;
      const preToolBlockReason = preTool.blockReason;
      const preToolContexts = preTool.contexts;

      if (!preToolBlocked && action.tool === "shell" && this.turnPolicy?.readOnlyShellOnly) {
        const cmd = String(action?.input?.command || "");
        const originalCmd = String(originalAction?.input?.command || "");
        if (!this.isReadOnlyShellCommandForSummary(cmd, { originalCommand: originalCmd })) {
          const forced = await this.synthesizeFinalFromEvidence({
            requireCommitMessage: Boolean(this.turnPolicy?.requireCommitMessage),
            signal,
          }).catch(() => "");
          const msg =
            String(forced || "").trim() ||
            "Blocked non-read-only shell command for this summary request. I finalized from collected evidence instead.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
      }
      if (!preToolBlocked && this.planOnly && action.tool === "shell") {
        const cmd = String(action?.input?.command || "");
        const classification = classifyShellCommand(cmd);
        if (classification.level !== "safe") {
          const msg = `Plan mode only allows safe shell commands. Blocked shell command (${classification.reason}).`;
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
      }

      let normalizedShellCmd = "";
      let shellIsCommitFlowCommand = false;
      let shellIsCommitCommand = false;
      let shellIsStatusCommand = false;
      if (!preToolBlocked && action.tool === "shell") {
        const cmd = String(action?.input?.command || "");
        normalizedShellCmd = this.normalizeShellCommand(cmd).toLowerCase();
        shellIsCommitFlowCommand = this.isAllowedShellCommandForCommitFlow(cmd);
        shellIsCommitCommand = /^git\s+commit\b/.test(normalizedShellCmd);
        shellIsStatusCommand = /^git\s+status\b/.test(normalizedShellCmd);

        if (!Number.isFinite(this.turnPolicy?.maxToolCalls) && shellIsCommitFlowCommand) {
          const hasPriorCommitSignal = this.commitFlowSignalCount >= 1;
          const isDifferentCommitSignal = Boolean(this.lastCommitFlowSignal && this.lastCommitFlowSignal !== normalizedShellCmd);
          const isStrongCommitSignal = /^git\s+(add|commit)\b/.test(normalizedShellCmd);
          if (isStrongCommitSignal || (hasPriorCommitSignal && (isDifferentCommitSignal || this.pendingToolActions.length > 0))) {
            this.commitFlowActive = true;
          }
          this.commitFlowSignalCount += 1;
          this.lastCommitFlowSignal = normalizedShellCmd;
        }

        const commitFlowMode = !Number.isFinite(this.turnPolicy?.maxToolCalls) && this.commitFlowActive;
        if (commitFlowMode && !shellIsCommitFlowCommand) {
          const msg =
            "Commit flow is active for this turn. Only git status/diff/add/commit commands are allowed before finalizing.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
        if (commitFlowMode && this.commitCommandRequired && !shellIsCommitCommand) {
          const forced = await this.synthesizeFinalFromEvidence({
            requireCommitMessage: false,
            signal,
          }).catch(() => "");
          const msg =
            String(forced || "").trim() ||
            "I collected enough prep context for this commit flow. The next step must be a git commit command; I stopped to avoid extra prep loops.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
        if (commitFlowMode && shellIsStatusCommand && this.commitStatusCheckedThisTurn) {
          if (this.pendingToolActions.length > 0) {
            this.agent.history.push({
              role: "assistant",
              content:
                "git status already checked in this turn. Skipping duplicate status and continuing with remaining actions.",
            });
            continue;
          }
          const forced = await this.synthesizeFinalFromEvidence({
            requireCommitMessage: false,
            signal,
          }).catch(() => "");
          const msg =
            String(forced || "").trim() ||
            "I already checked git status in this turn. Finalizing now to avoid repeating commit-prep checks.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
      }

      const toolSignature = this.buildToolSignature(action);
      if (toolSignature === this.lastToolSignature && this.repeatedNoProgressCount >= 2) {
        const msg = await this.finalizeAfterRepeatedToolResult({ signal, reason: "repeated_tool_call" });
        this.agent.history.push({ role: "assistant", content: msg });
        return msg;
      }

      this.toolCalls += 1;
      const toolCallMessage = {
        type: "tool_use",
        tool: action.tool,
        input: action.input,
        reason: action.reason || "",
        thought: action.thought || "",
        _callId: callId,
      };

      this.agent.onEvent?.({ type: "thinking_done" });
      this.agent.onEvent?.({
        type: "tool_use",
        tool: action.tool,
        reason: action.reason || "",
        thought: action.thought || "",
        input: action.input,
      });

      this.agent.history.push({
        role: "assistant",
        content: JSON.stringify(toolCallMessage),
        ...(useNativeTools ? { toolCall: { id: callId, name: action.tool, input: action.input } } : {}),
      });

      let result;
      let toolError = null;
      try {
        if (preToolBlocked) {
          result = `Tool blocked by plugin hook: ${preToolBlockReason}`;
          toolError = preToolBlockReason;
        } else if (todoDisabledForTurn) {
          result = todoDisabledResult;
          toolError = "todo_write disabled by turn policy";
        } else {
          const writeFileGuardError = await this.validateWriteFileAction(this.userMessage, action);
          if (writeFileGuardError) throw new Error(writeFileGuardError);
          result = await toolFn(action.input || {}, { signal });
        }
      } catch (err) {
        if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
          const abortErr = new Error("Task aborted by user.");
          abortErr.code = "TASK_ABORTED";
          throw abortErr;
        }
        result = `Tool error: ${err.message}`;
        toolError = err.message;
      }
      this.agent.throwIfAborted(signal);

      result = this.appendPreToolContexts(result, preToolContexts);
      const postTool = await this.applyPostToolHooks(action, {
        result,
        toolError,
        callId,
        turnId: String(this.toolCalls),
      });
      result = postTool.result;
      toolError = postTool.toolError;

      const resultDigest = String(result || "").slice(0, 1000);
      this.agent.onEvent?.({
        type: "tool_end",
        tool: action.tool,
        result: String(result || ""),
        error: toolError,
      });

      this.agent.history.push({
        role: "user",
        content: JSON.stringify({
          type: "tool_result",
          tool: action.tool,
          result,
          _callId: callId,
        }),
        ...(useNativeTools ? { toolResult: { toolCallId: callId, name: action.tool, result } } : {}),
      });

      const sameAsLastTurnStep = toolSignature === this.lastToolSignature && resultDigest === this.lastToolResultDigest;
      if (sameAsLastTurnStep) this.repeatedNoProgressCount += 1;
      else this.repeatedNoProgressCount = 0;
      this.lastToolSignature = toolSignature;
      this.lastToolResultDigest = resultDigest;

      const outcomeKey = `${toolSignature}::${resultDigest}`;
      const seenCount = (this.seenOutcomeCounts.get(outcomeKey) || 0) + 1;
      this.seenOutcomeCounts.set(outcomeKey, seenCount);
      if (seenCount >= 2) {
        const msg = await this.finalizeAfterRepeatedToolResult({ signal, reason: "repeated_tool_result" });
        this.agent.history.push({ role: "assistant", content: msg });
        return msg;
      }

      if ((action.tool === "todo_write" || action.tool === "todowrite") && /^No-op:/i.test(String(result || ""))) {
        this.todoNoopCount += 1;
        if (this.todoNoopCount >= 1) {
          const msg =
            "Todo list is already up to date. I won’t keep calling todo_write. I can continue with concrete actions if you specify the next step.";
          this.agent.history.push({ role: "assistant", content: msg });
          return msg;
        }
      }

      if (action.tool === "shell") {
        if (!Number.isFinite(this.turnPolicy?.maxToolCalls) && shellIsCommitFlowCommand) {
          if (shellIsStatusCommand) {
            this.commitStatusCheckedThisTurn = true;
          }
          const outputLower = String(result || "").toLowerCase();
          if (this.commitFlowActive && (outputLower.includes("nothing to commit") || outputLower.includes("working tree clean"))) {
            const msg =
              "Repository is already clean. There is nothing new to commit. If you want another commit, make changes first.";
            this.agent.history.push({ role: "assistant", content: msg });
            return msg;
          }
        }

        if (shellIsCommitCommand) {
          this.commitAttemptedThisTurn = true;
          const message = this.formatToolResultForUser(action, result, toolError);
          this.agent.history.push({ role: "assistant", content: message });
          return message;
        }
      }

      const commitFlowMode = !Number.isFinite(this.turnPolicy?.maxToolCalls) && this.commitFlowActive;
      const effectiveTurnMaxToolCalls = Number.isFinite(this.turnPolicy?.maxToolCalls)
        ? this.turnPolicy.maxToolCalls
        : commitFlowMode
          ? 4
          : NaN;

      if (Number.isFinite(effectiveTurnMaxToolCalls) && this.toolCalls >= effectiveTurnMaxToolCalls && !this.turnPolicy?.forceFinalizeAfterTool) {
        if (commitFlowMode && !this.commitAttemptedThisTurn && !this.commitFinalizeNudgeGiven) {
          this.commitFinalizeNudgeGiven = true;
          this.commitCommandRequired = true;
          this.agent.history.push({
            role: "assistant",
            content:
              "Commit flow is still pending. Do not run more prep checks. Next tool call must be `git commit ...` (or finalize with why commit cannot proceed).",
          });
          continue;
        }
        this.turnToolLimitReached = true;
        this.postLimitToolRetryCount = 0;
        const commitRequirement = this.turnPolicy?.requireCommitMessage
          ? " Include a clear 'Suggested commit message' line."
          : "";
        this.agent.history.push({
          role: "assistant",
          content:
            `Tool collection complete for this turn. Based on collected outputs only, provide the final user-facing answer now.${commitRequirement}`,
        });
        continue;
      }

      if (this.turnPolicy?.forceFinalizeAfterTool && Number.isFinite(effectiveTurnMaxToolCalls) && this.toolCalls >= effectiveTurnMaxToolCalls) {
        const message = this.formatToolResultForUser(action, result, toolError);
        this.agent.history.push({ role: "assistant", content: message });
        return message;
      }

      if (this.activePlan && this.toolCalls >= this.budget && !this.didReplan) {
        const newPlan = await this.replanTurn({
          previousPlan: this.activePlan,
          toolCalls: this.toolCalls,
          signal,
        });
        if (newPlan) {
          this.activePlan = newPlan;
          this.budget = Math.max(newPlan.toolBudget || this.budget, this.budget + 1);
          this.didReplan = true;
          this.agent.onEvent?.({
            type: "plan_progress",
            message: `Replanned after ${this.toolCalls} tools. New budget: ${this.budget}`,
          });
        }
      }
    }
  }
}

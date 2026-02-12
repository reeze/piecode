import { createToolset } from "./tools.js";
import { buildSystemPrompt, formatHistory, parseModelAction, buildToolDefinitions, buildMessages, parseNativeResponse } from "./prompt.js";
import { TaskPlanner, TaskExecutor } from "./taskPlanner.js";

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
  }) {
    this.provider = provider;
    this.workspaceDir = workspaceDir;
    this.autoApproveRef = autoApproveRef;
    this.askApproval = askApproval;
    this.onEvent = onEvent;
    this.activeSkillsRef = activeSkillsRef || { value: [] };
    this.projectInstructionsRef = projectInstructionsRef || { value: null };
    this.history = [];
    this.tools = createToolset({
      workspaceDir,
      autoApproveRef,
      askApproval,
      onToolStart: (tool, input) => this.onEvent?.({ type: "tool_start", tool, input }),
      onTodoWrite,
    });
    this.enablePlanner = process.env.PIECODE_ENABLE_PLANNER === "1";
    this.taskPlanner = this.enablePlanner ? new TaskPlanner(this) : null;
    this.planFirstEnabled = process.env.PIECODE_PLAN_FIRST === "1";
    this.defaultToolBudget = Math.max(
      1,
      Math.min(12, Number.parseInt(process.env.PIECODE_TOOL_BUDGET || "6", 10) || 6)
    );
    this.iterationCheckpoint = Math.max(
      5,
      Number.parseInt(process.env.PIECODE_ITERATION_CHECKPOINT || "20", 10) || 20
    );
    this.activeAbortController = null;
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
      this.onEvent?.({ type: "llm_response", stage: "planning", payload: String(raw || "") });
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

    // Normalize common "cd <workspace> && <cmd>" wrappers that models often emit.
    let previous = "";
    while (cmd !== previous) {
      previous = cmd;
      const match = cmd.match(/^cd\s+("[^"]+"|'[^']+'|[^\s&;|]+)\s*&&\s*(.+)$/i);
      if (!match) break;
      const rawPath = String(match[1] || "").replace(/^['"]|['"]$/g, "");
      const rest = String(match[2] || "").trim();
      if (!rest) break;
      if (rawPath === "." || rawPath === this.workspaceDir) {
        cmd = rest;
      } else {
        break;
      }
    }

    return cmd.trim();
  }

  buildToolSignature(action) {
    const input = action?.input && typeof action.input === "object" ? { ...action.input } : {};
    if (String(action?.tool || "") === "shell" && typeof input.command === "string") {
      input.command = this.normalizeShellCommand(input.command);
    }
    return `${action?.tool || ""}:${this.stableStringify(input)}`;
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
          : this.defaultToolBudget;
        if (!summary && steps.length === 0) continue;
        return { summary: summary || "Execution plan", steps, toolBudget };
      } catch {
        // continue
      }
    }
    return null;
  }

  async synthesizeFinalFromEvidence({
    userMessage,
    requireCommitMessage = false,
    signal = null,
  } = {}) {
    const evidence = [];
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const msg = this.history[i];
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
      `User request:\n${String(userMessage || "")}`,
      `Collected evidence:\n${evidenceText}`,
      requireCommitMessage
        ? "Provide: (1) concise summary of what changed, and (2) 'Suggested commit message:' line."
        : "Provide a concise final answer based on the evidence.",
    ].join("\n\n");

    this.onEvent?.({ type: "model_call", provider: this.provider.kind, model: this.provider.model });
    this.onEvent?.({
      type: "llm_request",
      stage: "turn_finalize",
      payload: `SYSTEM:\n${finalizeSystemPrompt}\n\nUSER:\n${finalizePrompt}`,
    });
    const raw = await this.provider.complete({
      systemPrompt: finalizeSystemPrompt,
      prompt: finalizePrompt,
      signal,
    });
    this.onEvent?.({ type: "llm_response", stage: "turn_finalize", payload: String(raw || "") });
    const parsed = parseModelAction(String(raw || ""));
    if (parsed?.type === "final" && parsed.message) return String(parsed.message);
    if (parsed?.type === "thought" && parsed.content) return String(parsed.content);
    return String(raw || "").trim();
  }

  async planTurn(userMessage, signal = null) {
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

    const planPrompt = `User request:\n${userMessage}`;
    try {
      this.onEvent?.({ type: "planning_call", provider: this.provider.kind, model: this.provider.model });
      this.onEvent?.({
        type: "llm_request",
        stage: "planning",
        payload: `SYSTEM:\n${planSystemPrompt}\n\nUSER:\n${planPrompt}`,
      });
      const raw = await this.provider.complete({ systemPrompt: planSystemPrompt, prompt: planPrompt, signal });
      this.onEvent?.({ type: "llm_response", stage: "planning", payload: String(raw || "") });
      const plan = this.parsePlan(raw);
      if (!plan) return null;
      this.onEvent?.({ type: "plan", plan });
      return plan;
    } catch {
      return null;
    }
  }

  async replanTurn({ userMessage, previousPlan, toolCalls, signal = null }) {
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
      `User request:\n${userMessage}`,
      `Previous summary: ${previousPlan?.summary || "-"}`,
      `Previous steps:\n${previousSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "-"}`,
      `Tools already used in this turn: ${toolCalls}`,
      "Create an updated plan for the remaining work.",
    ].join("\n\n");

    try {
      this.onEvent?.({ type: "replanning_call", provider: this.provider.kind, model: this.provider.model });
      this.onEvent?.({
        type: "llm_request",
        stage: "replanning",
        payload: `SYSTEM:\n${replanSystemPrompt}\n\nUSER:\n${replanPrompt}`,
      });
      const raw = await this.provider.complete({ systemPrompt: replanSystemPrompt, prompt: replanPrompt, signal });
      this.onEvent?.({ type: "llm_response", stage: "replanning", payload: String(raw || "") });
      const plan = this.parsePlan(raw);
      if (!plan) return null;
      this.onEvent?.({ type: "replan", plan });
      return plan;
    } catch {
      return null;
    }
  }

  async runTurn(userMessage) {
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;
    this.history.push({ role: "user", content: userMessage });
    let activePlan = null;
    const turnPolicy = this.detectTurnPolicy(userMessage);

    try {
      this.throwIfAborted(signal);
      if (this.planFirstEnabled && !this.enablePlanner) {
        activePlan = await this.planTurn(userMessage, signal);
      }

      // 首先检查是否需要任务规划
      const shouldPlan = this.shouldPlanTask(userMessage);
      if (shouldPlan) {
        this.throwIfAborted(signal);
        return await this.runPlannedTask(userMessage);
      }

      const toolBudget = activePlan?.toolBudget ?? this.defaultToolBudget;
      let toolCalls = 0;
      let budget = toolBudget;
      let didReplan = false;
      let lastToolSignature = "";
      let lastToolResultDigest = "";
      let repeatedNoProgressCount = 0;
      const seenOutcomeCounts = new Map();
      let todoNoopCount = 0;
      let turnToolLimitReached = false;
      let postLimitToolRetryCount = 0;
      const pendingToolActions = [];

      // 对于简单任务，使用原有的循环方式
      let i = 0;
      while (true) {
        this.throwIfAborted(signal);
        i += 1;
        if (i % this.iterationCheckpoint === 0) {
          const shouldContinue = await this.askApproval(
            `The agent has run ${i} model iterations in this turn. Continue? [Y/n]: `
          );
          if (!shouldContinue) {
            const msg = `Stopped after ${i} iterations by user choice.`;
            this.history.push({ role: "assistant", content: msg });
            return msg;
          }
        }

        let action;
        const useNativeTools = this.provider.supportsNativeTools === true;
        if (pendingToolActions.length > 0) {
          action = pendingToolActions.shift();
        } else {
          const nativeFormat = this.provider.kind === "anthropic" ? "anthropic" : "openai";
          const systemPrompt = buildSystemPrompt({
            workspaceDir: this.workspaceDir,
            autoApprove: this.autoApproveRef.value,
            activeSkills: this.getActiveSkills(),
            activePlan,
            projectInstructions: this.projectInstructionsRef?.value?.content || null,
            nativeTools: useNativeTools,
            turnPolicy,
          });

          this.onEvent?.({ type: "model_call", provider: this.provider.kind, model: this.provider.model });
          if (useNativeTools) {
            const messages = buildMessages({ history: this.history });
            const tools = buildToolDefinitions(nativeFormat);
            this.onEvent?.({
              type: "llm_request",
              stage: "turn",
              payload: `SYSTEM:\n${systemPrompt}\n\nMESSAGES: ${messages.length} entries\nTOOLS: ${tools.length} definitions`,
            });
            const response =
              typeof this.provider.completeStream === "function"
                ? await this.provider.completeStream({
                    systemPrompt,
                    messages,
                    tools,
                    signal,
                    onDelta: (delta) =>
                      this.onEvent?.({ type: "llm_response_delta", stage: "turn", delta: String(delta || "") }),
                  })
                : await this.provider.complete({ systemPrompt, messages, tools, signal });
            this.throwIfAborted(signal);
            this.onEvent?.({ type: "llm_response", stage: "turn", payload: String(JSON.stringify(response) || "") });
            action = parseNativeResponse(response, nativeFormat);
          } else {
            const prompt = formatHistory(this.history);
            this.onEvent?.({
              type: "llm_request",
              stage: "turn",
              payload: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${prompt}`,
            });
            const raw =
              typeof this.provider.completeStream === "function"
                ? await this.provider.completeStream({
                    systemPrompt,
                    prompt,
                    signal,
                    onDelta: (delta) =>
                      this.onEvent?.({ type: "llm_response_delta", stage: "turn", delta: String(delta || "") }),
                  })
                : await this.provider.complete({ systemPrompt, prompt, signal });
            this.throwIfAborted(signal);
            this.onEvent?.({ type: "llm_response", stage: "turn", payload: String(raw || "") });
            action = parseModelAction(raw);
          }
        }

        if (action.type === "tool_uses") {
          const calls = Array.isArray(action.calls) ? action.calls : [];
          if (calls.length === 0) {
            const msg = "Model returned an empty tool call batch. Please retry with a final answer or a valid tool call.";
            this.history.push({ role: "assistant", content: msg });
            return msg;
          }
          const [first, ...rest] = calls;
          if (rest.length > 0) pendingToolActions.push(...rest);
          action = first;
        }

        if (action.type === "final") {
          this.onEvent?.({ type: "thinking_done" });
          this.history.push({ role: "assistant", content: action.message });
          return action.message;
        }

        if (action.type === "thought") {
          this.onEvent?.({ type: "thinking_done" });
          this.onEvent?.({ type: "thought", content: action.content });
          this.history.push({
            role: "assistant",
            content: JSON.stringify({ type: "thought", content: action.content })
          });
          continue;
        }

        if (
          action.type === "tool_use" &&
          turnToolLimitReached &&
          Number.isFinite(turnPolicy?.maxToolCalls)
        ) {
          postLimitToolRetryCount += 1;
          const forced = await this.synthesizeFinalFromEvidence({
            userMessage,
            requireCommitMessage: Boolean(turnPolicy?.requireCommitMessage),
            signal,
          }).catch(() => "");
          const msg =
            String(forced || "").trim() ||
            "Tool budget reached for this turn. I collected enough evidence and stopped additional tools.";
          this.history.push({ role: "assistant", content: msg });
          return msg;
        }

        const toolFn = this.tools[action.tool];
        if (!toolFn) {
          const msg = `Unknown tool: ${action.tool}`;
          this.history.push({ role: "assistant", content: msg });
          return msg;
        }

        if (turnPolicy?.disableTodos && (action.tool === "todo_write" || action.tool === "todowrite")) {
          const msg = "This request does not need todo tracking. Provide the final answer directly.";
          this.history.push({ role: "assistant", content: msg });
          return msg;
        }
        if (Array.isArray(turnPolicy?.allowedTools) && turnPolicy.allowedTools.length > 0) {
          if (!turnPolicy.allowedTools.includes(action.tool)) {
            const msg = `Tool ${action.tool} is not allowed for this turn policy. Use ${turnPolicy.allowedTools.join(", ")} or finalize.`;
            this.history.push({ role: "assistant", content: msg });
            return msg;
          }
        }

        const toolSignature = this.buildToolSignature(action);
        if (toolSignature === lastToolSignature && repeatedNoProgressCount >= 2) {
          const msg =
            "I’m repeating the same tool call without progress. Stopping to avoid a loop. Please clarify the next step.";
          this.history.push({ role: "assistant", content: msg });
          return msg;
        }

        toolCalls += 1;
        const callId = action._callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        const toolCallMessage = {
          type: "tool_use",
          tool: action.tool,
          input: action.input,
          reason: action.reason || "",
          _callId: callId,
        };

        this.onEvent?.({ type: "thinking_done" });
        this.onEvent?.({
          type: "tool_use",
          tool: action.tool,
          reason: action.reason || "",
          input: action.input
        });

        this.history.push({
          role: "assistant",
          content: JSON.stringify(toolCallMessage),
          ...(useNativeTools ? { toolCall: { id: callId, name: action.tool, input: action.input } } : {}),
        });

        let result;
        let toolError = null;
        try {
          result = await toolFn(action.input || {}, { signal });
        } catch (err) {
          if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
            const abortErr = new Error("Task aborted by user.");
            abortErr.code = "TASK_ABORTED";
            throw abortErr;
          }
          result = `Tool error: ${err.message}`;
          toolError = err.message;
        }
        this.throwIfAborted(signal);

        const resultDigest = String(result || "").slice(0, 1000);
        const sameAsLastTurnStep = toolSignature === lastToolSignature && resultDigest === lastToolResultDigest;
        if (sameAsLastTurnStep) repeatedNoProgressCount += 1;
        else repeatedNoProgressCount = 0;
        lastToolSignature = toolSignature;
        lastToolResultDigest = resultDigest;

        const outcomeKey = `${toolSignature}::${resultDigest}`;
        const seenCount = (seenOutcomeCounts.get(outcomeKey) || 0) + 1;
        seenOutcomeCounts.set(outcomeKey, seenCount);
        if (seenCount >= 2) {
          const msg =
            "I’m repeating the same verified step result in this turn. Stopping to avoid a tool loop. Please refine the request or confirm next action.";
          this.history.push({ role: "assistant", content: msg });
          return msg;
        }

        if ((action.tool === "todo_write" || action.tool === "todowrite") && /^No-op:/i.test(String(result || ""))) {
          todoNoopCount += 1;
          if (todoNoopCount >= 1) {
            const msg =
              "Todo list is already up to date. I won’t keep calling todo_write. I can continue with concrete actions if you specify the next step.";
            this.history.push({ role: "assistant", content: msg });
            return msg;
          }
        }

        this.onEvent?.({
          type: "tool_end",
          tool: action.tool,
          result: String(result || ""),
          error: toolError,
        });

        const toolResultMessage = {
          type: "tool_result",
          tool: action.tool,
          result: result,
          _callId: callId,
        };

        this.history.push({
          role: "user",
          content: JSON.stringify(toolResultMessage),
          ...(useNativeTools ? { toolResult: { toolCallId: callId, name: action.tool, result } } : {}),
        });

        if (
          Number.isFinite(turnPolicy?.maxToolCalls) &&
          toolCalls >= turnPolicy.maxToolCalls &&
          !turnPolicy?.forceFinalizeAfterTool
        ) {
          turnToolLimitReached = true;
          postLimitToolRetryCount = 0;
          const commitRequirement = turnPolicy?.requireCommitMessage
            ? " Include a clear 'Suggested commit message' line."
            : "";
          this.history.push({
            role: "assistant",
            content:
              `Tool collection complete for this turn. Based on collected outputs only, provide the final user-facing answer now.${commitRequirement}`,
          });
          continue;
        }

        if (
          turnPolicy?.forceFinalizeAfterTool &&
          Number.isFinite(turnPolicy?.maxToolCalls) &&
          toolCalls >= turnPolicy.maxToolCalls
        ) {
          const message = this.formatToolResultForUser(action, result, toolError);
          this.history.push({ role: "assistant", content: message });
          return message;
        }

        if (activePlan && toolCalls >= budget && !didReplan) {
          const newPlan = await this.replanTurn({
            userMessage,
            previousPlan: activePlan,
            toolCalls,
            signal,
          });
          if (newPlan) {
            activePlan = newPlan;
            budget = Math.max(newPlan.toolBudget || budget, budget + 1);
            didReplan = true;
            this.onEvent?.({
              type: "plan_progress",
              message: `Replanned after ${toolCalls} tools. New budget: ${budget}`,
            });
          }
        }
      }
    } catch (err) {
      if (signal?.aborted || err?.code === "ABORT_ERR" || err?.name === "AbortError") {
        const abortErr = new Error("Task aborted by user.");
        abortErr.code = "TASK_ABORTED";
        throw abortErr;
      }
      throw err;
    } finally {
      this.activeAbortController = null;
    }
  }

  shouldPlanTask(message) {
    if (!this.enablePlanner) return false;

    const messageLower = message.toLowerCase();

    // 如果消息包含以下特征，可能需要任务规划
    const hasComplexTaskKeywords = [
      'analyze', 'implement', 'refactor', 'debug', 'test',
      'build', 'create', 'design', 'develop', 'improve',
      'fix', 'optimize', 'restructure', 'update'
    ].some(keyword => messageLower.includes(keyword));

    const hasMultiStepIndicators = [
      'first', 'then', 'next', 'after that', 'finally',
      'step 1', 'step 2', 'step 3', '1.', '2.', '3.'
    ].some(indicator => messageLower.includes(indicator));

    const isLongMessage = message.length > 100;

    return hasComplexTaskKeywords || hasMultiStepIndicators || isLongMessage;
  }

  async runPlannedTask(userMessage) {
    if (!this.taskPlanner) {
      throw new Error("Task planner is not enabled.");
    }
    console.log('[Planning] Analyzing task requirements...');
    const analysis = await this.taskPlanner.analyzeTask(userMessage);

    console.log(`[Planning] Task type: ${analysis.taskType}`);
    console.log(`[Planning] Difficulty: ${analysis.difficulty}`);
    console.log(`[Planning] Sub-tasks: ${analysis.subTasks.length}`);

    if (analysis.challenges.length > 0) {
      console.log(`[Planning] Potential challenges: ${analysis.challenges.join(', ')}`);
    }

    // 创建执行计划
    console.log('[Planning] Creating execution plan...');
    const plan = await this.taskPlanner.createExecutionPlan(analysis);

    console.log(`[Planning] Plan created with ${plan.length} steps.`);
    plan.forEach((step, index) => {
      console.log(`[Step ${index + 1}] ${step.description}`);
    });

    // 执行计划
    const executor = new TaskExecutor(this, plan);
    console.log('[Execution] Starting task execution...');
    const results = await executor.executePlan();

    // 分析结果
    const successfulSteps = results.filter(r => r.success);
    const failedSteps = results.filter(r => !r.success);

    console.log(`[Execution] Completed ${successfulSteps.length}/${results.length} steps successfully`);

    if (failedSteps.length > 0) {
      console.log(`[Execution] Failed steps: ${failedSteps.map(r => r.step.id).join(', ')}`);
      failedSteps.forEach(stepResult => {
        console.log(`[Step ${stepResult.step.id}] Error: ${stepResult.error}`);
      });
    }

    // 收集详细结果
    const detailedResults = [];
    results.forEach(result => {
      const stepResult = {
        step: result.step.description,
        status: result.success ? 'Success' : 'Failed',
        id: result.step.id,
        result: result.success ? result.result : result.error
      };
      detailedResults.push(stepResult);
    });

    // 分析结果并生成总结
    const taskOutcome = this.analyzeTaskOutcome(results);

    // 创建详细的结果字符串
    let resultStr = `✅ Task Completed - ${analysis.taskType}\n`;
    resultStr += `📊 Difficulty: ${analysis.difficulty}\n`;
    resultStr += `🎯 Goal: ${analysis.goal}\n`;
    resultStr += `\n📝 Execution Summary: ${taskOutcome.summary}\n`;

    resultStr += `\n📋 Steps: (${detailedResults.length} total)\n`;
    detailedResults.forEach(stepResult => {
      const icon = stepResult.status === 'Success' ? '✅' : (stepResult.status === 'Failed' ? '❌' : '⚠️');
      resultStr += `  ${icon} ${stepResult.step}\n`;

      if (stepResult.status === 'Failed') {
        resultStr += `    Error: ${stepResult.result}\n`;
      } else if (stepResult.status === 'Skipped') {
        resultStr += `    Note: ${stepResult.result}\n`;
      }
    });

    if (taskOutcome.recommendations.length > 0) {
      resultStr += `\n💡 Recommendations: ${taskOutcome.recommendations.length}\n`;
      taskOutcome.recommendations.forEach((rec, index) => {
        resultStr += `  ${index + 1}. ${rec}\n`;
      });
    }

    // 在历史中记录任务完成情况
    this.history.push({
      role: "assistant",
      content: `Task completed with ${successfulSteps.length}/${results.length} steps successfully`
    });

    return resultStr;
  }

  analyzeTaskOutcome(results) {
    const successfulSteps = results.filter(r => r.success);
    const failedSteps = results.filter(r => !r.success);
    const completionRate = successfulSteps.length / results.length;

    let summary = `Task completed with ${successfulSteps.length}/${results.length} steps (${Math.round(completionRate * 100)}% success rate). `;

    if (failedSteps.length === 0) {
      summary += 'All steps were executed successfully.';
    } else if (failedSteps.length <= 2) {
      summary += `${failedSteps.length} minor issues were encountered, but most steps were successful.`;
    } else {
      summary += `${failedSteps.length} steps failed. The task may need to be re-executed with modifications.`;
    }

    const recommendations = [];
    if (failedSteps.length > 0) {
      recommendations.push('Review the failed steps and try again');
    }
    if (completionRate < 0.8) {
      recommendations.push('Consider simplifying the task or breaking it into smaller sub-tasks');
    }
    recommendations.push('Check if there are any dependencies or prerequisites that need to be met');

    return {
      summary,
      recommendations,
      completionRate
    };
  }
}

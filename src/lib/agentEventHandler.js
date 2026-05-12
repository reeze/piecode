function normalizeProgressText(value, maxLen = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function progressIntentFromTool(tool, input = {}, fallbackLine = "") {
  const name = String(tool || "tool");
  const safe = input && typeof input === "object" ? input : {};
  if (name === "read_file" && safe.path) return `I am about to read ${safe.path}.`;
  if (name === "read_files" && Array.isArray(safe.paths)) {
    const shown = safe.paths.slice(0, 3).join(", ");
    const more = safe.paths.length > 3 ? ` +${safe.paths.length - 3}` : "";
    return `I am about to read ${shown}${more}.`;
  }
  if (name === "rg" || name === "grep" || name === "search_files") {
    const query = safe.pattern || safe.regex || safe.query || "workspace";
    const scope = safe.path || safe.glob || safe.file_pattern || "workspace";
    return `I am about to search ${scope} for ${query}.`;
  }
  if (name === "edit_file" || name === "write_file") return `I am about to update ${safe.path || "a file"}.`;
  if (name === "replace_in_files") return `I am about to ${safe.apply ? "apply" : "preview"} replacements in ${safe.path || "the workspace"}.`;
  if (name === "run_tests") return `I am about to run ${safe.command || "tests"}.`;
  if (name === "shell") return `I am about to run ${safe.command || "a shell command"}.`;
  if (name === "subagent") return `I am about to delegate: ${safe.task || "subagent task"}.`;
  const line = String(fallbackLine || "").replace(/^\[run\]\s*/i, "").trim();
  return line ? `I am about to ${line}.` : `I am about to use ${name}.`;
}

export function createAgentEventHandler(deps = {}) {
  const {
    sessionBus,
    recordTaskEvent,
    taskTraceRef,
    updateSubagentState,
    subagentsRef,
    logLine,
    summarizeForLog,
    formatProviderModel,
    tui,
    display,
    shouldAutoTrackTodosFromPlan,
    seedTodosFromPlan,
    applyTodoState,
    todosRef,
    todoAutoTrackRef,
    refreshTuiContextUsage,
    formatCompactNumber,
    inferEndpointForProvider,
    providerOptionsRef,
    providerRef,
    llmLastRef,
    trackLlmDebugEvent,
    llmHistoryRef,
    persistLlmSessionEvent,
    workspaceDir,
    traceStateRef,
    recordTaskLlm,
    traceRef,
    llmStreamRef,
    estimateTokenCount,
    addPendingRequestTokens,
    summarizeThinkingResponseForLog,
    appendThinkingToLlmDebugEvent,
    extractThinkingFromFinalModelPayload,
    extractReadableThinkingPreview,
    formatStageUpdate,
    normalizeTokenUsage,
    consumePendingRequestTokens,
    providerPrefix = defaultProviderPrefix,
    verboseToolLogs,
    formatToolBatchSummary,
    formatToolCounts,
    formatReadableToolRunLine,
    formatToolResultLinesForTimeline,
    advanceTodosOnToolStart,
  } = deps;

  const progressState = { last: "", lastAt: 0 };
  const emitProgress = (message, { force = false } = {}) => {
    const text = normalizeProgressText(message, 260);
    if (!text) return;
    const now = Date.now();
    if (!force && text === progressState.last) return;
    if (!force && now - progressState.lastAt < 700 && text.startsWith(progressState.last)) return;
    progressState.last = text;
    progressState.lastAt = now;
    logLine?.(`[progress] ${text}`);
  };

  return (evt = {}) => {
    if (evt && typeof evt === "object") {
      sessionBus?.emit?.(`agent.${String(evt.type || "event")}`, evt);
    }
    if (evt.type === "subagent_start") {
      recordTaskEvent?.(taskTraceRef, evt);
      updateSubagentState?.(subagentsRef, evt);
      logLine?.(`[agent] start ${evt.id}: ${summarizeForLog(evt.task, 120)}`);
    }
    if (evt.type === "subagent_event") {
      recordTaskEvent?.(taskTraceRef, evt);
      updateSubagentState?.(subagentsRef, evt);
    }
    if (evt.type === "subagent_end") {
      recordTaskEvent?.(taskTraceRef, evt);
      updateSubagentState?.(subagentsRef, evt);
      const suffix = evt.error ? ` error=${summarizeForLog(evt.error, 120)}` : "";
      logLine?.(`[agent] ${evt.status || "done"} ${evt.id}: ${summarizeForLog(evt.task, 120)}${suffix}`);
    }
    if (evt.type === "model_call") {
      recordTaskEvent?.(taskTraceRef, evt);
      const label = formatProviderModel({ kind: evt.provider, model: evt.model });
      if (tui) tui.onModelCall(label);
      logLine?.(`[model] ${label}`);
    }
    if (evt.type === "planning_call") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (tui) tui.onModelCall(formatProviderModel({ kind: evt.provider, model: evt.model }));
      logLine?.(`[plan] creating plan`);
    }
    if (evt.type === "replanning_call") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (tui) tui.onModelCall(formatProviderModel({ kind: evt.provider, model: evt.model }));
      logLine?.(`[plan] revising plan`);
    }
    if (evt.type === "plan") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (display) display.onPlan(evt.plan);
      const budget = evt.plan?.toolBudget ?? "-";
      const summary = evt.plan?.summary ? ` - ${evt.plan.summary}` : "";
      logLine?.(`[plan] budget=${budget}${summary}`);
      if (todosRef.value.length === 0 && shouldAutoTrackTodosFromPlan(evt.plan)) {
        const seeded = seedTodosFromPlan(evt.plan);
        if (seeded.length > 0) {
          applyTodoState(todosRef, seeded, {
            sessionBus,
            tui,
            autoTrackRef: todoAutoTrackRef,
            autoTrack: true,
          });
        }
      } else {
        todoAutoTrackRef.value = false;
      }
    }
    if (evt.type === "replan") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (display) display.onPlan(evt.plan);
      const budget = evt.plan?.toolBudget ?? "-";
      const summary = evt.plan?.summary ? ` - ${evt.plan.summary}` : "";
      logLine?.(`[plan] updated budget=${budget}${summary}`);
    }
    if (evt.type === "plan_progress") {
      recordTaskEvent?.(taskTraceRef, evt);
      logLine?.(`[plan] ${evt.message}`);
    }
    if (evt.type === "context_compacted") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (tui) refreshTuiContextUsage();
      const before = formatCompactNumber(evt.beforeTokens || 0);
      const after = formatCompactNumber(evt.afterTokens || 0);
      const limit = evt.limit ? `/${formatCompactNumber(evt.limit)}` : "";
      logLine?.(
        `[context] auto compacted: ${evt.beforeMessages} -> ${evt.afterMessages} messages | tok ${before} -> ${after}${limit}`
      );
    }
    if (evt.type === "llm_request") {
      recordTaskEvent?.(taskTraceRef, evt);
      const endpoint = inferEndpointForProvider(providerOptionsRef.value, providerRef.value);
      const sentChars = String(evt.payload || "").length;
      const requestProvider = providerPrefix(providerRef.value?.kind);
      const requestModel = String(providerRef.value?.model || "");
      llmLastRef.value.request = {
        at: new Date().toISOString(),
        stage: String(evt.stage || ""),
        provider: requestProvider,
        model: requestModel,
        endpoint,
        payload: String(evt.payload || ""),
      };
      const trackedRequest = trackLlmDebugEvent(llmHistoryRef, "request", llmLastRef.value.request);
      void persistLlmSessionEvent(taskTraceRef, workspaceDir, {
        at: llmLastRef.value.request.at,
        type: "llm_request",
        pairId: trackedRequest?.id || null,
        turnId: traceStateRef.value.turnId,
        taskId: taskTraceRef.current?.id || "",
        stage: llmLastRef.value.request.stage,
        provider: requestProvider,
        model: requestModel,
        endpoint,
        payload: llmLastRef.value.request.payload,
      });
      recordTaskLlm(taskTraceRef, {
        direction: "request",
        stage: evt.stage,
        provider: requestProvider,
        model: requestModel,
        endpoint,
        chars: sentChars,
        payload: evt.payload,
      });
      if (traceRef.value) {
        traceStateRef.value.llmStageStart[evt.stage] = Date.now();
        logLine?.(`[trace] llm_request stage=${evt.stage} chars=${sentChars}`);
      }
      if (tui) tui.onThinking(evt.stage);
      if (display) display.onThinking(evt.stage);
      if (llmStreamRef.value && Object.prototype.hasOwnProperty.call(llmStreamRef.value, evt.stage)) {
        llmStreamRef.value[evt.stage] = "";
      }
      if (tui && evt.stage === "turn") {
        tui.setLiveThought("Working...");
      }
      const sentTokens = estimateTokenCount(evt.payload);
      addPendingRequestTokens(evt.stage, sentTokens);
      if (tui) refreshTuiContextUsage();
      logLine?.(`[thinking] request:${evt.stage} endpoint:${endpoint} ${summarizeForLog(evt.payload)}`);
    }
    if (evt.type === "llm_response_delta") {
      recordTaskEvent?.(taskTraceRef, evt);
      const trackedThinking = appendThinkingToLlmDebugEvent(llmHistoryRef, evt.stage, evt.delta);
      void persistLlmSessionEvent(taskTraceRef, workspaceDir, {
        at: new Date().toISOString(),
        type: "llm_response_delta",
        pairId: trackedThinking?.id || null,
        turnId: traceStateRef.value.turnId,
        taskId: taskTraceRef.current?.id || "",
        stage: String(evt.stage || ""),
        delta: String(evt.delta || ""),
      });
      if (llmStreamRef.value && Object.prototype.hasOwnProperty.call(llmStreamRef.value, evt.stage)) {
        llmStreamRef.value[evt.stage] += String(evt.delta || "");
      }
      if (tui && evt.stage === "turn" && typeof extractReadableThinkingPreview === "function") {
        const source = llmStreamRef.value?.turn || evt.delta || "";
        const preview = extractReadableThinkingPreview(source);
        if (preview) {
          tui.setLiveThought(preview);
          emitProgress(preview);
        }
      }
    }
    if (evt.type === "llm_response") {
      recordTaskEvent?.(taskTraceRef, evt);
      const normalizedUsage = normalizeTokenUsage(evt.usage);
      const responseProvider = providerPrefix(providerRef.value?.kind);
      const responseModel = String(providerRef.value?.model || "");
      const responseEndpoint = inferEndpointForProvider(providerOptionsRef.value, providerRef.value);
      const responseChars = String(evt.payload || "").length;
      const startedAt = Number(traceStateRef.value.llmStageStart[evt.stage] || 0);
      const responseDurationMs = startedAt > 0 ? Date.now() - startedAt : 0;
      llmLastRef.value.response = {
        at: new Date().toISOString(),
        stage: String(evt.stage || ""),
        provider: responseProvider,
        model: responseModel,
        endpoint: responseEndpoint,
        usage: normalizedUsage,
        payload: String(evt.payload || ""),
      };
      const trackedResponse = trackLlmDebugEvent(llmHistoryRef, "response", llmLastRef.value.response);
      void persistLlmSessionEvent(taskTraceRef, workspaceDir, {
        at: llmLastRef.value.response.at,
        type: "llm_response",
        pairId: trackedResponse?.id || null,
        turnId: traceStateRef.value.turnId,
        taskId: taskTraceRef.current?.id || "",
        stage: llmLastRef.value.response.stage,
        provider: responseProvider,
        model: responseModel,
        endpoint: responseEndpoint,
        usage: normalizedUsage,
        durationMs: responseDurationMs,
        thinking: String(trackedResponse?.thinking || ""),
        payload: llmLastRef.value.response.payload,
      });
      recordTaskLlm(taskTraceRef, {
        direction: "response",
        stage: evt.stage,
        provider: responseProvider,
        model: responseModel,
        endpoint: responseEndpoint,
        usage: normalizedUsage,
        chars: responseChars,
        durationMs: responseDurationMs,
        payload: evt.payload,
      });
      if (traceRef.value) {
        logLine?.(
          `[trace] llm_response stage=${evt.stage} chars=${responseChars} duration=${responseDurationMs}ms`
        );
      }
      if (llmStreamRef.value && Object.prototype.hasOwnProperty.call(llmStreamRef.value, evt.stage)) {
        llmStreamRef.value[evt.stage] = String(evt.payload || "");
      }
      if (tui && evt.stage === "turn") {
        const preview = extractThinkingFromFinalModelPayload(llmStreamRef.value.turn);
        if (preview) {
          const update = formatStageUpdate(preview);
          tui.setLiveThought(update);
          emitProgress(update, { force: true });
        }
      }
      const pendingSent = consumePendingRequestTokens(evt.stage);
      let sentTokens = normalizedUsage?.input_tokens ?? null;
      let receivedTokens = normalizedUsage?.output_tokens ?? null;
      if (sentTokens == null) sentTokens = pendingSent > 0 ? pendingSent : null;
      if (receivedTokens == null && normalizedUsage?.total_tokens != null) {
        const derivedSent = sentTokens != null ? sentTokens : pendingSent;
        const total = normalizedUsage.total_tokens;
        receivedTokens = Math.max(0, total - Math.max(0, derivedSent || 0));
      }
      if (sentTokens == null) sentTokens = 0;
      if (receivedTokens == null) receivedTokens = estimateTokenCount(evt.payload);
      if (tui) {
        tui.addTokenUsage({ sent: sentTokens, received: receivedTokens });
        refreshTuiContextUsage();
      }
      logLine?.(`[thinking] response:${evt.stage} ${summarizeThinkingResponseForLog(evt.payload)}`);
    }
    if (evt.type === "thinking_done") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (tui) tui.onThinkingDone();
      if (display) display.onThinkingDone();
    }
    if (evt.type === "thought") {
      recordTaskEvent?.(taskTraceRef, evt);
      const update = formatStageUpdate(evt.content);
      if (tui && update) tui.setLiveThought(update);
      if (display && update) display.onThought(update);
      if (update) emitProgress(update, { force: true });
    }
    if (evt.type === "tool_batch_start") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (display) display.onToolBatchUse(evt.calls);
      const calls = Array.isArray(evt.calls) ? evt.calls : [];
      const label = traceRef.value || verboseToolLogs ? formatToolBatchSummary(calls) : formatToolCounts(calls.map((call) => call?.tool));
      logLine?.(`[tools] ${label || "tools"}`);
    }
    if (evt.type === "tool_use") {
      recordTaskEvent?.(taskTraceRef, evt);
      const isTodoTool = evt.tool === "todo_write" || evt.tool === "todowrite";
      const visibleThought = formatStageUpdate(evt.thought || evt.reason || "");
      if (tui) tui.onToolUse(evt.tool);
      if (tui && visibleThought) tui.setLiveThought(visibleThought);
      if (display && !evt.parallel) display.onToolUse(evt.tool, evt.input, evt.reason || evt.thought);
      if (visibleThought && !evt.parallel && !isTodoTool) emitProgress(visibleThought, { force: true });
      if (isTodoTool) {
        // keep todo activity in status bar only
      } else if (evt.parallel) {
        // batch header already logged by tool_batch_start
      } else if (traceRef.value || verboseToolLogs) {
        const details = Object.entries(evt.input || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        logLine?.(
          `[tool] ${evt.tool}${evt.reason ? ` - ${summarizeForLog(evt.reason, 120)}` : ""}${details ? ` (${details})` : ""}`
        );
      }
      if (visibleThought && (traceRef.value || verboseToolLogs)) logLine?.(`[thought] ${visibleThought}`);
    }
    if (evt.type === "tool_start") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (traceRef.value) {
        traceStateRef.value.toolStartByName[evt.tool] = Date.now();
        logLine?.(`[trace] tool_start name=${evt.tool}`);
      }
      if (display) display.onToolStart(evt.tool, evt.input);
      const readableRunLine = formatReadableToolRunLine(evt.tool, evt.input || {});
      if (evt.tool !== "todo_write" && evt.tool !== "todowrite") {
        emitProgress(progressIntentFromTool(evt.tool, evt.input || {}, readableRunLine), { force: true });
      }
      logLine?.(readableRunLine);
      if (todoAutoTrackRef.value && evt.tool !== "todo_write" && evt.tool !== "todowrite") {
        const advanced = advanceTodosOnToolStart(todosRef.value);
        if (advanced.length > 0) {
          applyTodoState(todosRef, advanced, {
            sessionBus,
            tui,
          });
        }
      }
    }
    if (evt.type === "tool_end") {
      recordTaskEvent?.(taskTraceRef, evt);
      if (traceRef.value) {
        const startedAt = Number(traceStateRef.value.toolStartByName[evt.tool] || 0);
        const durationMs = startedAt > 0 ? Date.now() - startedAt : 0;
        const err = evt.error ? "yes" : "no";
        logLine?.(`[trace] tool_end name=${evt.tool} duration=${durationMs}ms error=${err}`);
      }
      if (display) display.onToolEnd(evt.tool, evt.result, evt.error);
      if (tui) {
        const toolLines = formatToolResultLinesForTimeline(evt.tool, evt.result, evt.error);
        for (const line of toolLines) logLine?.(line);
      }
    }
  };
}

function defaultProviderPrefix(kind) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("openrouter")) return "openrouter";
  if (k.includes("seed")) return "seed";
  if (k.includes("anthropic")) return "anthropic";
  if (k.includes("openai")) return "openai";
  if (k.includes("codex")) return "codex";
  return k || "model";
}

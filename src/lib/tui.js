function truncateLine(line, width) {
  const text = String(line ?? "");
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function wrapText(text, width) {
  const source = String(text ?? "");
  if (width <= 1) return [source];
  const out = [];
  for (const paragraph of source.split("\n")) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (!line) {
        if (word.length <= width) {
          line = word;
        } else {
          let chunk = word;
          while (chunk.length > width) {
            out.push(chunk.slice(0, width));
            chunk = chunk.slice(width);
          }
          line = chunk;
        }
        continue;
      }
      const next = `${line} ${word}`;
      if (next.length <= width) {
        line = next;
      } else {
        out.push(line);
        if (word.length <= width) {
          line = word;
        } else {
          let chunk = word;
          while (chunk.length > width) {
            out.push(chunk.slice(0, width));
            chunk = chunk.slice(width);
          }
          line = chunk;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function formatCompactNumber(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const v = (value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1);
    return `${v.replace(/\.0$/, "")}m`;
  }
  if (abs >= 1_000) {
    const v = (value / 1_000).toFixed(abs >= 10_000 ? 0 : 1);
    return `${v.replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

export class SimpleTui {
  constructor({ out, workspaceDir, providerLabel, getSkillsLabel, getApprovalLabel }) {
    this.out = out;
    this.workspaceDir = workspaceDir;
    this.providerLabel = providerLabel;
    this.getSkillsLabel = getSkillsLabel;
    this.getApprovalLabel = getApprovalLabel;
    this.logs = [];
    this.maxLogs = 500;
    this.activity = [];
    this.maxActivity = 8;
    this.timeline = [];
    this.maxTimeline = 240;
    this.todos = [];
    this.showTodoPanel = false;
    this.active = false;
    this.modelState = "idle";
    this.modelName = "";
    this.lastTurnMs = null;
    this.lastError = "";
    this.lastTool = "";
    this.lastStatus = "Ready";
    this.thinking = false;
    this.thinkingStage = "";
    this.contextUsed = 0;
    this.contextLimit = 0;
    this.llmDebugEnabled = false;
    this.lastLlmRequest = "";
    this.lastLlmResponse = "";
    this.showRawLogs = false;
    this.lastFrameLineCount = 0;
    this.lastInputRow = 0;
    this.lastInputLine = "";
    this.approvalPrompt = "";
    this.approvalDefaultYes = false;
  }

  start() {
    this.active = true;
    this.out.write("\x1b[?25h");
    this.render("", "Ready. Type /help for commands.");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.out.write("\x1b[2J\x1b[H\x1b[?25h");
  }

  event(line) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${line}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(this.logs.length - this.maxLogs);
    }
    this.activity.push(entry);
    if (this.activity.length > this.maxActivity) {
      this.activity = this.activity.slice(this.activity.length - this.maxActivity);
    }
    const timelineLines = this.formatTimelineLines(String(line || ""));
    for (const item of timelineLines) {
      this.timeline.push(item);
    }
    if (this.timeline.length > this.maxTimeline) {
      this.timeline = this.timeline.slice(this.timeline.length - this.maxTimeline);
    }
  }

  onModelCall(label) {
    this.modelState = "running";
    this.modelName = label || this.modelName;
    this.thinking = true;
    this.thinkingStage = "model";
    this.lastStatus = "Model call in progress";
    this.render();
  }

  onToolUse(toolName) {
    this.lastTool = toolName || this.lastTool;
    this.lastStatus = `Using tool: ${toolName}`;
    this.render();
  }

  onTurnSuccess(durationMs) {
    this.modelState = "idle";
    this.thinking = false;
    this.thinkingStage = "";
    this.lastTurnMs = Number.isFinite(durationMs) ? Math.round(durationMs) : this.lastTurnMs;
    this.lastError = "";
    this.lastStatus = "Turn completed";
    this.render();
  }

  onTurnError(errorMessage, durationMs) {
    this.modelState = "error";
    this.thinking = false;
    this.thinkingStage = "";
    this.lastError = String(errorMessage || "");
    this.lastTurnMs = Number.isFinite(durationMs) ? Math.round(durationMs) : this.lastTurnMs;
    this.lastStatus = "Turn failed";
    this.render();
  }

  setLlmDebugEnabled(enabled) {
    this.llmDebugEnabled = Boolean(enabled);
    this.lastStatus = this.llmDebugEnabled ? "LLM I/O debug ON (CTRL+O to toggle)" : "LLM I/O debug OFF";
    this.render();
  }

  setLlmRequest(payload) {
    this.lastLlmRequest = String(payload || "");
    if (this.llmDebugEnabled && this.showRawLogs) this.render();
  }

  setLlmResponse(payload) {
    this.lastLlmResponse = String(payload || "");
    if (this.llmDebugEnabled && this.showRawLogs) this.render();
  }

  onThinking(stage = "") {
    this.thinking = true;
    this.thinkingStage = String(stage || "thinking");
    this.lastStatus = `thinking: ${this.thinkingStage}`;
    this.render();
  }

  setContextUsage(used, limit) {
    const safeUsed = Number.isFinite(used) ? Math.max(0, Math.round(used)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 0;
    this.contextUsed = safeUsed;
    this.contextLimit = safeLimit;
    this.render();
  }

  toggleLogPanel() {
    this.showRawLogs = !this.showRawLogs;
    this.lastStatus = this.showRawLogs ? "Raw logs view (CTRL+L)" : "Timeline view (CTRL+L)";
    this.render();
    return this.showRawLogs;
  }

  setRawLogsVisible(visible) {
    this.showRawLogs = Boolean(visible);
    this.lastStatus = this.showRawLogs ? "Raw logs view" : "Timeline view";
    this.render();
  }

  toggleTasks() {
    return this.toggleLogPanel();
  }

  toggleTodoPanel() {
    this.showTodoPanel = !this.showTodoPanel;
    this.lastStatus = this.showTodoPanel ? "TODO panel visible (CTRL+T)" : "TODO panel hidden";
    this.render();
    return this.showTodoPanel;
  }

  setTodos(todos) {
    this.todos = Array.isArray(todos) ? todos : [];
    if (this.showTodoPanel) this.render();
  }

  setApprovalPrompt(prompt, defaultYes = false) {
    this.approvalPrompt = String(prompt || "").trim();
    this.approvalDefaultYes = Boolean(defaultYes);
    this.lastStatus = "Awaiting approval";
    this.render();
  }

  clearApprovalPrompt() {
    this.approvalPrompt = "";
    this.approvalDefaultYes = false;
    this.render();
  }

  formatTimelineLines(line) {
    if (!line) return [];
    if (line.startsWith("[task] ")) {
      return [`> ${line.slice(7).trim()}`];
    }
    if (line.startsWith("[plan] creating plan")) {
      return ["Planning..."];
    }
    if (line.startsWith("[thinking] ")) {
      return [];
    }
    if (line.startsWith("[run] shell")) {
      const m = line.match(/command=("[^"]*"|\\S+)/);
      let command = "";
      if (m?.[1]) {
        try {
          command = JSON.parse(m[1]);
        } catch {
          command = m[1];
        }
      }
      const display = command || "shell command";
      return [`Bash(${display})`, "L Running..."];
    }
    if (line.startsWith("[tool] ")) {
      return [`Tool: ${line.slice(7).trim()}`];
    }
    if (line.startsWith("[response] ")) {
      const text = line.slice(11).trim();
      if (!text) return ["Assistant: <empty>"];
      const chunks = text.split("\n").filter(Boolean);
      if (chunks.length === 0) return ["Assistant: <empty>"];
      return [`Assistant: ${chunks[0]}`, ...chunks.slice(1)];
    }
    if (line.startsWith("[result] ")) {
      return [`Result: ${line.slice(9).trim()}`];
    }
    if (line.startsWith("error:")) {
      return [line];
    }
    if (line.startsWith("[")) {
      // Hide internal event noise in workspace timeline.
      return [];
    }
    return [line];
  }

  buildInputState(input, width) {
    const rawInput = String(input || "");
    const promptGlyph = "❯";
    const maxInputWidth = Math.max(0, width - 3);
    let shownInput = rawInput;
    if (shownInput.length > maxInputWidth) {
      shownInput =
        maxInputWidth > 3
          ? `...${shownInput.slice(-(maxInputWidth - 3))}`
          : shownInput.slice(-maxInputWidth);
    }
    const placeholder = 'Try "fix lint errors"';
    const inputText = shownInput || placeholder;
    const line = shownInput
      ? truncateLine(` ${promptGlyph} ${inputText}`, width)
      : ` ${promptGlyph} \x1b[2m${truncateLine(inputText, maxInputWidth)}\x1b[0m`;
    const cursorCol = Math.max(1, Math.min(width, 4 + shownInput.length));
    return { line, cursorCol };
  }

  renderInput(input = "") {
    if (!this.active || !this.lastInputRow || !this.lastFrameLineCount) return;
    const width = Math.max(40, this.out.columns || 100);
    const { line: inputLine, cursorCol } = this.buildInputState(input, width);
    if (inputLine === this.lastInputLine) {
      this.out.write(`\x1b[?25h\x1b[${this.lastInputRow};${cursorCol}H`);
      return;
    }
    this.lastInputLine = inputLine;
    this.out.write(
      `\x1b[${this.lastInputRow};1H\x1b[2K\x1b[1m${inputLine}\x1b[0m\x1b[?25h\x1b[${this.lastInputRow};${cursorCol}H`
    );
  }

  formatStatusLine(width) {
    const state =
      this.modelState === "running"
        ? "\x1b[33mrunning\x1b[0m"
        : this.modelState === "error"
          ? "\x1b[31merror\x1b[0m"
          : "\x1b[32midle\x1b[0m";
    const time = this.lastTurnMs == null ? "-" : `${this.lastTurnMs}ms`;
    const tool = this.lastTool || "-";
    const phase = this.thinking
      ? ` | phase: \x1b[33mthinking${this.thinkingStage ? `(${this.thinkingStage})` : ""}\x1b[0m`
      : "";
    const ctx =
      this.contextLimit > 0
        ? ` | ctx: ${formatCompactNumber(this.contextUsed)}/${formatCompactNumber(this.contextLimit)} (${Math.min(999, Math.round((this.contextUsed / this.contextLimit) * 100))}%)`
        : "";
    const todoSummary =
      this.todos.length > 0
        ? ` | todos: ${this.todos.filter((t) => t.status === "completed").length}/${this.todos.length}`
        : "";
    const text = ` model: ${this.modelName || this.providerLabel()} | state: ${state} | last: ${time} | tool: ${tool}${ctx}${todoSummary}${phase}`;
    return truncateLine(text, width);
  }

  render(input = "", status = "") {
    if (!this.active) return;

    const width = Math.max(40, this.out.columns || 100);
    const height = Math.max(16, this.out.rows || 30);
    const header = ` Piecode TUI | ${this.providerLabel()} | skills: ${this.getSkillsLabel()} | approve: ${this.getApprovalLabel()} `;
    const title = truncateLine(header, width);
    const topBorder = `\x1b[90m${"─".repeat(width)}\x1b[0m`;
    const sep = `\x1b[90m${"─".repeat(width)}\x1b[0m`;
    const workspaceLine = truncateLine(` workspace: ${this.workspaceDir}`, width);
    const modelStatusLine = this.formatStatusLine(width);
    const statusLine = truncateLine(` status: ${status || this.lastStatus || "idle"}`, width);
    const errorLine = this.lastError ? truncateLine(` error: ${this.lastError}`, width) : "";

    const llmHeader = truncateLine(" LLM I/O DEBUG (CTRL+O to toggle)", width);
    const llmReqTitle = truncateLine(" request:", width);
    const llmResTitle = truncateLine(" response:", width);
    const llmReqLines = this.llmDebugEnabled ? wrapText(this.lastLlmRequest || "<empty>", width).slice(0, 3) : [];
    const llmResLines = this.llmDebugEnabled ? wrapText(this.lastLlmResponse || "<empty>", width).slice(0, 3) : [];

    const headerLines = errorLine ? 5 : 4;
    const debugBlockLines = this.showRawLogs && this.llmDebugEnabled
      ? 1 + 1 + llmReqLines.length + 1 + llmResLines.length
      : 0;
    const todoLines = this.showTodoPanel
      ? Math.min(
          1 + this.todos.length,
          7
        )
      : 0;
    const todoBlockLines = this.showTodoPanel ? 1 + todoLines : 0; // sep + content
    const approvalLines = this.approvalPrompt ? 4 : 0;
    const bottomLines = 4;
    const logSepLines = 1;
    const availableLogLines = height - (1 + headerLines + logSepLines + todoBlockLines + debugBlockLines + approvalLines + bottomLines);
    const logHeight = Math.max(0, availableLogLines);
    const wrappedLogs = this.logs.flatMap((line) => wrapText(line, width));
    const wrappedTimeline = this.timeline.flatMap((line) => wrapText(line, width));
    const sourceLines = this.showRawLogs ? wrappedLogs : wrappedTimeline;
    const visibleLogs = sourceLines.slice(Math.max(0, sourceLines.length - logHeight));
    while (visibleLogs.length < logHeight) visibleLogs.unshift("");

    const inputState = this.buildInputState(input, width);
    const footer = truncateLine(
      ` CTRL+L ${this.showRawLogs ? "timeline" : "raw logs"} | CTRL+O llm i/o`,
      width
    );
    const approvalBlock = this.approvalPrompt
      ? [
          sep,
          truncateLine(" APPROVAL REQUIRED", width),
          truncateLine(` ${this.approvalPrompt}`, width),
          truncateLine(
            ` Press Y to approve, N to deny${this.approvalDefaultYes ? ", ENTER = Yes" : ", ENTER = No"}`,
            width
          ),
        ]
      : [];

    const todoStatus = (status) =>
      status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
    const todoLinesBlock = this.showTodoPanel
      ? [
          sep,
          ...[
            " TODO",
            ...(this.todos.length === 0
              ? ["(no tasks yet)"]
              : this.todos
                  .slice(0, Math.max(0, todoLines - 1))
                  .map((todo) => `${todoStatus(todo.status)} ${todo.content}`)),
          ].map((line) => truncateLine(line, width)),
        ]
      : [];

    const frameLines = [
      topBorder,
      `\x1b[2m${title}\x1b[0m`,
      workspaceLine,
      modelStatusLine,
      statusLine,
      ...(errorLine ? [`\x1b[31m${errorLine}\x1b[0m`] : []),
      sep,
      ...visibleLogs,
      ...todoLinesBlock,
      ...(this.showRawLogs && this.llmDebugEnabled
        ? [sep, `\x1b[35m${llmHeader}\x1b[0m`, llmReqTitle, ...llmReqLines, llmResTitle, ...llmResLines]
        : []),
      ...approvalBlock,
      sep,
      `\x1b[1m${inputState.line}\x1b[0m`,
      sep,
      `\x1b[2m${truncateLine(`${footer} | CTRL+T todos`, width)}\x1b[0m`,
    ];

    const frame = frameLines.join("\n");
    this.lastFrameLineCount = frameLines.length;
    // Input line is always the second-to-last line in the rendered frame.
    this.lastInputRow = Math.max(1, this.lastFrameLineCount - 2);
    this.lastInputLine = inputState.line;
    this.out.write("\x1b[H\x1b[J" + frame + `\x1b[?25h\x1b[${this.lastInputRow};${inputState.cursorCol}H`);
  }
}

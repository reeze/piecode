function truncateLine(line, width) {
  const text = String(line ?? "");
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function wrapText(text, width) {
  const source = String(text ?? "").replace(/\r/g, "");
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

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function renderInlineMarkdown(line) {
  let out = String(line || "");
  out = out.replace(
    /`([^`]+)`/g,
    (_m, content) => color(` ${content} `, "46;30")
  );
  out = out.replace(
    /(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g,
    (_m, _d, content) => color(content, "1")
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => `${color(text, "4;34")}${color(` (${url})`, "2;37")}`
  );
  return out;
}

function renderMarkdownLines(text) {
  const source = String(text || "");
  const lines = source.split("\n");
  const out = [];
  let inCode = false;
  for (const line of lines) {
    const fence = line.match(/^\s*```/);
    if (fence) {
      inCode = !inCode;
      out.push(color("```", "2;37"));
      continue;
    }
    if (inCode) {
      out.push(color(line, "36"));
      continue;
    }
    const header = line.match(/^(#{1,6})\s+(.+)$/);
    if (header) {
      out.push(color(renderInlineMarkdown(header[2]), "1;36"));
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      out.push(`${bullet[1]}${color("•", "2;37")} ${renderInlineMarkdown(bullet[2])}`);
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      out.push(`${ordered[1]}${color(`${ordered[2]}.`, "2;37")} ${renderInlineMarkdown(ordered[3])}`);
      continue;
    }
    out.push(renderInlineMarkdown(line));
  }
  return out;
}

function trimWorkspaceText(text, maxChars = 6000) {
  const source = String(text || "");
  const limit = Math.max(200, Number(maxChars) || 6000);
  if (source.length <= limit) return { text: source, trimmed: 0 };
  const trimmed = source.length - limit;
  return {
    text: `${source.slice(0, limit)}\n\n[trimmed ${trimmed} chars]`,
    trimmed,
  };
}

function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp == null) return 0;
  // Control chars and combining marks do not advance cursor width.
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  // East Asian wide/fullwidth + emoji ranges.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayWidth(value) {
  let width = 0;
  for (const ch of String(value || "")) {
    width += charDisplayWidth(ch);
  }
  return width;
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
    this.maxLogs = 2000;
    this.activity = [];
    this.maxActivity = 8;
    this.timeline = [];
    this.maxTimeline = 2000;
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
    this.turnTokensSent = 0;
    this.turnTokensReceived = 0;
    this.sessionTokensSent = 0;
    this.sessionTokensReceived = 0;
    this.turnStartedAt = 0;
    this.currentTaskText = "";
    this.llmDebugEnabled = false;
    this.lastLlmRequest = "";
    this.lastLlmResponse = "";
    this.showRawLogs = false;
    this.lastFrameLineCount = 0;
    this.lastInputRow = 0;
    this.lastInputLine = "";
    this.approvalPrompt = "";
    this.approvalDefaultYes = false;
    this.inputHint = "";
    this.currentInput = "";
    this.thinkingTick = 0;
    this.thinkingTimer = null;
    this.modelSuggestionsVisible = false;
    this.modelSuggestions = [];
    this.modelSuggestionIndex = 0;
    this.commandSuggestionsVisible = false;
    this.commandSuggestions = [];
    this.commandSuggestionIndex = 0;
    this.scrollOffset = 0;
    this.thoughtStreamText = "";
    this.thoughtStreamVisible = false;
  }

  start() {
    this.active = true;
    // Enable mouse reporting (normal + SGR extended) for wheel scrolling support.
    this.out.write("\x1b[?1000h\x1b[?1006h");
    this.out.write("\x1b[?25h");
    this.render("", "Ready. Type /help for commands.");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stopThinkingAnimation();
    // Disable mouse reporting on exit.
    this.out.write("\x1b[?1000l\x1b[?1006l");
    this.out.write("\x1b[2J\x1b[H\x1b[?25h");
  }

  event(line) {
    if (String(line || "").startsWith("[task] ")) {
      this.currentTaskText = String(line).slice(7).trim();
    }
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

  scrollLines(delta) {
    const step = Math.max(1, Math.round(Math.abs(Number(delta) || 0)));
    const direction = Number(delta) < 0 ? -1 : 1;
    this.scrollOffset = Math.max(0, this.scrollOffset + direction * step);
    this.render();
    return this.scrollOffset;
  }

  scrollPage(direction = 1) {
    const page = Math.max(3, Math.floor((this.out.rows || 30) * 0.5));
    return this.scrollLines(direction * page);
  }

  scrollToTop() {
    this.scrollOffset = 999999;
    this.render();
  }

  scrollToBottom() {
    this.scrollOffset = 0;
    this.render();
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
    this.stopThinkingAnimation();
    this.lastTurnMs = Number.isFinite(durationMs) ? Math.round(durationMs) : this.lastTurnMs;
    this.lastError = "";
    this.lastStatus = "Turn completed";
    this.render();
  }

  onTurnError(errorMessage, durationMs) {
    this.modelState = "error";
    this.thinking = false;
    this.thinkingStage = "";
    this.stopThinkingAnimation();
    this.lastError = String(errorMessage || "");
    this.lastTurnMs = Number.isFinite(durationMs) ? Math.round(durationMs) : this.lastTurnMs;
    this.lastStatus = "Turn failed";
    this.render();
  }

  beginTurn() {
    this.turnTokensSent = 0;
    this.turnTokensReceived = 0;
    this.turnStartedAt = Date.now();
    this.render();
  }

  addTokenUsage({ sent = 0, received = 0 } = {}) {
    const sentN = Number.isFinite(sent) ? Math.max(0, Math.round(sent)) : 0;
    const recvN = Number.isFinite(received) ? Math.max(0, Math.round(received)) : 0;
    if (!sentN && !recvN) return;
    this.turnTokensSent += sentN;
    this.turnTokensReceived += recvN;
    this.sessionTokensSent += sentN;
    this.sessionTokensReceived += recvN;
    this.render();
  }

  getTurnTokenUsage() {
    return {
      sent: this.turnTokensSent,
      received: this.turnTokensReceived,
    };
  }

  getSessionTokenUsage() {
    return {
      sent: this.sessionTokensSent,
      received: this.sessionTokensReceived,
    };
  }

  formatElapsedSinceTurnStart() {
    if (!this.turnStartedAt) return "0.0s";
    const ms = Math.max(0, Date.now() - this.turnStartedAt);
    return `${(ms / 1000).toFixed(1)}s`;
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
    this.lastStatus = "thinking...";
    this.startThinkingAnimation();
    this.render();
  }

  onThinkingDone() {
    this.thinking = false;
    this.thinkingStage = "";
    this.stopThinkingAnimation();
    this.render();
  }

  setLiveThought(content) {
    const text = String(content || "").trim();
    this.thoughtStreamVisible = Boolean(text);
    this.thoughtStreamText = text ? `Thought: ${text}` : "";
    this.render();
  }

  clearLiveThought() {
    if (!this.thoughtStreamVisible && !this.thoughtStreamText) return;
    this.thoughtStreamVisible = false;
    this.thoughtStreamText = "";
    this.render();
  }

  startThinkingAnimation() {
    if (this.thinkingTimer) return;
    this.thinkingTimer = setInterval(() => {
      if (!this.active || !this.thinking) return;
      this.thinkingTick = (this.thinkingTick + 1) % 5;
      this.render();
    }, 220);
  }

  stopThinkingAnimation() {
    if (!this.thinkingTimer) return;
    clearInterval(this.thinkingTimer);
    this.thinkingTimer = null;
  }

  setContextUsage(used, limit) {
    const safeUsed = Number.isFinite(used) ? Math.max(0, Math.round(used)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 0;
    this.contextUsed = safeUsed;
    this.contextLimit = safeLimit;
    this.render();
  }

  resetContextUsage() {
    this.contextUsed = 0;
    this.turnTokensSent = 0;
    this.turnTokensReceived = 0;
    this.turnStartedAt = 0;
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

  setInputHint(hint) {
    this.inputHint = String(hint || "").trim();
    this.render();
  }

  clearInputHint() {
    if (!this.inputHint) return;
    this.inputHint = "";
    this.render();
  }

  setModelSuggestions(options, selectedIndex = 0) {
    const list = Array.isArray(options) ? options.map((item) => String(item || "")).filter(Boolean) : [];
    this.modelSuggestions = list.slice(0, 8);
    this.modelSuggestionsVisible = this.modelSuggestions.length > 0;
    if (!this.modelSuggestionsVisible) {
      this.modelSuggestionIndex = 0;
    } else {
      const clamped = Math.max(0, Math.min(this.modelSuggestions.length - 1, Number(selectedIndex) || 0));
      this.modelSuggestionIndex = clamped;
    }
    this.render();
  }

  clearModelSuggestions() {
    if (!this.modelSuggestionsVisible && this.modelSuggestions.length === 0) return;
    this.modelSuggestionsVisible = false;
    this.modelSuggestions = [];
    this.modelSuggestionIndex = 0;
    this.render();
  }

  setCommandSuggestions(options, selectedIndex = 0) {
    const list = Array.isArray(options) ? options.map((item) => String(item || "")).filter(Boolean) : [];
    this.commandSuggestions = list.slice(0, 8);
    this.commandSuggestionsVisible = this.commandSuggestions.length > 0;
    if (!this.commandSuggestionsVisible) {
      this.commandSuggestionIndex = 0;
    } else {
      const clamped = Math.max(0, Math.min(this.commandSuggestions.length - 1, Number(selectedIndex) || 0));
      this.commandSuggestionIndex = clamped;
    }
    this.render();
  }

  clearCommandSuggestions() {
    if (!this.commandSuggestionsVisible && this.commandSuggestions.length === 0) return;
    this.commandSuggestionsVisible = false;
    this.commandSuggestions = [];
    this.commandSuggestionIndex = 0;
    this.render();
  }

  formatApprovalLines(width) {
    const prompt = String(this.approvalPrompt || "");
    const lines = [];
    const cmdMatch = prompt.match(/\$\s+([^\n]+)$/);
    const command = cmdMatch?.[1] ? String(cmdMatch[1]).trim() : "";
    const question = prompt
      .replace(/\$\s+[^\n]+$/m, "")
      .replace(/Approve\s*\[[^\]]+\]\s*:?\s*$/i, "")
      .trim();

    lines.push(color(" APPROVAL REQUIRED", "1;33"));
    if (question) {
      lines.push(truncateLine(` ${color("Question:", "1;36")} ${question}`, width));
    }
    if (command) {
      lines.push(truncateLine(` ${color("Command:", "1;35")} ${color(command, "37")}`, width));
    } else if (prompt) {
      lines.push(truncateLine(` ${color("Details:", "1;35")} ${prompt}`, width));
    }
    const choiceLine = this.approvalDefaultYes
      ? `${color("[Y]", "1;32")}es  ${color("[N]", "1;31")}o  ${color("[ENTER]", "1;33")}=${color("Yes", "32")}`
      : `${color("[Y]", "1;32")}es  ${color("[N]", "1;31")}o  ${color("[ENTER]", "1;33")}=${color("No", "31")}`;
    lines.push(truncateLine(` ${choiceLine}`, width));
    return lines;
  }

  formatTimelineLines(line) {
    if (!line) return [];
    if (line.startsWith("[task] ")) {
      return [color(` ◆ Task: ${line.slice(7).trim()} `, "1;30;47")];
    }
    if (line.startsWith("[model] ")) {
      return [];
    }
    if (line.startsWith("[plan]")) {
      return [];
    }
    if (line.startsWith("[thinking] ")) {
      // Keep thinking state transient (spinner/status line), do not persist into timeline.
      return [];
    }
    if (line.startsWith("[thought] ")) {
      const details = trimWorkspaceText(line.slice(9).trim(), 1800).text;
      return [color(`Thought: ${details || "<empty>"}`, "35"), ""];
    }
    if (line.startsWith("[run] shell")) {
      const m = line.match(/command=("[^"]*"|\\S+)/);
      const approvalMatch = line.match(/approval=("[^"]*"|\\S+)/);
      const shortMatch = line.match(/^\[run\]\s+shell\s+(.+)$/);
      let command = "";
      let approval = "";
      if (m?.[1]) {
        try {
          command = JSON.parse(m[1]);
        } catch {
          command = m[1];
        }
      }
      if (approvalMatch?.[1]) {
        try {
          approval = JSON.parse(approvalMatch[1]);
        } catch {
          approval = approvalMatch[1];
        }
      }
      if (!command && shortMatch?.[1]) {
        command = shortMatch[1].trim();
      }
      const display = command || "shell command";
      const safeDisplay = trimWorkspaceText(display, 320).text.replace(/\n/g, " ");
      const tag =
        approval === "approved"
          ? color("[APPROVED]", "1;33")
          : approval === "auto"
            ? color("[AUTO]", "2;32")
            : "";
      return [color(`Bash(${safeDisplay})`, "36") + (tag ? ` ${tag}` : ""), color("L Running...", "2;37"), ""];
    }
    if (line.startsWith("[tool] ")) {
      return [color(`Tool: ${line.slice(7).trim()}`, "36")];
    }
    if (line.startsWith("[response] ")) {
      const text = trimWorkspaceText(line.slice(11).trim(), 8000).text;
      if (!text) return ["<empty>", ""];
      const chunks = renderMarkdownLines(text).filter((chunk) => chunk !== undefined);
      if (chunks.length === 0) return ["<empty>", ""];
      return [...chunks, ""];
    }
    if (line.startsWith("[result] ")) {
      return [color(`✓ ${line.slice(9).trim()}`, "2;37"), ""];
    }
    if (line.startsWith("[banner-1] ")) {
      return [color(line.slice(11), "1;82")];
    }
    if (line.startsWith("[banner-title] ")) {
      const raw = String(line.slice(15) || "");
      const title = raw.trim();
      if (!title) return [color(raw, "1;92")];
      const leftPad = Math.max(0, raw.indexOf(title));
      return [`${" ".repeat(leftPad)}${color(` ${title} `, "1;30;42")}`];
    }
    if (line.startsWith("[banner-slogan] ")) {
      return [color(line.slice(16), "2;37")];
    }
    if (line.startsWith("[banner-2] ")) {
      return [color(line.slice(11), "1;118")];
    }
    if (line.startsWith("[banner-3] ")) {
      return [color(line.slice(11), "1;154")];
    }
    if (line.startsWith("[banner-4] ")) {
      return [color(line.slice(11), "1;177")];
    }
    if (line.startsWith("[banner-5] ")) {
      return [color(line.slice(11), "1;201")];
    }
    if (line.startsWith("[banner-6] ")) {
      return [color(line.slice(11), "1;213")];
    }
    if (line.startsWith("[banner-7] ")) {
      return [color(line.slice(11), "1;177")];
    }
    if (line.startsWith("[banner-8] ")) {
      return [color(line.slice(11), "1;154")];
    }
    if (line.startsWith("[banner-meta] ")) {
      return [color(line.slice(14), "2;37")];
    }
    if (line.startsWith("[banner-hint] ")) {
      return [color(line.slice(14), "2;36")];
    }
    if (line.startsWith("loaded project instructions:")) {
      return [color(line, "2;37")];
    }
    if (line.startsWith("error:")) {
      return [color(line, "31")];
    }
    if (line.startsWith("[")) {
      // Hide internal event noise in workspace timeline.
      return [];
    }
    return [trimWorkspaceText(line, 1200).text];
  }

  buildInputState(input, width, cursorIndex = null) {
    const rawInput = String(input || "");
    const normalizedSource = rawInput.replace(/\r/g, "");
    const normalizedInput = normalizedSource.replace(/\n/g, " ↩ ");
    const safeCursorIndex =
      Number.isFinite(cursorIndex) && Number(cursorIndex) >= 0
        ? Math.min(normalizedSource.length, Math.max(0, Math.floor(Number(cursorIndex))))
        : normalizedSource.length;
    const normalizedCursor = normalizedSource.slice(0, safeCursorIndex).replace(/\n/g, " ↩ ");
    const promptGlyph = "❯";
    const maxInputWidth = Math.max(0, width - 3);
    let shownInput = normalizedInput;
    let shownCursorText = normalizedCursor;
    if (shownInput.length > maxInputWidth) {
      const window = Math.max(1, maxInputWidth - 3);
      const cursorAt = Math.min(normalizedCursor.length, normalizedInput.length);
      let start = Math.max(0, Math.min(cursorAt - Math.floor(window / 2), normalizedInput.length - window));
      let segment = normalizedInput.slice(start, start + window);
      if (start > 0) {
        shownInput = `...${segment}`;
        shownCursorText = shownInput.slice(0, 3 + Math.max(0, cursorAt - start));
      } else {
        shownInput = `${segment}...`;
        shownCursorText = shownInput.slice(0, Math.min(shownInput.length, cursorAt));
      }
      if (shownInput.length > maxInputWidth) {
        shownInput = shownInput.slice(0, maxInputWidth);
        shownCursorText = shownInput.slice(0, Math.min(shownInput.length, shownCursorText.length));
      }
    }
    const placeholder = 'Try "fix lint errors"';
    const inputText = shownInput || placeholder;
    const line = shownInput
      ? truncateLine(` ${promptGlyph} ${inputText}`, width)
      : ` ${promptGlyph} \x1b[2m${truncateLine(inputText, maxInputWidth)}\x1b[0m`;
    const promptPrefix = ` ${promptGlyph} `;
    const cursorCol = Math.max(
      1,
      Math.min(Math.max(1, width), 1 + stringDisplayWidth(promptPrefix) + stringDisplayWidth(shownCursorText))
    );
    return { line, cursorCol };
  }

  renderInput(input = "", cursorIndex = null) {
    if (!this.active || !this.lastInputRow || !this.lastFrameLineCount) return;
    this.currentInput = String(input || "");
    const termWidth = Math.max(40, this.out.columns || 100);
    const width = Math.max(20, termWidth - 1);
    const { line: inputLine, cursorCol } = this.buildInputState(input, width, cursorIndex);
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
    const tokenSummary =
      this.sessionTokensSent > 0 || this.sessionTokensReceived > 0
        ? ` | session tok: ↑${formatCompactNumber(this.sessionTokensSent)} ↓${formatCompactNumber(this.sessionTokensReceived)}`
        : "";
    const text = ` model: ${this.modelName || this.providerLabel()} | state: ${state} | last: ${time} | tool: ${tool}${ctx}${tokenSummary}${todoSummary}${phase}`;
    return truncateLine(text, width);
  }

  render(input = this.currentInput, status = "") {
    if (!this.active) return;
    this.currentInput = String(input || "");

    const termWidth = Math.max(40, this.out.columns || 100);
    const width = Math.max(20, termWidth - 1);
    const height = Math.max(16, this.out.rows || 30);
    const sep = `\x1b[90m${"─".repeat(width)}\x1b[0m`;
    const errorLine = this.lastError ? truncateLine(` error: ${this.lastError}`, width) : "";

    const llmHeader = truncateLine(" LLM I/O DEBUG (CTRL+O to toggle)", width);
    const llmReqTitle = truncateLine(" request:", width);
    const llmResTitle = truncateLine(" response:", width);
    const llmReqLines = this.llmDebugEnabled ? wrapText(this.lastLlmRequest || "<empty>", width).slice(0, 3) : [];
    const llmResLines = this.llmDebugEnabled ? wrapText(this.lastLlmResponse || "<empty>", width).slice(0, 3) : [];

    const headerLines = errorLine ? 1 : 0;
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
    const approvalContentLines = this.approvalPrompt ? this.formatApprovalLines(width) : [];
    const approvalLines = this.approvalPrompt ? 1 + approvalContentLines.length : 0;
    const commandSuggestionLines = this.commandSuggestionsVisible ? (1 + this.commandSuggestions.length) : 0;
    const modelSuggestionLines = this.modelSuggestionsVisible ? (1 + this.modelSuggestions.length) : 0;
    const hintLines = this.inputHint ? 1 : 0;
    const thinkingLines = this.thinking ? 1 : 0;
    const thoughtWrapped = this.thoughtStreamVisible ? wrapText(this.thoughtStreamText, width) : [];
    const thoughtStreamLines = this.thoughtStreamVisible ? Math.min(3, thoughtWrapped.length) : 0;
    const bottomLines = 4 + commandSuggestionLines + modelSuggestionLines + hintLines; // input + pickers + status/hint
    const reservedLines =
      headerLines +
      todoBlockLines +
      debugBlockLines +
      approvalLines +
      thinkingLines +
      thoughtStreamLines +
      bottomLines;
    const maxLogLines = Math.max(1, height - reservedLines);
    const wrappedLogs = this.logs.flatMap((line) => wrapText(line, width));
    const wrappedTimeline = this.timeline.flatMap((line) => wrapText(line, width));
    const sourceLines = this.showRawLogs ? wrappedLogs : wrappedTimeline;
    const maxScroll = Math.max(0, sourceLines.length - maxLogLines);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);
    const start = Math.max(0, sourceLines.length - maxLogLines - this.scrollOffset);
    const visibleLogs = sourceLines.slice(start, start + maxLogLines);

    const inputState = this.buildInputState(this.currentInput, width);
    const scrollLabel = this.scrollOffset > 0 ? ` | scroll:+${this.scrollOffset}` : "";
    const ctxStatus =
      this.contextLimit > 0
        ? ` | ctx:${formatCompactNumber(this.contextUsed)}/${formatCompactNumber(this.contextLimit)}(${Math.min(999, Math.round((this.contextUsed / this.contextLimit) * 100))}%)`
        : "";
    const tokStatus =
      this.sessionTokensSent > 0 || this.sessionTokensReceived > 0
        ? ` | session tok:↑${formatCompactNumber(this.sessionTokensSent)} ↓${formatCompactNumber(this.sessionTokensReceived)}`
        : "";
    const promptStatusRaw = `status: ${status || this.lastStatus || "idle"}${ctxStatus}${tokStatus}${scrollLabel}`;
    const promptStatus =
      promptStatusRaw.length >= width
        ? truncateLine(promptStatusRaw, width)
        : `${" ".repeat(Math.max(0, width - promptStatusRaw.length))}${promptStatusRaw}`;
    const approvalBlock = this.approvalPrompt ? [sep, ...approvalContentLines] : [];
    const thinkingColors = ["82", "118", "154", "190", "201"];
    const thinkingColor = thinkingColors[this.thinkingTick % thinkingColors.length];
    const spinFrames = ["|", "/", "-", "\\"];
    const spin = spinFrames[this.thinkingTick % spinFrames.length];
    const runningLine = `↳ | ${spin} running | ${this.formatElapsedSinceTurnStart()} | tok ↑${formatCompactNumber(this.turnTokensSent)} ↓${formatCompactNumber(this.turnTokensReceived)}`;
    const thinkingBlock = this.thinking ? [color(runningLine, `1;${thinkingColor}`)] : [];
    const thoughtStreamBlock = this.thoughtStreamVisible
      ? (() => {
          const tail = thoughtWrapped.slice(-3);
          return tail.map((line) => color(line, "35"));
        })()
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

    const commandSuggestionBlock = this.commandSuggestionsVisible
      ? [
          color(" commands", "2;37"),
          ...this.commandSuggestions.map((command, idx) => {
            const selected = idx === this.commandSuggestionIndex;
            const text = selected ? color(`> ${command}`, "1;32") : color(`  ${command}`, "2;37");
            return truncateLine(` ${text}`, width);
          }),
        ]
      : [];

    const modelSuggestionBlock = this.modelSuggestionsVisible
      ? [
          color(" models", "2;37"),
          ...this.modelSuggestions.map((modelId, idx) => {
            const selected = idx === this.modelSuggestionIndex;
            const text = selected ? color(`> ${modelId}`, "1;32") : color(`  ${modelId}`, "2;37");
            return truncateLine(` ${text}`, width);
          }),
        ]
      : [];

    const beforeInputLines = [
      ...(errorLine ? [`\x1b[31m${errorLine}\x1b[0m`] : []),
      ...visibleLogs,
      ...todoLinesBlock,
      ...(this.showRawLogs && this.llmDebugEnabled
        ? [sep, `\x1b[35m${llmHeader}\x1b[0m`, llmReqTitle, ...llmReqLines, llmResTitle, ...llmResLines]
        : []),
      ...approvalBlock,
      ...thinkingBlock,
      ...thoughtStreamBlock,
      sep,
    ];
    const frameLines = [
      ...beforeInputLines,
      `\x1b[1m${inputState.line}\x1b[0m`,
      ...commandSuggestionBlock,
      ...modelSuggestionBlock,
      sep,
      `\x1b[2m${promptStatus}\x1b[0m`,
      ...(this.inputHint ? [`\x1b[2m${truncateLine(` ${this.inputHint}`, width)}\x1b[0m`] : []),
    ];

    const frame = frameLines.join("\n");
    this.lastFrameLineCount = frameLines.length;
    this.lastInputRow = Math.max(1, beforeInputLines.length + 1);
    this.lastInputLine = inputState.line;
    this.out.write("\x1b[H\x1b[J" + frame + `\x1b[?25h\x1b[${this.lastInputRow};${inputState.cursorCol}H`);
  }
}

import { SimpleTui } from "../src/lib/tui.js";

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function createOut(columns = 100, rows = 28) {
  return {
    columns,
    rows,
    writes: [],
    write(chunk) {
      this.writes.push(String(chunk));
    },
  };
}

function latestFrame(out) {
  return stripAnsi(out.writes[out.writes.length - 1] || "");
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = String(value);
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[name];
    else process.env[name] = prev;
  }
}

describe("tui usability", () => {
  test("does not enable mouse capture by default", () => {
    withEnv("PIECODE_MOUSE_CAPTURE", null, () => {
      const out = createOut();
      const tui = new SimpleTui({
        out,
        workspaceDir: "/tmp/work",
        providerLabel: () => "seed:model",
        getSkillsLabel: () => "none",
        getApprovalLabel: () => "off",
      });
      tui.start();
      const raw = out.writes.join("");
      expect(raw).not.toContain("\x1b[?1000h");
      expect(raw).not.toContain("\x1b[?1006h");
    });
  });

  test("enables mouse capture when PIECODE_MOUSE_CAPTURE=1", () => {
    withEnv("PIECODE_MOUSE_CAPTURE", "1", () => {
      const out = createOut();
      const tui = new SimpleTui({
        out,
        workspaceDir: "/tmp/work",
        providerLabel: () => "seed:model",
        getSkillsLabel: () => "none",
        getApprovalLabel: () => "off",
      });
      tui.start();
      const raw = out.writes.join("");
      expect(raw).toContain("\x1b[?1000h");
      expect(raw).toContain("\x1b[?1006h");
      expect(tui.isMouseCaptureEnabled()).toBe(true);
    });
  });

  test("todo panel renders empty and populated states", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.toggleTodoPanel();
    let frame = latestFrame(out);
    expect(frame).toContain("TODO");
    expect(frame).toContain("(no tasks yet)");

    tui.setTodos([{ id: "todo-1", content: "Implement tests", status: "in_progress" }]);
    frame = latestFrame(out);
    expect(frame).toContain("[~] Implement tests");
  });

  test("toggleLogPanel switches raw-log mode state", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    expect(tui.showRawLogs).toBe(false);
    tui.toggleLogPanel();
    expect(tui.showRawLogs).toBe(true);
  });

  test("formatTimelineLines maps key event types and hides thinking noise", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    expect(stripAnsi(tui.formatTimelineLines("[task] simplify repo")[0])).toContain("Task: simplify repo");
    expect(tui.formatTimelineLines("[model] seed-openai-compatible:doubao")).toEqual([]);
    expect(tui.formatTimelineLines("[plan] budget=3 - scoped plan")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines('[run] shell command="echo hi"')[0])).toContain("Bash(echo hi)");
    expect(stripAnsi(tui.formatTimelineLines("[run] shell echo hi")[0])).toContain("[~]");
    expect(tui.formatTimelineLines("[tool] shell (echo hi)")).toEqual([]);
    expect(tui.formatTimelineLines("[tool] todo_write (3 todos)")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (README.md)")[0])).toContain("Tool: read_file");
    expect(stripAnsi(tui.formatTimelineLines("[result] done")[0])).toContain("[ok] done");
    expect(stripAnsi(tui.formatTimelineLines("[result] shell failed | time: 2s")[0])).toContain(
      "[x] shell failed | time: 2s"
    );
    expect(stripAnsi(tui.formatTimelineLines("[tool-result] 1 file changed, 1 insertion(+), 1 deletion(-)")[0])).toContain(
      "1 file changed, 1 insertion(+), 1 deletion(-)"
    );
    expect(stripAnsi(tui.formatTimelineLines("[banner-1] ██████")[0])).toContain("██████");
    expect(stripAnsi(tui.formatTimelineLines("[banner-meta] model: seed:model")[0])).toContain("model: seed:model");
    expect(stripAnsi(tui.formatTimelineLines("[banner-hint] keys: CTRL+L")[0])).toContain("keys: CTRL+L");
    expect(tui.formatTimelineLines("[thinking] internal details")).toEqual([]);
    expect(tui.formatTimelineLines("[thinking] request:turn payload-here")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines("[thought] I should inspect files first")[0])).toContain("Thought: I should inspect files first");
    const markdownResponse = stripAnsi(
      tui.formatTimelineLines("[response] ## Title\n- **bold** and `code`")[1]
    );
    expect(markdownResponse).toContain("•");
    expect(markdownResponse).toContain("bold");
    expect(markdownResponse).toContain("code");
    const plainResponse = stripAnsi(tui.formatTimelineLines("[response] hello world")[0]);
    expect(plainResponse.trim()).toBe("hello world");
    expect(plainResponse).not.toContain("Assistant:");
    const boldResponse = stripAnsi(tui.formatTimelineLines("[response] this is **BOLD** text")[0]);
    expect(boldResponse).toContain("this is BOLD text");
    expect(boldResponse).not.toContain("**BOLD**");
    const longResponse = `[response] ${"a".repeat(9000)}`;
    const longLines = tui.formatTimelineLines(longResponse).map((line) => stripAnsi(line));
    expect(longLines.join("\n")).toContain("[trimmed ");
  });

  test("formatApprovalLines separates question, command, and reason without duplication", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.setApprovalPrompt(
      'shell: curl -sL "https://agentskills.io/specification" (command is neither known safe nor explicitly dangerous)',
      false
    );

    const lines = tui.formatApprovalLines(220).map((line) => stripAnsi(line));
    expect(lines.join("\n")).toContain("Question: Approve shell command?");
    expect(lines.join("\n")).toContain('Command: curl -sL "https://agentskills.io/specification"');
    expect(lines.join("\n")).toContain("Details: command is neither known safe nor explicitly dangerous");
    expect(lines.join("\n")).not.toContain(
      'Details: shell: curl -sL "https://agentskills.io/specification" (command is neither known safe nor explicitly dangerous)'
    );
  });

  test("overlay renders section labels and hint text", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.openOverlay(
      "LLM Debug 1/2",
      "Request: stage=turn\nResponse: stage=turn\nThinking Output:\n```text\nabc\n```",
      { mode: "llm-debug", hint: " n/p: switch entry  q: close " }
    );
    const frame = latestFrame(out);
    expect(frame).toContain("LLM Debug 1/2");
    expect(frame).toContain("Request:");
    expect(frame).toContain("Response:");
    expect(frame).toContain("Thinking Output:");
    expect(frame).toContain("n/p: switch entry");
  });

  test("overlay slash search jumps to matching content", () => {
    const out = createOut(80, 12);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const content = [
      ...Array.from({ length: 20 }, (_v, i) => `line-${i + 1}`),
      "needle-target",
      ...Array.from({ length: 10 }, (_v, i) => `tail-${i + 1}`),
    ].join("\n");
    tui.openOverlay("LLM Debug 1/1", content, { mode: "llm-debug" });
    expect(tui.overlayScroll).toBe(0);
    tui.startOverlaySearch();
    tui.appendOverlaySearch("needle");
    const found = tui.submitOverlaySearch();
    expect(found).toBe(true);
    expect(tui.overlayScroll).toBeGreaterThan(0);
    expect(tui.isOverlaySearchActive()).toBe(false);
  });

  test("cursor anchors to input row after repeated renders", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.render("", "ready");
    tui.render("", "ready");
    tui.renderInput("abc");

    const lastWrite = out.writes[out.writes.length - 1] || "";
    expect(lastWrite).toContain(`\x1b[${tui.lastInputRow};`);
  });

  test("cursor anchor remains on prompt row across repeated renders", () => {
    const out = createOut(80, 22);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });
    tui.start();
    for (let i = 0; i < 3; i += 1) {
      tui.toggleTodoPanel();
      tui.toggleTodoPanel();
      tui.render("", "waiting for input");
      tui.renderInput("", 0);
      const lastWrite = out.writes[out.writes.length - 1] || "";
      expect(lastWrite).toContain(`\x1b[${tui.lastInputRow};4H`);
    }
  });

  test("input hint renders below prompt without moving cursor off input row", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setInputHint("Press CTRL+D again to exit.");
    const frame = latestFrame(out);
    expect(frame).toContain("Press CTRL+D again to exit.");
    expect(tui.lastInputRow).toBeLessThan(tui.lastFrameLineCount);
  });

  test("status bar is rendered below the prompt", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const frame = latestFrame(out);
    expect(frame).toContain("status:");
    expect(frame).not.toContain("llm:");
    expect(frame).not.toContain("view:");
    expect(frame).not.toContain("todos:");
    expect(frame).not.toContain("TODO(");
  });

  test("status bar shows TODO progress and hides it when empty", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setTodos([
      { id: "todo-1", content: "step one", status: "completed" },
      { id: "todo-2", content: "step two", status: "pending" },
    ]);
    let frame = latestFrame(out);
    expect(frame).toContain("TODO(1/2)");

    tui.setTodos([
      { id: "todo-1", content: "step one", status: "completed" },
      { id: "todo-2", content: "step two", status: "completed" },
    ]);
    frame = latestFrame(out);
    expect(frame).toContain("TODO(2/2)");

    tui.setTodos([]);
    frame = latestFrame(out);
    expect(frame).not.toContain("TODO(");
  });

  test("explicit status message persists across input rerenders", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.render("", "plan mode: off | normal execution enabled");
    let frame = latestFrame(out);
    expect(frame).toContain("plan mode: off | normal execution enabled");

    tui.renderInput("/plan", 5);
    frame = latestFrame(out);
    expect(frame).toContain("plan mode: off | normal execution enabled");
  });

  test("plan mode status is shown only when enabled", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    let frame = latestFrame(out);
    expect(frame).not.toContain("plan:on");

    tui.setPlanMode(true);
    frame = latestFrame(out);
    expect(frame).toContain("plan:on");

    tui.setPlanMode(false);
    frame = latestFrame(out);
    expect(frame).not.toContain("plan:on");
  });

  test("bash input highlights leading bang and shows bash mode in status", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("!git status");
    const rawFrame = out.writes[out.writes.length - 1] || "";
    const plainFrame = latestFrame(out);
    expect(rawFrame).toContain("\x1b[31m!\x1b[0m");
    expect(plainFrame).toContain("mode:bash");
  });

  test("project instructions status is rendered below input", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setProjectInstructionsStatus({ source: "AGENTS.md", state: "loaded" });
    let frame = latestFrame(out);
    expect(frame).toContain("AGENTS.md: loaded");

    tui.setProjectInstructionsStatus({ source: "AGENTS.md", state: "missing" });
    frame = latestFrame(out);
    expect(frame).toContain("AGENTS.md: not found");

    tui.setProjectInstructionsStatus({ source: "AGENTS.md", state: "empty" });
    frame = latestFrame(out);
    expect(frame).toContain("AGENTS.md: empty");

    tui.setProjectInstructionsStatus({ source: "AGENTS.md", state: "error", detail: "EACCES" });
    frame = latestFrame(out);
    expect(frame).toContain("AGENTS.md: unreadable");
    expect(frame).toContain("EACCES");
  });

  test("project instructions status hides after task begins", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setProjectInstructionsStatus({ source: "AGENTS.md", state: "loaded" });
    let frame = latestFrame(out);
    expect(frame).toContain("AGENTS.md: loaded");

    tui.beginTurn();
    frame = latestFrame(out);
    expect(frame).not.toContain("AGENTS.md: loaded");
  });

  test("running indicator is rendered in workspace while thinking", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[task] inspect repo");
    tui.onThinking("turn");
    const frame = latestFrame(out);
    expect(frame).toContain("Task: inspect repo");
    expect(frame).toContain("running");
    expect(frame).toContain("tok");
    tui.onThinkingDone();
    tui.stop();
  });

  test("renderInput visualizes multiline input without breaking frame rows", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("line1\nline2");
    const lastWrite = stripAnsi(out.writes[out.writes.length - 1] || "");
    expect(lastWrite).toContain("line1");
    expect(lastWrite).toContain("line2");
  });

  test("renderInput grows to wrapped lines as input expands", () => {
    const out = createOut(26, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const longInput = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    tui.renderInput(longInput, longInput.length);
    const lastWrite = out.writes[out.writes.length - 1] || "";
    const plain = stripAnsi(lastWrite);
    expect(tui.lastInputLine.split("\n").length).toBeGreaterThan(1);
    expect(lastWrite).toContain(`\x1b[${tui.lastInputRow + 1};`);
    expect(plain).toContain("abcdef");
    expect(plain).toContain("0123456789");
  });

  test("input row moves lower as workspace content grows", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const baseRow = tui.lastInputRow;
    for (let i = 0; i < 60; i += 1) tui.event(`line-${i + 1}`);
    tui.renderInput("x", 1);
    const expandedRow = tui.lastInputRow;

    expect(expandedRow).toBeGreaterThan(baseRow);
    expect(expandedRow).toBeGreaterThanOrEqual(22);
    expect(expandedRow).toBeLessThanOrEqual(out.rows);
  });

  test("new task event resets scroll to bottom", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    for (let i = 0; i < 80; i += 1) tui.event(`old-line-${i + 1}`);
    tui.scrollToTop();
    expect(tui.scrollOffset).toBeGreaterThan(0);

    tui.event("[task] run new request");
    expect(tui.scrollOffset).toBe(0);
  });

  test("renderInput honors explicit cursor position (CTRL+A/CTRL+E behavior)", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("abcdef", 0);
    let lastWrite = out.writes[out.writes.length - 1] || "";
    expect(lastWrite).toContain(`\x1b[${tui.lastInputRow};4H`);

    tui.renderInput("abcdef", 6);
    lastWrite = out.writes[out.writes.length - 1] || "";
    expect(lastWrite).toContain(`\x1b[${tui.lastInputRow};10H`);
  });

  test("live thought content is rendered in workspace", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setLiveThought("inspect files first");
    let frame = latestFrame(out);
    expect(frame).toContain("Thought:");
    expect(frame).toContain("inspect files first");
    tui.clearLiveThought();
    frame = latestFrame(out);
    expect(frame).not.toContain("inspect files first");
    tui.stop();
  });

  test("model suggestions render between prompt and status with selection indicator", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "gpt-5.3-codex(codex)",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setModelSuggestions(["openai/gpt-4.1-mini", "anthropic/claude-3.7-sonnet"], 1);
    const frame = latestFrame(out);
    expect(frame).toContain("models <gpt-5.3-codex(codex)>");
    expect(frame).toContain("> anthropic/claude-3.7-sonnet");
    expect(frame).toContain("openai/gpt-4.1-mini");
  });

  test("model suggestions scroll with hidden-above/below indicators", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "gpt-5.3-codex(codex)",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    const models = Array.from({ length: 12 }, (_v, i) => `provider/model-${i + 1}`);
    tui.start();
    tui.setModelSuggestions(models, 0);
    let frame = latestFrame(out);
    expect(frame).toContain("> provider/model-1");
    expect(frame).toContain("provider/model-8");
    expect(frame).toContain("... 4 below");
    expect(frame).not.toContain("provider/model-9");

    tui.setModelSuggestions(models, 10);
    frame = latestFrame(out);
    expect(frame).toContain("> provider/model-11");
    expect(frame).toContain("... 3 above");
    expect(frame).toContain("... 1 below");
    expect(frame).not.toMatch(/\n\s*> provider\/model-1(?:\s|\n|$)/);
    expect(frame).not.toMatch(/\n\s+provider\/model-1(?:\s|\n|$)/);
  });

  test("command suggestions render with highlighted selection", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setCommandSuggestions(["/model", "/model list"], 0);
    const frame = latestFrame(out);
    expect(frame).toContain("commands");
    expect(frame).toContain("> /model");
    expect(frame).toContain("/model list");
  });

  test("scrolling shows older content when overflowed", () => {
    const out = createOut(80, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed/model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });
    tui.start();
    for (let i = 1; i <= 30; i += 1) {
      tui.event(`line-${i}`);
    }
    tui.render("");
    const latest = latestFrame(out);
    expect(latest).toContain("line-30");

    tui.scrollPage(1);
    const scrolled = latestFrame(out);
    expect(scrolled).toContain("scroll:+");
  });
});

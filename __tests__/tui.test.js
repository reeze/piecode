import { SimpleTui } from "../src/lib/tui.js";

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
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

  test("timeline shows compact tool parameter details", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    expect(stripAnsi(tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)")[0])).toContain("read_file(a.txt)");
    tui.setRawLogsVisible(true);
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (README.md)")[0])).toContain("README.md");
    expect(stripAnsi(tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)")[0])).toContain("read_file(b.txt)");
  });

  test("task timeline row keeps full-width background padding after render wrapping", () => {
    const out = createOut(80, 24);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[task] short task");
    tui.render();

    const rawFrame = out.writes[out.writes.length - 1] || "";
    const taskLine = rawFrame.split("\n").find((line) => stripAnsi(line).includes("Task: short task"));
    expect(taskLine).toBeTruthy();
    expect(taskLine).toMatch(/Task: short task\s+\x1b\[0m/);
    expect(stripAnsi(taskLine).length).toBe(out.columns - 1);
  });

  test("timeline inserts breathing room between task, tools, results, and response", () => {
    const out = createOut(100, 32);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[task] improve readability");
    tui.event("[tool] read_file (src/lib/tui.js)");
    tui.event("[tool-result] line one\nline two");
    tui.event("[response] Done");

    expect(tui.timeline).toContain("");
    const plain = tui.timeline.map((line) => stripAnsi(line));
    const taskIdx = plain.findIndex((line) => line.includes("Task: improve readability"));
    const toolIdx = plain.findIndex((line) => line.includes("Read"));
    const resultIdx = plain.findIndex((line) => line.includes("line one"));
    const responseIdx = plain.findIndex((line) => line.includes("Done"));
    expect(plain[toolIdx - 1]).toBe("");
    expect(plain[resultIdx - 1]).toBe("");
    expect(plain[responseIdx - 1]).toBe("");
    expect(plain[resultIdx]).toMatch(/^\S/);
    expect(plain[resultIdx + 1]).toMatch(/^  \S/);
    expect(taskIdx).toBeLessThan(toolIdx);
  });

  test("timeline wraps long entries with readable continuation indentation", () => {
    const out = createOut(42, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[response] " + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda");
    tui.render();

    const frameLines = latestFrame(out).split("\n");
    const responseLines = frameLines.filter((line) => line.includes("alpha") || /^\s{4,}\S/.test(line));
    expect(responseLines.length).toBeGreaterThan(1);
    expect(responseLines[0]).toMatch(/^\s*(?:•|\*)\s/);
    expect(responseLines.slice(1).some((line) => /^\s{4}\S/.test(line))).toBe(true);
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

    const taskLineRaw = tui.formatTimelineLines("[task] simplify repo")[0];
    expect(stripAnsi(taskLineRaw)).toContain("Task: simplify repo");
    expect(taskLineRaw).toContain("\x1b[1;37;48;5;236m");
    expect(stripAnsi(taskLineRaw).length).toBe(out.columns - 1);
    const okIcon = tui.symbols.ok;
    const failIcon = tui.symbols.fail;
    expect(tui.formatTimelineLines("[model] seed-openai-compatible:doubao")).toEqual([]);
    expect(tui.formatTimelineLines("[plan] budget=3 - scoped plan")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines('[run] shell command="echo hi"')[0])).toContain("Shell echo hi");
    expect(stripAnsi(tui.formatTimelineLines("[run] shell echo hi")[0])).toContain("Shell echo hi");
    expect(stripAnsi(tui.formatTimelineLines("[run] test npm test -- --runInBand __tests__")[0])).toContain(
      "Test npm test -- --runInBand __tests__"
    );
    expect(stripAnsi(tui.formatTimelineLines('[run] collaborate {"task":"Review the UI state"}')[0])).toContain(
      "Agents Review the UI state"
    );
    expect(stripAnsi(tui.formatTimelineLines("[progress] Checking the UI path before editing")[0])).toContain(
      "Checking the UI path before editing"
    );
    expect(tui.formatTimelineLines("[tool] shell (echo hi)")).toEqual([]);
    expect(tui.formatTimelineLines("[tool] todo_write (3 todos)")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (README.md)")[0])).toContain("Read");
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (README.md)")[0])).toContain("README.md");
    expect(stripAnsi(tui.formatTimelineLines("[tool] rg (targetSymbol in *.js)")[0])).toContain("Search");
    expect(stripAnsi(tui.formatTimelineLines("[tool] rg (targetSymbol in *.js)")[0])).toContain("targetSymbol");
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (path=README.md)")[0])).toContain("Read path=README.md");
    expect(stripAnsi(tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)")[0])).toContain("Run read_file x2");
    expect(stripAnsi(tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)")[0])).toContain("read_file(a.txt)");
    expect(stripAnsi(tui.formatTimelineLines("[result] done")[0])).toContain(`${okIcon} done`);
    expect(stripAnsi(tui.formatTimelineLines("[result] shell failed | time: 2s")[0])).toContain(
      `${failIcon} shell failed | time: 2s`
    );
    const toolResultLine = stripAnsi(tui.formatTimelineLines("[tool-result] 1 file changed, 1 insertion(+), 1 deletion(-)")[0]);
    expect(toolResultLine).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(toolResultLine).toMatch(/^\S/);
    expect(stripAnsi(tui.formatTimelineLines("[banner-1] ██████")[0])).toContain("██████");
    expect(stripAnsi(tui.formatTimelineLines("[banner-meta] model: seed:model")[0])).toContain("model: seed:model");
    expect(stripAnsi(tui.formatTimelineLines("[banner-hint] keys: CTRL+L | !cmd shell")[0])).toContain("keys: CTRL+L");
    expect(stripAnsi(tui.formatTimelineLines("[banner-hint] keys: CTRL+L | !cmd shell")[0])).toContain("!cmd shell");
    tui.start();
    tui.setStartupShortcutHint("keys: CTRL+L logs | CTRL+T todos");
    expect(latestFrame(out)).toContain("keys: CTRL+L logs | CTRL+T todos");
    tui.beginTurn();
    expect(latestFrame(out)).not.toContain("keys: CTRL+L logs | CTRL+T todos");
    expect(tui.formatTimelineLines("[thinking] internal details")).toEqual([]);
    expect(tui.formatTimelineLines("[thinking] request:turn payload-here")).toEqual([]);
    expect(tui.formatTimelineLines("[thought] I should inspect files first")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines("[agent] start subagent-1: inspect providers")[0])).toContain("Agent start subagent-1");
    const markdownResponse = stripAnsi(
      tui.formatTimelineLines("[response] ## Title\n- **bold** and `code`")[1]
    );
    expect(markdownResponse).toContain("•");
    expect(markdownResponse).toContain("bold");
    expect(markdownResponse).toContain("code");
    const commandMarkdown = stripAnsi(tui.formatTimelineLines("- **skill-name**: use `npm test`")[0]);
    expect(commandMarkdown).toContain("• skill-name: use npm test");
    expect(commandMarkdown).not.toContain("**skill-name**");
    const commandHeader = stripAnsi(tui.formatTimelineLines("## Skills")[0]);
    expect(commandHeader).toContain("Skills");
    expect(commandHeader).not.toContain("##");
    const codeResponse = stripAnsi(
      tui.formatTimelineLines("[response] ```js\nconst x = 1;\n```").join("\n")
    );
    expect(codeResponse).toContain("const x = 1;");
    expect(codeResponse).not.toContain("JavaScript");
    expect(codeResponse).not.toContain("js");
    expect(codeResponse).not.toContain("----");
    expect(codeResponse).not.toContain("```");
    const markdownCodeResponse = stripAnsi(
      tui.formatTimelineLines("[response] ```markdown\n# Title\n``` ".trim()).join("\n")
    );
    expect(markdownCodeResponse).toContain("# Title");
    expect(markdownCodeResponse).not.toContain("Markdown");
    const hrResponse = stripAnsi(tui.formatTimelineLines("[response] before\n------\nafter").join("\n"));
    expect(hrResponse).toContain("before");
    expect(hrResponse).toContain("after");
    expect(hrResponse).not.toContain("------");
    const plainResponse = stripAnsi(tui.formatTimelineLines("[response] hello world")[0]);
    expect(plainResponse.trim()).toBe(`${tui.symbols.response} hello world`);
    expect(plainResponse).not.toContain("Assistant:");
    const boldResponse = stripAnsi(tui.formatTimelineLines("[response] this is **BOLD** text")[0]);
    expect(boldResponse).toContain("this is BOLD text");
    expect(boldResponse).not.toContain("**BOLD**");
    const richMarkdown = stripAnsi(
      tui.formatTimelineLines([
        "[response] ### Details",
        "- [x] done item",
        "  - nested item",
        "1. ordered item",
        "| Name | Count |",
        "| --- | ---: |",
        "| alpha | 12 |",
        "> quoted *note*",
        ">> nested quote",
        "    indented code",
      ].join("\n")).join("\n")
    );
    expect(richMarkdown).toContain("› Details");
    expect(richMarkdown).toContain("[x] done item");
    expect(richMarkdown).toContain("◦ nested item");
    expect(richMarkdown).toContain("1. ordered item");
    expect(richMarkdown).toContain("│ Name");
    expect(richMarkdown).toContain("alpha");
    expect(richMarkdown).toContain("│ quoted note");
    expect(richMarkdown).toContain("││ nested quote");
    expect(richMarkdown).toContain("indented code");
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
    expect(lines.join("\n")).toContain("? approval required");
    expect(lines.join("\n")).toContain("q: Approve shell command?");
    expect(lines.join("\n")).toContain('$ curl -sL "https://agentskills.io/specification"');
    expect(lines.join("\n")).toContain("why: command is neither known safe nor explicitly dangerous");
    expect(lines.join("\n")).toContain("remember");
    expect(lines.join("\n")).toContain("session");
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

  test("contextual input hints render as prompt placeholder", () => {
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
    expect(frame).toContain("继续描述你想改什么");

    tui.setInputHints(["review 当前改动", "运行相关测试"]);
    frame = latestFrame(out);
    expect(frame).toContain("review 当前改动");

    tui.renderInput("typed text");
    frame = latestFrame(out);
    expect(frame).toContain("typed text");
    expect(frame).not.toContain("review 当前改动");
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
    expect(frame).toContain("Ready. Type /help for commands.");
    expect((frame.match(/─{10,}/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(frame).not.toContain("status:");
    expect(frame).not.toContain("llm:");
    expect(frame).not.toContain("view:");
    expect(frame).not.toContain("todos:");
    expect(frame).not.toContain("TODO(");
  });

  test("frame separators use unicode when supported", () => {
    const out = createOut(80, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[thought] Preparing tool: run_tests");
    tui.renderInput("");
    const raw = out.writes.join("");
    expect(raw).toContain("──────────");
  });

  test("wide characters do not overflow truncated status lines", () => {
    const out = createOut(42, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setLiveThought("界面可能错乱的问题".repeat(10));
    const frame = String(out.writes[out.writes.length - 1] || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const width = out.columns - 1;
    for (const line of frame.split("\n")) {
      const printableWidth = Array.from(line).reduce((sum, ch) => {
        const cp = ch.codePointAt(0);
        return sum + (cp >= 0x2e80 && cp <= 0xa4cf ? 2 : 1);
      }, 0);
      expect(printableWidth).toBeLessThanOrEqual(width);
    }
  });

  test("context usage is capped at 100% in the status bar", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setContextUsage(150, 100);
    const frame = latestFrame(out);
    expect(frame).toContain("ctx:100/100(100%)");
    expect(frame).not.toContain("150/100");
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

  test("all completed todos show status-bar notice without timeline completion event", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setTodos([{ id: "todo-1", content: "finish", status: "completed" }]);
    let frame = latestFrame(out);
    expect(frame).toContain(tui.symbols.todoDoneNotice);
    expect(frame).toContain("Task completed");
    expect(frame).toContain("TODO(1/1)");
    expect(tui.timeline.map(stripAnsi).join("\n")).not.toContain("Task completed");

    tui.beginTurn();
    frame = latestFrame(out);
    expect(frame).not.toContain(tui.symbols.todoDoneNotice);
    expect(frame).toContain("TODO(1/1)");
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

  test("task context hides while the matching timeline task is visible and reappears when scrolled out", () => {
    const out = createOut(100, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[task] create a small CLI calculator");
    tui.onToolUse("write_file");
    let frame = latestFrame(out);
    expect(frame).toContain("Task");
    expect(frame).toContain("create a small CLI calculator");
    expect(frame).toContain("Using tool: write_file");
    expect(frame).not.toContain("Done");
    let rawTaskContextLine = (out.writes[out.writes.length - 1] || "")
      .split("\n")
      .find((line) => stripAnsi(line).includes("Task: create a small CLI calculator ·"));
    expect(rawTaskContextLine).toBeUndefined();

    for (let i = 0; i < 30; i += 1) {
      tui.event(`[progress] step ${i}`);
    }
    tui.renderInput("");
    frame = latestFrame(out);
    rawTaskContextLine = (out.writes[out.writes.length - 1] || "")
      .split("\n")
      .find((line) => stripAnsi(line).includes("Task: create a small CLI calculator ·"));
    expect(rawTaskContextLine).toContain("\x1b[1;37;48;5;236m");
    expect(rawTaskContextLine).toMatch(/Task: create a small CLI calculator.*\s+\x1b\[0m/);
    expect(stripAnsi(rawTaskContextLine).length).toBe(out.columns - 1);

    tui.onTurnSuccess(1234);
    frame = latestFrame(out);
    expect(frame).toContain("Task: Done · create a small CLI calculator");
    rawTaskContextLine = (out.writes[out.writes.length - 1] || "")
      .split("\n")
      .find((line) => stripAnsi(line).includes("Task: Done · create a small CLI calculator"));
    expect(rawTaskContextLine).toContain("\x1b[1;37;48;5;236m");
    expect(stripAnsi(rawTaskContextLine).length).toBe(out.columns - 1);
  });

  test("task context shows failed after task error", () => {
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
    for (let i = 0; i < 30; i += 1) {
      tui.event(`[progress] step ${i}`);
    }
    tui.onTurnError("boom", 1200);
    const frame = latestFrame(out);
    expect(frame).toContain("Task: Failed · inspect repo");
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
    expect(frame).toContain("thinking");
    expect(frame).not.toContain("↳ | ");
    expect(frame).not.toContain(" | tok ↑0 ↓0");
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

  test("live thought content is rendered only in transient status, not workspace timeline", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.onThinking("turn");
    tui.setLiveThought("inspect files first");
    let frame = latestFrame(out);
    expect(frame).toContain("thinking");
    expect(frame).toContain("inspect files first");
    expect(tui.timeline.map(stripAnsi).join("\n")).not.toContain("inspect files first");
    expect(tui.thoughtStreamVisible).toBe(false);
    tui.event("[thought] inspect files first");
    frame = latestFrame(out);
    expect(tui.timeline.map(stripAnsi).join("\n")).not.toContain("inspect files first");
    expect((frame.match(/inspect files first/g) || []).length).toBe(1);
    tui.clearLiveThought();
    frame = latestFrame(out);
    expect(tui.thoughtStreamVisible).toBe(false);
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

  test("wide character input leaves a safety column when wrapping", () => {
    const out = createOut(42, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("请实现在退出的时候，显示当前的会话id并且不要让输入区错位", 33);
    const inputLines = tui.lastInputLine.split("\n").map(stripAnsi);
    expect(inputLines.length).toBeGreaterThan(1);
    for (const line of inputLines) {
      expect(line.length).toBeLessThan(out.columns);
    }

    const frame = latestFrame(out);
    expect(frame).toContain("Ready. Type /help for commands.");
    expect(frame).toContain("请实现在退出的时候");
  });

  test("wide character input positions cursor by display columns", () => {
    const out = createOut(80, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("中文", "中文".length);
    const raw = out.writes[out.writes.length - 1] || "";
    expect(tui.lastInputLine).toContain("中文");
    expect(raw).toContain(`\x1b[${tui.lastInputRow};8H`);
  });

  test("renderInput repaints padded rows for CJK input", () => {
    const out = createOut(42, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("这是一段中文", "这是一段中文".length);
    const raw = out.writes[out.writes.length - 1] || "";
    const plainLines = stripAnsi(raw).split("\n");
    const inputLine = plainLines.find((line) => line.includes("这是一段中文"));
    expect(raw.startsWith("\x1b[?25l\x1b[H\x1b[2J")).toBe(true);
    expect(inputLine).toBeTruthy();
    expect(inputLine.endsWith(" ")).toBe(true);
    expect(inputLine.length).toBeGreaterThan("❯ 这是一段中文".length);
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
    expect(latest).not.toContain("PgUp");
    expect(latest).not.toContain("Shift");
    expect(tui.lastScrollMax).toBeGreaterThan(0);

    tui.scrollPage(1);
    const scrolled = latestFrame(out);
    expect(scrolled).toContain("timeline:");
    expect(scrolled).not.toContain("PgDn");
    expect(scrolled).not.toContain("End:bottom");
    expect(tui.scrollOffset).toBeGreaterThan(0);

    tui.scrollToTop();
    expect(tui.scrollOffset).toBe(tui.lastScrollMax);
    const top = latestFrame(out);
    expect(top).toContain("line-1");

    tui.scrollToBottom();
    expect(tui.scrollOffset).toBe(0);
    const bottom = latestFrame(out);
    expect(bottom).toContain("line-30");
  });
});

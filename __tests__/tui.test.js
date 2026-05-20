import { SimpleTui } from "../src/lib/tui.js";

function stripAnsi(text) {
  return String(text || "").replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/g, "").replace(/\r/g, "");
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

function printableWidth(line) {
  return Array.from(String(line || "")).reduce((sum, ch) => {
    const cp = ch.codePointAt(0);
    return sum + (cp >= 0x2e80 && cp <= 0xa4cf ? 2 : 1);
  }, 0);
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

  test("layout adapter receives structured frame and owns teardown", () => {
    const out = createOut(80, 24);
    const layout = {
      frames: [],
      destroyed: false,
      render(frame) {
        this.frames.push(frame);
      },
      destroy() {
        this.destroyed = true;
      },
    };
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.event("[progress] checking the render path");
    tui.renderInput("hello", 5);

    expect(out.writes.join("")).not.toContain("\x1b[2J");
    expect(layout.frames.length).toBeGreaterThan(0);
    const last = layout.frames[layout.frames.length - 1];
    expect(last.workspaceLines.join("\n")).toContain("checking the render path");
    expect(last.inputLines.join("\n")).toContain("hello");
    expect(last.statusLine).toContain("Ready. Type /help for commands.");

    tui.stop();
    expect(layout.destroyed).toBe(true);
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

    const compactBatchLines = tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)").map(stripAnsi);
    const compactBatch = compactBatchLines.join("\n");
    expect(compactBatch).toContain("Read x2");
    expect(compactBatch).not.toContain("Tools Read x2");
    expect(compactBatchLines).toEqual(["› Read x2", "    a.txt", "    b.txt"]);
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
    const taskLine = rawFrame.split("\n").find((line) => stripAnsi(line).includes(`${tui.symbols.prompt} short task`));
    expect(taskLine).toBeTruthy();
    expect(taskLine).toMatch(new RegExp(`${tui.symbols.prompt} short task\\s+\\x1b\\[0m`));
    expect(stripAnsi(taskLine).length).toBe(out.columns - 2);
  });

  test("long task timeline rows remain expanded with background on every wrapped line", () => {
    const out = createOut(42, 24);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    const lines = tui.formatTimelineLines("[task] " + "alpha beta gamma delta epsilon zeta eta theta iota");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toContain("\x1b[1;37;48;5;236m");
      expect(line).toMatch(/\s+\x1b\[0m$/);
      expect(stripAnsi(line).length).toBe(out.columns - 2);
    }
    expect(stripAnsi(lines[0])).toContain(tui.symbols.prompt);
    expect(stripAnsi(lines[0])).not.toContain("Task:");
    expect(stripAnsi(lines[1])).not.toContain("Task:");
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
    tui.event("[tool-result] 1 file changed, 1 insertion(+), 1 deletion(-)");
    tui.event("[response] Done");

    expect(tui.timeline).toContain("");
    const plain = tui.timeline.map((line) => stripAnsi(line));
    const taskIdx = plain.findIndex((line) => line.includes("improve readability"));
    const toolIdx = plain.findIndex((line) => line.includes("Read"));
    const resultIdx = plain.findIndex((line) => line.includes("1 file changed"));
    const responseIdx = plain.findIndex((line) => line.includes("Done"));
    expect(plain[toolIdx - 1]).toBe("");
    expect(plain[resultIdx - 1]).not.toBe("");
    expect(plain[responseIdx - 1]).toBe("");
    expect(plain[resultIdx]).toMatch(/^\S/);
    expect(taskIdx).toBeLessThan(toolIdx);
  });

  test("timeline inserts breathing room between updates, tool batches, and responses", () => {
    const out = createOut(100, 32);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.event("[progress] I am checking the render path.");
    tui.event("[tools] read_file x2 - read_file(README.md); read_file(src/cli.js)");
    tui.event("[response] The render path is in src/lib/tui.js.");

    const plain = tui.timeline.map((line) => stripAnsi(line));
    const updateIdx = plain.findIndex((line) => line.includes("I am checking the render path."));
    const toolsIdx = plain.findIndex((line) => line.includes("Read x2"));
    const responseIdx = plain.findIndex((line) => line.includes("The render path is in src/lib/tui.js."));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(updateIdx);
    expect(responseIdx).toBeGreaterThan(toolsIdx);
    expect(plain[toolsIdx - 1]).toBe("");
    expect(plain[responseIdx - 1]).toBe("");
  });

  test("timeline does not duplicate identical consecutive done results", () => {
    const tui = new SimpleTui({
      out: createOut(100, 24),
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    const doneLine = "[result] done | time: 57s | tok ↑283k ↓2.4k";
    tui.event(doneLine);
    tui.event(doneLine);

    const doneRows = tui.timeline.map((line) => stripAnsi(line)).filter((line) => line.includes("done | time: 57s"));
    expect(doneRows).toEqual(["✓ done | time: 57s | tok ↑283k ↓2.4k"]);
  });

  test("timeline removes duplicate shell done rows after later events", () => {
    const tui = new SimpleTui({
      out: createOut(100, 24),
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.event("[result] shell done | time: 9s");
    tui.event("[result] shell done | time: 9s");
    tui.event("status: idle | model=test");

    const doneRows = tui.timeline.map((line) => stripAnsi(line)).filter((line) => line.includes("shell done | time: 9s"));
    expect(doneRows).toEqual(["✓ shell done | time: 9s"]);
  });

  test("rendered tool batch details keep indentation", () => {
    const out = createOut(100, 24);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[tools] read_file x2 - read_file(README.md); read_file(src/cli.js)");
    tui.renderInput("");

    const lines = latestFrame(out).split("\n").map((line) => stripAnsi(line));
    expect(lines.some((line) => /^ {4}README\.md/.test(line))).toBe(true);
    expect(lines.some((line) => /^ {4}src\/cli\.js/.test(line))).toBe(true);
  });

  test("restores saved session messages into the TUI timeline", () => {
    const tui = new SimpleTui({
      out: createOut(100, 32),
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.restoreSessionTimeline([
      { type: "message", role: "user", content: "previous request" },
      { type: "message", role: "assistant", content: "previous answer" },
    ]);

    const plain = tui.timeline.map((line) => stripAnsi(line)).join("\n");
    expect(plain).toContain(`${tui.symbols.prompt} previous request`);
    expect(plain).toContain("previous answer");
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
    expect(responseLines.slice(1).some((line) => /^\s{2,}\S/.test(line))).toBe(true);
  });

  test("wrapped response lists align continuation text under item body", () => {
    const out = createOut(36, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[response] 1. 这是一个很长的澄清选项，用来验证中文换行后不会错位");
    tui.render();
    const lines = latestFrame(out).split("\n");
    const first = lines.find((line) => line.includes("1."));
    const continuation = lines.find((line) => /^\s{7,}\S/.test(line));
    expect(first).toBeTruthy();
    expect(continuation).toBeTruthy();
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
    expect(stripAnsi(taskLineRaw)).toContain(`${tui.symbols.prompt} simplify repo`);
    expect(stripAnsi(taskLineRaw)).not.toContain("Task:");
    expect(taskLineRaw).toContain("\x1b[1;37;48;5;236m");
    expect(stripAnsi(taskLineRaw).length).toBe(out.columns - 2);
    const okIcon = tui.symbols.ok;
    const failIcon = tui.symbols.fail;
    expect(tui.formatTimelineLines("[model] seed-openai-compatible:doubao")).toEqual([]);
    expect(tui.formatTimelineLines("[plan] budget=3 - scoped plan")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines('[run] shell command="echo hi"')[0])).toContain("Shell echo hi");
    expect(tui.formatTimelineLines('[run] shell command="echo hi"')[0]).toContain("\x1b[36mShell\x1b[0m echo hi");
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
    expect(stripAnsi(tui.formatTimelineLines("[progress] Checking the UI path before editing")[0])).not.toContain("Update");
    const progressLine = tui.formatTimelineLines("[progress] Checking the UI path before editing")[0];
    expect(progressLine).not.toContain("\x1b[37mChecking the UI path before editing\x1b[0m");
    expect(progressLine).not.toContain("\x1b[2;37mChecking the UI path before editing\x1b[0m");
    expect(tui.formatTimelineLines("[tool] shell (echo hi)")).toEqual([]);
    expect(tui.formatTimelineLines("[tool] todo_write (3 todos)")).toEqual([]);
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (README.md)")[0])).not.toContain("Tool");
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (README.md)")[0])).toContain("Read README.md");
    expect(tui.formatTimelineLines("[tool] read_file (README.md)")[0]).toContain("\x1b[36mRead\x1b[0m README.md");
    expect(stripAnsi(tui.formatTimelineLines("[tool] rg (targetSymbol in *.js)")[0])).toContain("Search");
    expect(stripAnsi(tui.formatTimelineLines("[tool] rg (targetSymbol in *.js)")[0])).toContain("targetSymbol");
    expect(stripAnsi(tui.formatTimelineLines("[tool] read_file (path=README.md)")[0])).toContain("Read README.md");
    const readBatch = tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)").map(stripAnsi);
    expect(readBatch).toEqual(["› Read x2", "    a.txt", "    b.txt"]);
    expect(tui.formatTimelineLines("[tools] read_file x2 - read_file(a.txt); read_file(b.txt)")[0]).toContain(
      "\x1b[36mRead x2\x1b[0m"
    );
    expect(stripAnsi(tui.formatTimelineLines('[tool] rg (pattern="targetSymbol" path="src")')[0])).toContain("targetSymbol in src");
    expect(stripAnsi(tui.formatTimelineLines('[tool] read_files (paths=["a.txt","b.txt","c.txt","d.txt"])')[0])).toContain("a.txt, b.txt, c.txt +1");
    expect(stripAnsi(tui.formatTimelineLines("[result] done")[0])).toContain(`${okIcon} done`);
    expect(stripAnsi(tui.formatTimelineLines("[result] shell failed | time: 2s")[0])).toContain(
      `${failIcon} shell failed | time: 2s`
    );
    const toolResultLine = stripAnsi(tui.formatTimelineLines("[tool-result] 1 file changed, 1 insertion(+), 1 deletion(-)")[0]);
    expect(toolResultLine).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(toolResultLine.trim()).toMatch(/^(?:↳|->)\s+/);
    expect(toolResultLine).toMatch(/^\S/);
    expect(stripAnsi(tui.formatTimelineLines("[tool-result] Wrote 4481 bytes to index.html")[0])).toContain(
      "Wrote 4481 bytes to index.html"
    );
    const multiLineToolOutput = tui.formatTimelineLines("[tool-result] line one\nline two\n  nested");
    const plainMultiLineToolOutput = multiLineToolOutput.map((line) => stripAnsi(line));
    expect(plainMultiLineToolOutput).toEqual(["↳ line one", "    line two", "      nested"]);
    expect(plainMultiLineToolOutput.filter((line) => /^(?:↳|->)\s+/.test(line))).toHaveLength(1);
    expect(stripAnsi(
      tui.formatTimelineLines("[tool-result] Result too long (chars: 26343), saved to .piecode/shell/result-1.txt")[0]
    )).toContain("Output saved (26343 chars)");
    expect(stripAnsi(tui.formatTimelineLines("[help] title: PieCode command map")[0])).toContain("PieCode command map");
    expect(stripAnsi(tui.formatTimelineLines("[help] section: Model and runtime")[0])).toContain("Model and runtime");
    expect(stripAnsi(tui.formatTimelineLines("[help] item: /model, /model list - switch or inspect models")[0])).toContain(
      "/model, /model list - switch or inspect models"
    );
    expect(stripAnsi(tui.formatTimelineLines("[help] tip: type / to search commands")[0])).toContain(
      "tip: type / to search commands"
    );
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
    expect(stripAnsi(tui.formatTimelineLines("[thought] I should inspect files first")[0])).toContain("I should inspect files first");
    expect(stripAnsi(tui.formatTimelineLines("[thought] I should inspect files first")[0])).not.toContain("Thinking");
    expect(tui.formatTimelineLines("[thought] I should inspect files first")[0]).not.toContain(
      "\x1b[37mI should inspect files first\x1b[0m"
    );
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
    const rawCodeResponse = tui.formatTimelineLines("[response] ```js\nconst x = 1;\n```").join("\n");
    expect(rawCodeResponse).toContain("\x1b[1;35mconst\x1b[0m");
    expect(rawCodeResponse).toContain("\x1b[35m1\x1b[0m");
    const codeResponse = stripAnsi(rawCodeResponse);
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
    const rawJsonResponse = tui.formatTimelineLines("[response] ```json\n{\"ok\": true, \"count\": 2}\n```").join("\n");
    expect(rawJsonResponse).toContain("\x1b[1;34m\"ok\"\x1b[0m");
    expect(rawJsonResponse).toContain("\x1b[33mtrue\x1b[0m");
    const rawDiffResponse = tui.formatTimelineLines("[response] ```diff\n-old\n+new\n```").join("\n");
    expect(rawDiffResponse).toContain("\x1b[31m-old\x1b[0m");
    expect(rawDiffResponse).toContain("\x1b[32m+new\x1b[0m");
    const rawGitDiffToolResult = tui.formatTimelineLines([
      "[tool-result] diff --git a/file.js b/file.js",
      "index 1111111..2222222 100644",
      "--- a/file.js",
      "+++ b/file.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")).join("\n");
    expect(rawGitDiffToolResult).toContain("\x1b[31m-old\x1b[0m");
    expect(rawGitDiffToolResult).toContain("\x1b[32m+new\x1b[0m");
    expect(rawGitDiffToolResult).toContain("\x1b[1;36m@@ -1 +1 @@\x1b[0m");
    const rawLargeDiffToolResult = tui.formatTimelineLines([
      "[tool-result] diff --git a/file.js b/file.js",
      ...Array.from({ length: 100 }, (_v, idx) => `+line-${idx + 1}`),
    ].join("\n")).join("\n");
    expect(rawLargeDiffToolResult).toContain("more diff lines");
    expect(rawLargeDiffToolResult).toContain("\x1b[32m+line-1");
    expect(rawLargeDiffToolResult).not.toContain("+line-100");
    const hrResponse = stripAnsi(tui.formatTimelineLines("[response] before\n------\nafter").join("\n"));
    expect(hrResponse).toContain("before");
    expect(hrResponse).toContain("after");
    expect(hrResponse).not.toContain("------");
    const spacedResponse = stripAnsi(
      tui.formatTimelineLines("[response] 第一段\n\n1. 第一个选项\n\n2. 第二个选项").join("\n")
    );
    expect(spacedResponse).toContain(`${tui.symbols.response} 第一段\n1. 第一个选项\n2. 第二个选项`);
    expect(spacedResponse).not.toContain("    1. 第一个选项");
    const plainResponse = stripAnsi(tui.formatTimelineLines("[response] hello world")[0]);
    expect(plainResponse.trim()).toBe(`${tui.symbols.response} hello world`);
    expect(plainResponse).not.toContain("Assistant:");
    const boldResponse = stripAnsi(tui.formatTimelineLines("[response] this is **BOLD** text")[0]);
    expect(boldResponse).toContain("this is BOLD text");
    expect(boldResponse).not.toContain("**BOLD**");
    const highlightedResponseRaw = tui.formatTimelineLines("[response] this is ==highlighted **BOLD** text==").join("\n");
    const highlightedResponse = stripAnsi(highlightedResponseRaw);
    expect(highlightedResponse).toContain("this is highlighted BOLD text");
    expect(highlightedResponse).not.toContain("==");
    expect(highlightedResponseRaw).toContain("\x1b[30;43mhighlighted ");
    expect(highlightedResponseRaw).toContain("\x1b[30;43;1mBOLD");
    const richMarkdown = stripAnsi(
      tui.formatTimelineLines([
        "[response] ### Details",
        "- [x] done item",
        "  - nested item",
        "1. ordered item",
        "",
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
    expect(richMarkdown).toContain("  ◦ nested item");
    expect(richMarkdown).toContain("1. ordered item");
    expect(richMarkdown).not.toContain("• •");
    expect(richMarkdown).toContain("│ Name");
    expect(richMarkdown).toContain("alpha");
    const narrowTableLines = tui.formatTimelineLines([
      "[response] | Very long column heading | Count | Description |",
      "| --- | ---: | --- |",
      "| alpha beta gamma delta epsilon zeta | 12 | A long sentence that should not overflow the timeline width |",
    ].join("\n")).map((line) => stripAnsi(line));
    expect(narrowTableLines.join("\n")).toContain("…");
    for (const line of narrowTableLines.filter((line) => line.includes("│"))) {
      expect(printableWidth(line)).toBeLessThanOrEqual(out.columns - 2);
    }
    const nestedListMarkdown = stripAnsi(
      tui.formatTimelineLines([
        "[response] - level one",
        "  - level two",
        "    - level three",
        "      1. ordered level four",
        "        - [x] task level five",
      ].join("\n")).join("\n")
    );
    expect(nestedListMarkdown).toContain("• level one");
    expect(nestedListMarkdown).toContain("  ◦ level two");
    expect(nestedListMarkdown).toContain("    ▪ level three");
    expect(nestedListMarkdown).toContain("      1. ordered level four");
    expect(nestedListMarkdown).toContain("      [x] task level five");
    const nestedListWithOneSpaceIndent = stripAnsi(
      tui.formatTimelineLines([
        "[response] - Fruits",
        "  - Apples",
        "    - Granny Smith",
        "    - Honeycrisp",
        "- Vegetables",
        "  - Leafy greens",
      ].join("\n")).join("\n")
    );
    expect(nestedListWithOneSpaceIndent).toContain("• Fruits");
    expect(nestedListWithOneSpaceIndent).toContain(" ◦ Apples");
    expect(nestedListWithOneSpaceIndent).toContain("   ▪ Granny Smith");
    expect(nestedListWithOneSpaceIndent).toContain("   ▪ Honeycrisp");
    expect(nestedListWithOneSpaceIndent).toContain("• Vegetables");
    expect(nestedListWithOneSpaceIndent).toContain(" ◦ Leafy greens");
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
    expect(stripAnsi(frame)).toContain("LLM debug");
  });

  test("help overlay text renders immediately after startup content", () => {
    const out = createOut(80, 22);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.event("[banner-title-inline] Pie Code  let's cook");
    tui.event("[banner-meta] model: seed:model");
    tui.setStartupShortcutHint("keys: CTRL+L timeline/raw | CTRL+T todos | CTRL+O debug | /model switch | /help map");
    tui.start();
    tui.openOverlay(
      "PieCode command map",
      [
        "## PieCode command map",
        "",
        "### Essentials",
        "- `/help`, `/status`, `/clear`, `/compact`, `/exit` - session basics",
        "### Model and runtime",
        "- `/model`, `/model list` - switch or inspect models",
      ].join("\n"),
      { mode: "help", hint: " j/k: scroll  ctrl-f/b: page  q: close " }
    );

    const frame = latestFrame(out);
    expect(frame).toContain("PieCode command map");
    expect(frame).toContain("Essentials");
    expect(frame).toContain("/help, /status, /clear, /compact, /exit");
    expect(frame).toContain("Help");
    expect(frame).toContain("q: close");
    expect(frame).not.toContain("Pie Code  let's cook");
  });

  test("overlay status exposes scroll direction when debug content overflows", () => {
    const out = createOut(80, 12);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.openOverlay(
      "LLM Debug 1/1",
      Array.from({ length: 40 }, (_v, i) => `line-${i + 1}`).join("\n"),
      { mode: "llm-debug" }
    );
    expect(stripAnsi(latestFrame(out))).toContain("more:below");

    tui.scrollOverlayLines(10);
    const frame = stripAnsi(latestFrame(out));
    expect(frame).toContain("more:above");
    expect(frame).toContain("more:above | below");
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

  test("overlay search keeps the matched line visible after terminal height shrinks", () => {
    const out = createOut(80, 20);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const content = [
      ...Array.from({ length: 24 }, (_v, i) => `line-${i + 1}`),
      "needle-target",
      ...Array.from({ length: 20 }, (_v, i) => `tail-${i + 1}`),
    ].join("\n");
    tui.openOverlay("LLM Debug 1/1", content, { mode: "llm-debug" });
    tui.startOverlaySearch();
    tui.appendOverlaySearch("needle");
    expect(tui.submitOverlaySearch()).toBe(true);

    out.rows = 10;
    tui.render();

    const frame = latestFrame(out);
    expect(frame).toContain("needle-target");
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

  test("startup banner renders as scrollable workspace content", () => {
    const out = createOut(80, 22);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.event("[banner-title-inline] Pie Code  let's cook");
    tui.event("[banner-meta] model: seed:model");
    tui.event("[banner-meta] workspace: /tmp/work");
    tui.start();
    expect(tui.timeline.map(stripAnsi).join("\n")).toContain("Pie Code");
    const frame = latestFrame(out);
    expect(frame).toContain("Pie Code");
    expect(frame).toContain("workspace: /tmp/work");
  });

  test("startup banner scrolls away with later startup activity", () => {
    const out = createOut(80, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.event("[banner-title-inline] Pie Code  let's cook");
    tui.event("[banner-meta] model: seed:model");
    tui.event("[banner-meta] workspace: /tmp/work");
    for (let i = 1; i <= 24; i += 1) {
      tui.event(`init step ${i}`);
    }
    tui.start();

    const frame = latestFrame(out);
    expect(frame).not.toContain("Pie Code");
    expect(frame).toContain("init step 24");
    expect(frame.split("\n")[0]).not.toContain("Pie Code");
  });

  test("startup shortcut hint keeps cursor on typed prompt row", () => {
    const out = createOut(80, 22);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setStartupShortcutHint("keys: CTRL+L logs | CTRL+T todos");
    tui.renderInput("abc", 3);
    const lastWrite = out.writes[out.writes.length - 1] || "";
    const plainLines = latestFrame(out).split("\n");
    expect(latestFrame(out)).toContain("keys: CTRL+L logs | CTRL+T todos");
    const inputRow = plainLines.findIndex((line) => line.includes(`${tui.symbols.prompt} abc`)) + 1;
    expect(inputRow).toBeGreaterThan(0);
    expect(tui.lastInputRow).toBe(inputRow);
    expect(lastWrite).toContain(`\x1b[${inputRow};7H`);
  });

  test("clarification prompt reserves rows above input without moving cursor into choices", () => {
    const out = createOut(72, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setClarificationPrompt({
      question: "Choose mode",
      options: [{ label: "Fast" }, { label: "Safe", description: "run more checks" }],
      index: 1,
      selected: new Set(),
      multiple: false,
    });
    tui.renderInput("answer", 6);
    const frame = latestFrame(out);
    const lines = frame.split("\n");
    const promptRow = lines.findIndex((line) => line.includes(`${tui.symbols.prompt} answer`)) + 1;
    const choiceRow = lines.findIndex((line) => line.includes("Safe - run more checks")) + 1;
    expect(choiceRow).toBeGreaterThan(0);
    expect(promptRow).toBeGreaterThan(choiceRow);
    expect(tui.lastInputRow).toBe(promptRow);
    expect(out.writes[out.writes.length - 1]).toContain(`\x1b[${promptRow};10H`);
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
    expect((frame.match(/[-─]{10,}/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(frame).not.toContain("status:");
    expect(frame).not.toContain("llm:");
    expect(frame).not.toContain("view:");
    expect(frame).not.toContain("todos:");
    expect(frame).not.toContain("TODO(");
  });

  test("status redraw covers full terminal height and does not keep old status rows", () => {
    const out = createOut(80, 14);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.onToolUse("edit_file");
    tui.render("", "thinking...");
    const raw = out.writes[out.writes.length - 1] || "";
    const frame = stripAnsi(raw);
    expect(frame.split("\n").length).toBeGreaterThanOrEqual(out.rows);
    expect(frame).toContain("thinking...");
    expect(frame).not.toContain("Using tool: edit_file");
  });

  test("thinking animation is disabled by default to avoid idle full-screen flicker", () => {
    withEnv("PIECODE_TUI_ANIMATION", null, () => {
      const out = createOut(80, 14);
      const tui = new SimpleTui({
        out,
        workspaceDir: "/tmp/work",
        providerLabel: () => "seed:model",
        getSkillsLabel: () => "none",
        getApprovalLabel: () => "off",
      });

      tui.start();
      tui.onThinking("tool");
      expect(tui.thinking).toBe(true);
      expect(tui.thinkingTimer).toBeNull();
      expect(tui.progressRefreshTimer).toBeTruthy();
      tui.stop();
    });
  });

  test("frame separators can use ascii when requested", () => {
    withEnv("PIECODE_TUI_ASCII", "1", () => {
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
      expect(raw).toContain("----------");
      expect(raw).not.toContain("─");
    });
  });

  test("frame separators use unicode by default in utf8 terminals", () => {
    withEnv("PIECODE_TUI_ASCII", null, () => {
      withEnv("PIECODE_TUI_UNICODE", null, () => {
        withEnv("TERM", "xterm-256color", () => {
          const out = createOut(80, 18);
          const tui = new SimpleTui({
            out,
            workspaceDir: "/tmp/work",
            providerLabel: () => "seed:model",
            getSkillsLabel: () => "none",
            getApprovalLabel: () => "off",
          });

          tui.start();
          tui.renderInput("");
          const raw = out.writes.join("");
          expect(raw).toContain("──────────");
        });
      });
    });
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
    const frame = stripAnsi(out.writes[out.writes.length - 1] || "");
    const width = out.columns - 1;
    for (const line of frame.split("\n")) {
      expect(printableWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("narrow terminals use a denser status summary while preserving key cues", () => {
    const out = createOut(68, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setContextUsage(88, 100);
    tui.setTodos([{ id: "todo-1", content: "step", status: "completed" }]);
    tui.setGoalStatus({ active: true, label: "optimize UI design in tui", iteration: 2, maxIterations: 4, status: "continue" });
    tui.setPlanMode(true);
    tui.renderInput("!echo hi", 8);

    const frame = latestFrame(out);
    expect(frame).toContain("ctx:88/100(88%)");
    expect(frame).toContain("Task completed");
    expect(frame).toContain("Goal: Running · optimize UI design in tui · 2/4 · 50%");
    expect(frame).not.toContain("goal:continue");
    expect(frame).not.toContain("mode:bash");
    expect(frame).not.toContain("plan:on");
  });

  test("wide status row exposes approval and avoids duplicate mode labels", () => {
    const out = createOut(120, 24);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "on",
    });

    tui.start();
    tui.renderInput("!echo hi", 8);

    const frame = stripAnsi(latestFrame(out));
    expect(frame).toContain("approve:on");
    expect(frame.match(/mode:bash/g)).toHaveLength(1);
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

  test("active goal renders before input and terminal goals move to timeline", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setGoalStatus({
      active: true,
      label: "add goal status indicator",
      iteration: 2,
      maxIterations: 5,
      status: "continue",
    });
    let frame = latestFrame(out);
    expect(frame).toContain("Goal: Running · add goal status indicator · 2/5 · 40%");
    expect(frame).not.toContain("goal:continue");

    tui.onThinking("turn");
    frame = latestFrame(out);
    expect(frame.indexOf("Goal: Running · add goal status indicator")).toBeLessThan(frame.indexOf("thinking"));
    expect(frame.indexOf("thinking")).toBeLessThan(frame.indexOf("❯"));
    tui.onThinkingDone();

    tui.setGoalStatus({
      active: true,
      label: "add goal status indicator",
      iteration: 5,
      maxIterations: 5,
      status: "complete",
    });
    frame = latestFrame(out);
    expect(frame).toContain(`${tui.symbols.ok} Goal: Done · add goal status indicator · 5/5 · 100%`);
    {
      const lines = tui.timeline.map((line) => stripAnsi(line));
      const doneLineIndex = lines.findIndex((line) => line.includes("Goal: Done · add goal status indicator"));
      expect(doneLineIndex).toBeGreaterThan(0);
      expect(lines[doneLineIndex - 1].trim()).toBe("");
    }
    expect(frame).not.toMatch(/Goal: Done · add goal status indicator · 5\/5 · 100%\s*\n[-─]+\s*\n\s*❯/);
    expect(frame).not.toContain("goal:complete");

    tui.setGoalStatus(null);
    frame = latestFrame(out);
    expect(frame).toContain(`${tui.symbols.ok} Goal: Done · add goal status indicator · 5/5 · 100%`);
    expect(frame).not.toContain("goal:");
  });

  test("goal events render visibly and duplicate active status avoids repaint", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[goal] loop started (max 9 turns)");
    tui.event("[goal] status=continue turn=2/9");
    tui.event("[goal] status=complete turn=9/9");
    tui.render();
    let frame = stripAnsi(latestFrame(out));
    expect(frame).toContain("Goal loop started max 9 turns");
    expect(frame).toContain("Goal Running 2/9");
    expect(frame).not.toContain("Goal Done 9/9");

    tui.setGoalStatus({ active: true, label: "ship goal mode", iteration: 2, maxIterations: 9, status: "continue" });
    const writesAfterFirst = out.writes.length;
    tui.setGoalStatus({ active: true, label: "ship goal mode", iteration: 2, maxIterations: 9, status: "continue" });
    expect(out.writes).toHaveLength(writesAfterFirst);

    frame = stripAnsi(latestFrame(out));
    expect(frame).toContain("Goal: Running · ship goal mode · 2/9 · 22%");
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
    expect(frame).toContain("create a small CLI calculator");
    expect(frame).toContain("Using tool: write_file");
    expect(frame).not.toContain("Done");
    let rawTaskContextLine = (out.writes[out.writes.length - 1] || "")
      .split("\n")
      .find((line) => stripAnsi(line).includes(`${tui.symbols.prompt} create a small CLI calculator ·`));
    expect(rawTaskContextLine).toBeUndefined();

    for (let i = 0; i < 30; i += 1) {
      tui.event(`[progress] step ${i}`);
    }
    tui.renderInput("");
    frame = latestFrame(out);
    rawTaskContextLine = (out.writes[out.writes.length - 1] || "")
      .split("\n")
      .find((line) => stripAnsi(line).includes(`${tui.symbols.prompt} create a small CLI calculator ·`));
    expect(rawTaskContextLine).toContain("\x1b[1;37;48;5;236m");
    expect(stripAnsi(rawTaskContextLine)).toContain(`${tui.symbols.prompt} create a small CLI calculator`);
    expect(stripAnsi(rawTaskContextLine).length).toBe(out.columns - 2);

    tui.onTurnSuccess(1234);
    frame = latestFrame(out);
    expect(frame).toContain(`${tui.symbols.prompt} Done · create a small CLI calculator`);
    rawTaskContextLine = (out.writes[out.writes.length - 1] || "")
      .split("\n")
      .find((line) => stripAnsi(line).includes(`${tui.symbols.prompt} Done · create a small CLI calculator`));
    expect(rawTaskContextLine).toContain("\x1b[1;37;48;5;236m");
    expect(stripAnsi(rawTaskContextLine).length).toBe(out.columns - 2);
  });

  test("task context stays hidden when the visible timeline task wraps", () => {
    const out = createOut(72, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });
    const task =
      "Create a single-file browser Snake game in index.html with keyboard controls score restart and dark arcade styling";

    tui.start();
    tui.event(`[task] ${task}`);
    tui.onToolUse("write_file");

    const frame = stripAnsi(latestFrame(out));
    expect(frame).toContain(`${tui.symbols.prompt} Create a single-file browser Snake game`);
    expect(frame).toContain("controls score restart and dark arcade styling");
    expect(frame).not.toContain("Task:");
  });

  test("hidden task context rows are reclaimed while thinking", () => {
    const out = createOut(80, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.event("[task] optimize piecode tui workflow rows");
    for (let i = 1; i <= 8; i += 1) {
      tui.event(`line-${i}`);
    }
    tui.onThinking("turn");

    const frame = latestFrame(out);
    expect(frame).toContain(`${tui.symbols.prompt} optimize piecode tui workflow rows`);
    expect(frame).toContain("line-1");
    expect(frame).toContain("line-8");
    expect(frame).not.toContain("Task:");
    expect(tui.lastScrollMax).toBe(0);
    expect(tui.lastFrameLineCount).toBeLessThanOrEqual(out.rows);
    tui.stop();
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
    expect(frame).toContain(`${tui.symbols.prompt} Failed · inspect repo`);
  });

  test("running indicator is rendered before the input while thinking", () => {
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
    expect(frame).toContain(`${tui.symbols.prompt} inspect repo`);
    expect(frame).toContain("thinking");
    const lines = frame.split("\n").map((line) => stripAnsi(line));
    const thinkingLineIndex = lines.findIndex((line) => line.includes("thinking"));
    const taskLineIndex = lines.findIndex((line) => line.includes(`${tui.symbols.prompt} inspect repo`));
    const inputLineIndex = lines.findIndex((line) => line.includes("继续描述你想改什么"));
    const relevantLines = lines.filter((line) => line.includes("thinking") || line.includes(`${tui.symbols.prompt} inspect repo`) || line.includes("继续描述你想改什么"));
    expect(relevantLines[0]).toContain(`${tui.symbols.prompt} inspect repo`);
    expect(thinkingLineIndex).toBeLessThan(inputLineIndex);
    expect(thinkingLineIndex).toBeGreaterThan(taskLineIndex + 1);
    expect(lines[thinkingLineIndex - 1].trim()).toBe("");
    expect(lines[thinkingLineIndex + 1]).toMatch(/[-─]{8,}/);
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

  test("tool progress prefers one durable run entry while live thoughts remain transient", () => {
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

    tui.event("[run] read file src/lib/tui.js");
    tui.render();
    frame = latestFrame(out);
    const timeline = tui.timeline.map(stripAnsi).join("\n");
    expect(timeline).toContain("Read src/lib/tui.js");
    expect(timeline).not.toContain("about to read");
    expect(frame).toContain("Read src/lib/tui.js");

    tui.clearLiveThought();
    frame = latestFrame(out);
    expect(tui.thoughtStreamVisible).toBe(false);
    expect(tui.timeline.map(stripAnsi).join("\n")).toContain("Read src/lib/tui.js");
    tui.stop();
  });

  test("running indicator shows stale activity age", () => {
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
    tui.lastActivityAt = Date.now() - 15000;
    tui.lastActivityLabel = "tool write_file";
    tui.render();

    const frame = stripAnsi(latestFrame(out));
    expect(frame).toContain("last update");
    expect(frame).toContain("tool write_file");
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

  test("command suggestions hide text below the status bar", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setStartupShortcutHint("keys: CTRL+L logs | CTRL+T todos");
    tui.setInputHint("Press CTRL+D again to exit.");
    tui.setCommandSuggestions(["/model", "/model list"], 0);

    const frame = latestFrame(out);
    expect(frame).toContain("commands");
    expect(frame).toContain("> /model");
    expect(frame).toContain("Ready. Type /help for commands.");
    expect(frame).not.toContain("keys: CTRL+L logs | CTRL+T todos");
    expect(frame).not.toContain("Press CTRL+D again to exit.");
  });

  test("command suggestions are viewport-limited on short terminals to keep the prompt visible", () => {
    const out = createOut(80, 12);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("/", 1);
    tui.setCommandSuggestions([
      "/help",
      "/model",
      "/model list",
      "/mcp",
      "/skills",
      "/plugins",
      "/plan",
      "/goal",
      "/resume",
      "/sessions",
      "/clear",
      "/exit",
    ], 0);

    const frame = latestFrame(out);
    expect(tui.lastInputRow).toBeLessThanOrEqual(out.rows);
    expect(frame).toContain(`${tui.symbols.prompt} /`);
    expect(frame).toContain("commands");
    expect(frame).not.toContain("/exit");
  });

  test("full-frame repaint never exceeds terminal height when bottom chrome is tall", () => {
    const out = createOut(80, 12);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setStartupShortcutHint("keys: CTRL+L logs | CTRL+T todos");
    tui.setInputHint("Press CTRL+D again to exit.");
    tui.renderInput("/", 1);
    tui.setCommandSuggestions([
      "/help",
      "/model",
      "/model list",
      "/mcp",
      "/skills",
      "/plugins",
      "/plan",
      "/goal",
      "/resume",
      "/sessions",
      "/clear",
      "/exit",
    ], 0);

    const frame = latestFrame(out);
    expect(frame.split("\n")).toHaveLength(out.rows);
    expect(frame).toContain(`${tui.symbols.prompt} /`);
    expect(out.writes[out.writes.length - 1]).toContain(`\x1b[${tui.lastInputRow};5H`);
  });

  test("command suggestions keep the selected item visible when the chosen index exceeds the first viewport", () => {
    const out = createOut(80, 12);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.renderInput("/", 1);
    tui.setCommandSuggestions([
      "/help",
      "/model",
      "/model list",
      "/mcp",
      "/skills",
      "/plugins",
      "/plan",
      "/goal",
      "/resume",
      "/sessions",
      "/clear",
      "/exit",
    ], 10);

    const frame = latestFrame(out);
    expect(frame).toContain("> /clear");
    expect(frame).not.toContain("> /help");
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
    expect(raw).toContain(`\x1b[${tui.lastInputRow};8H\x1b[?25h`);
  });

  test("input cursor stays off input wrap boundary to avoid terminal auto-wrap", () => {
    const out = createOut(40, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const input = "a".repeat(34);
    tui.renderInput(input, input.length);
    const raw = out.writes[out.writes.length - 1] || "";
    expect(tui.lastInputLine.split("\n")).toHaveLength(1);
    expect(raw).toContain(`\x1b[${tui.lastInputRow};37H\x1b[?25h`);
    expect(raw).not.toContain(`\x1b[${tui.lastInputRow};38H\x1b[?25h`);
  });

  test("emoji grapheme clusters do not over-count cursor columns", () => {
    const out = createOut(80, 18);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    const input = "👨‍👩‍👧‍👦❤️";
    tui.renderInput(input, input.length);
    const raw = out.writes[out.writes.length - 1] || "";
    expect(tui.lastInputLine).toContain(input);
    expect(raw).toContain(`\x1b[${tui.lastInputRow};8H\x1b[?25h`);
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
    expect(raw.startsWith("\x1b[?25l\x1b%G\x1b(B\x1b[0m\x1b[2J\x1b[H")).toBe(true);
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

  test("scroll renders reuse wrapped timeline cache until content or width changes", () => {
    const out = createOut(80, 16);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed/model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    for (let i = 1; i <= 80; i += 1) {
      tui.event(`line-${i} ${"wrapped ".repeat(20)}`);
    }
    tui.render("");
    const initialCache = tui.wrappedTimelineCache.lines;
    expect(initialCache.length).toBeGreaterThan(tui.timeline.length);

    tui.scrollLines(1);
    expect(tui.wrappedTimelineCache.lines).toBe(initialCache);

    out.columns = 72;
    tui.scrollLines(1);
    const resizedCache = tui.wrappedTimelineCache.lines;
    expect(resizedCache).not.toBe(initialCache);

    tui.event("new-line after cache");
    tui.render("");
    expect(tui.wrappedTimelineCache.lines).not.toBe(resizedCache);
  });
});

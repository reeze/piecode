import { PassThrough, Writable } from "node:stream";
import stripAnsi from "strip-ansi";
import { InkTuiLayout } from "../src/lib/inkLayout.js";
import { SimpleTui } from "../src/lib/tui.js";

class CaptureOutput extends Writable {
  constructor({ columns = 40, rows = 10 } = {}) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(String(chunk));
    callback();
  }

  text() {
    return this.chunks.join("");
  }
}

function createInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  return input;
}

function getCursorTarget(raw) {
  const absoluteMatches = [...String(raw).matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)];
  const absoluteMatch = absoluteMatches.at(-1);
  if (absoluteMatch) {
    const beforeCursor = raw.slice(0, absoluteMatch.index);
    const lastClear = beforeCursor.lastIndexOf("\x1b[2J");
    const lastHome = beforeCursor.lastIndexOf("\x1b[H");
    const lastSync = beforeCursor.lastIndexOf("\x1b[?2026h");
    const start = Math.max(
      lastClear >= 0 ? lastClear + "\x1b[2J".length : 0,
      lastHome >= 0 ? lastHome + "\x1b[H".length : 0,
      lastSync >= 0 ? lastSync + "\x1b[?2026h".length : 0
    );
    const lines = stripAnsi(beforeCursor.slice(start)).split("\n").map((line) => line.replace(/\r/g, ""));
    while (lines.at(-1) === "") lines.pop();
    return {
      y: Number(absoluteMatch[1]) - 1,
      col: Number(absoluteMatch[2]),
      lines,
    };
  }

  const matches = [...String(raw).matchAll(/\x1b\[(\d+)A\x1b\[(\d+)G\x1b\[\?25h/g)];
  const match = matches.at(-1);
  if (!match) return null;
  const beforeCursor = raw.slice(0, match.index);
  const lines = stripAnsi(beforeCursor).split("\n");
  while (lines.at(-1) === "") lines.pop();
  return {
    y: lines.length - Number(match[1]),
    col: Number(match[2]),
    lines,
  };
}

function findPromptLineIndex(lines) {
  return lines.findIndex((line) => /\s(?:>|❯)\s/.test(line));
}

async function waitForCursor(output, predicate = () => true) {
  for (let i = 0; i < 30; i += 1) {
    const cursor = getCursorTarget(output.text());
    if (cursor && predicate(cursor)) return cursor;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getCursorTarget(output.text());
}

describe("InkTuiLayout", () => {
  test("positions cursor on the input line in the first frame", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 40, rows: 10 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.renderInput("", 0);

    const cursor = await waitForCursor(output);
    const inputLineIndex = cursor.lines.findIndex((line) => line.includes("继续描述你想改什么"));
    expect(cursor.lines[0]).toHaveLength(output.columns - 1);
    expect(cursor).toMatchObject({ y: inputLineIndex, col: 4 });
    tui.stop();
  });

  test("keeps input next to short content instead of pinning it to the bottom", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 30, rows: 12 });
    const layout = new InkTuiLayout({ input, output, error: output });

    layout.render({
      workspaceLines: ["one", "two"],
      inputLines: ["ask"],
      statusLine: "idle",
      hintLine: "",
      separatorGlyph: "-",
      cursorRowOffset: 0,
      cursorCol: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renderedLines = stripAnsi(output.text()).replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
    expect(renderedLines).toEqual(expect.arrayContaining(["one", "two"]));
    const cursor = getCursorTarget(output.text());
    const inputLineIndex = cursor.lines.findIndex((line) => line.trimEnd() === "ask");
    expect(cursor).toMatchObject({ y: inputLineIndex, col: 2 });
    layout.destroy();
  });

  test("prefers native structured sections over legacy raw frame lines", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 40, rows: 12 });
    const layout = new InkTuiLayout({ input, output, error: output });

    layout.render({
      frameLines: ["legacy duplicated prompt"],
      workspaceLines: ["workspace event"],
      inputLines: ["ask here"],
      statusLine: "idle",
      hintLine: "hint",
      separatorGlyph: "-",
      cursorRowOffset: 0,
      cursorCol: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const plain = stripAnsi(output.text());
    expect(plain).toContain("workspace event");
    expect(plain).toContain("ask here");
    expect(plain).not.toContain("legacy duplicated prompt");
    layout.destroy();
  });

  test("keeps raw frame rendering isolated to explicit rawFrame mode", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 40, rows: 12 });
    const layout = new InkTuiLayout({ input, output, error: output });

    layout.render({
      mode: "rawFrame",
      frameLines: ["overlay title", "overlay body"],
      workspaceLines: ["workspace event"],
      inputLines: ["ask here"],
      cursorRow: 2,
      cursorCol: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const plain = stripAnsi(output.text());
    expect(plain).toContain("overlay title");
    expect(plain).toContain("overlay body");
    expect(plain).not.toContain("workspace event");
    expect(plain).not.toContain("ask here");
    layout.destroy();
  });

  test("keeps approval prompts visible above input even when workspace output overflows", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 52, rows: 10 });
    const layout = new InkTuiLayout({ input, output, error: output });

    layout.render({
      workspaceLines: Array.from({ length: 30 }, (_v, index) => `workspace line ${index + 1}`),
      attentionLines: ["! action needed", "? approval required", "q: Approve shell command?", "$ npm test", "y:once n:deny"],
      inputLines: ["❯ "],
      statusLine: "Awaiting approval | approve:off",
      hintLine: "",
      separatorGlyph: "-",
      cursorRowOffset: 0,
      cursorCol: 4,
    });
    const cursor = await waitForCursor(output, (candidate) => candidate.lines.some((line) => line.includes("approval required")));
    const plain = cursor.lines.join("\n");
    expect(plain).toContain("approval required");
    expect(plain).toContain("Approve shell command");
    expect(plain).toContain("npm test");
    expect(plain).toContain("Awaiting approval");
    expect(plain).toContain("workspace line 30");
    expect(plain).not.toContain("workspace line 1");
    expect(cursor.y).toBe(cursor.lines.findIndex((line) => line.includes("❯")));
    layout.destroy();
  });

  test("clears stale bottom rows when command suggestions disappear", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 48, rows: 14 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.setCommandSuggestions(["/help", "/status", "/skills commands"], 1);
    await waitForCursor(output, (candidate) => candidate.lines.some((line) => line.includes("/skills commands")));

    tui.clearCommandSuggestions();
    const cursor = await waitForCursor(output, (candidate) => !candidate.lines.some((line) => line.includes("/skills commands")));
    expect(cursor.lines.join("\n")).not.toContain("/skills commands");
    expect(cursor.lines.findIndex((line) => line.includes("❯") || line.includes("> "))).toBe(cursor.y);
    layout.destroy();
  });

  test("pads shortened command suggestion lines so old text is overwritten", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 48, rows: 14 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.setCommandSuggestions(["/very-long-command-name"], 0);
    await waitForCursor(output, (candidate) => candidate.lines.some((line) => line.includes("/very-long-command-name")));

    tui.setCommandSuggestions(["/h"], 0);
    const cursor = await waitForCursor(output, (candidate) =>
      candidate.lines.some((line) => line.includes("> /h")) &&
      !candidate.lines.some((line) => line.includes("/very-long-command-name"))
    );
    const plain = cursor.lines.join("\n");
    expect(plain).toContain("> /h");
    expect(plain).not.toContain("very-long-command-name");
    layout.destroy();
  });

  test("renders the startup banner in the first frame and keeps input row stable after typing", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 72, rows: 18 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.event("[banner-title-inline] Pie Code let's cook");
    tui.event("[banner-meta] model: test:model");
    tui.event("[banner-meta] workspace: /tmp/work");
    tui.event("[banner-hint] keys: CTRL+L logs | CTRL+T todos");
    tui.setContextUsage(0, 256000);
    tui.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    let frameLines = layout.frame.frameLines.map((line) => stripAnsi(line));
    let inputLineIndex = frameLines.findIndex((line) => line.includes("> ") || line.includes("❯ "));
    expect(frameLines.join("\n")).toContain("Pie Code");
    expect(frameLines.join("\n")).toContain("keys: CTRL+L logs");
    expect(inputLineIndex).toBeGreaterThan(0);
    expect(inputLineIndex).toBeLessThan(10);
    expect(layout.frame.cursorRow).toBe(inputLineIndex + 1);
    let cursor = await waitForCursor(output);
    let renderedInputLineIndex = findPromptLineIndex(cursor.lines);
    expect(cursor.y).toBe(renderedInputLineIndex);
    const firstInputLineIndex = inputLineIndex;

    tui.renderInput("中文 abc", 6);
    for (let i = 0; i < 20 && !output.text().includes("中文 abc"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    frameLines = layout.frame.frameLines.map((line) => stripAnsi(line));
    inputLineIndex = frameLines.findIndex((line) => line.includes("中文 abc"));
    expect(inputLineIndex).toBe(firstInputLineIndex);
    expect(layout.frame.cursorRow).toBe(inputLineIndex + 1);
    cursor = await waitForCursor(output, (candidate) =>
      candidate.lines.some((line) => line.includes("中文 abc"))
    );
    renderedInputLineIndex = cursor.lines.findIndex((line) => line.includes("中文 abc"));
    expect(cursor.y).toBe(renderedInputLineIndex);
    expect(output.text()).toContain("中文 abc");
    layout.destroy();
  });

  test("keeps cursor on input row when startup hint rows appear and disappear", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 72, rows: 18 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.event("[banner-hint] keys: CTRL+L logs | CTRL+T todos");
    tui.renderInput("", 0);
    let cursor = await waitForCursor(output);
    let inputLineIndex = findPromptLineIndex(cursor.lines);
    expect(cursor.y).toBe(inputLineIndex);

    tui.beginTurn();
    tui.event("[response] " + "中文内容 ".repeat(30));
    tui.onTurnSuccess(48300);
    tui.renderInput("", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    cursor = await waitForCursor(output);
    inputLineIndex = findPromptLineIndex(cursor.lines);
    expect(cursor.y).toBe(inputLineIndex);
    expect(cursor.lines[cursor.y - 1] || "").toMatch(/[-─]{8,}/);
    expect(cursor.lines[cursor.y] || "").toMatch(/\s(?:>|❯)\s/);
    layout.destroy();
  });

  test("keeps cursor on input row while a turn is running with thinking status", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 56, rows: 24 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.setContextUsage(45000, 256000);
    tui.beginTurn();
    tui.event("[task] 看看为什么web版本现在不可用了");
    tui.event("[response] 日志读取被大文件截断了；我会先看 web 服务日志末尾和服务入口的关键路由。");
    tui.event("[tool] rg (createServer|listen\\(|/api/|text/event-stream|sendEvent|route|public|static in src/web/server.js (ignore-case))");
    tui.event("[response] 日志读取被大文件截断了；我会先看 web 服务日志末尾和服务入口的关键路由。");
    tui.event("[tool] read_file (src/web/public/app.js)");
    tui.onThinking("turn");
    tui.setLiveThought("Working...");
    tui.renderInput("", 0);

    const cursor = await waitForCursor(output, (candidate) =>
      candidate.lines.some((line) => line.includes("thinking:turn")) &&
      candidate.lines.some((line) => line.includes("继续描述你想改什么"))
    );
    const inputLineIndex = cursor.lines.findIndex((line) => line.includes("继续描述你想改什么"));
    const thinkingLineIndex = cursor.lines.findIndex((line) => line.includes("thinking:turn"));
    expect(cursor.y).toBe(inputLineIndex);
    expect(thinkingLineIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingLineIndex).toBeLessThan(inputLineIndex);
    expect(cursor.lines[thinkingLineIndex - 1]?.trim() || "").toBe("");
    expect(cursor.lines[thinkingLineIndex + 1] || "").toMatch(/[-─]{8,}/);
    expect(cursor.lines[cursor.y - 1] || "").toMatch(/[-─]{8,}/);
    expect(cursor.lines[cursor.y + 1] || "").toMatch(/[-─]{8,}/);
    expect(cursor.lines[cursor.y] || "").toMatch(/\s(?:>|❯)\s/);
    layout.destroy();
  });

  test("does not duplicate the empty prompt after a completed turn", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 72, rows: 18 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.start();
    tui.beginTurn();
    tui.event("[task] 测试一下有没有问题");
    tui.event("[response] 我会先跑现有测试。");
    tui.onTurnSuccess(18200);
    tui.renderInput("", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frameLines = layout.frame.frameLines.map((line) => stripAnsi(line));
    const promptLines = frameLines.filter((line) => line.includes("继续描述你想改什么"));
    expect(promptLines).toHaveLength(1);
    expect(layout.frame.cursorRow).toBe(frameLines.findIndex((line) => line.includes("继续描述你想改什么")) + 1);
    layout.destroy();
  });

  test("startup banner does not leave a second stale screen centered after input rerenders", async () => {
    const input = createInput();
    const output = new CaptureOutput({ columns: 72, rows: 18 });
    const layout = new InkTuiLayout({ input, output, error: output });
    const tui = new SimpleTui({
      out: output,
      workspaceDir: "/tmp/work",
      providerLabel: () => "test:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
      layout,
    });

    tui.event("[banner-title-inline] Pie Code let's cook");
    tui.event("[banner-meta] model: test:model");
    tui.event("[banner-meta] workspace: /tmp/work");
    tui.start();
    tui.renderInput("fix startup ui", 14);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cursor = await waitForCursor(output, (candidate) =>
      candidate.lines.some((line) => line.includes("fix startup ui"))
    );
    const plain = cursor.lines.join("\n");
    const pieCodeMatches = plain.match(/Pie Code/g) || [];
    expect(pieCodeMatches).toHaveLength(1);

    const inputLineIndex = cursor.lines.findIndex((line) => line.includes("fix startup ui"));
    expect(cursor.y).toBe(inputLineIndex);
    layout.destroy();
  });
});

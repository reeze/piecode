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

describe("tui usability", () => {
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
    expect(stripAnsi(tui.formatTimelineLines("[result] done")[0])).toContain("✓ done");
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
    expect(plainResponse).toBe("hello world");
    expect(plainResponse).not.toContain("Assistant:");
  });

  test("LLM debug panel appears only in raw log view when CTRL+O is enabled", () => {
    const out = createOut();
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setLlmDebugEnabled(true);
    tui.setLlmRequest("[turn] request payload");
    tui.setLlmResponse("[turn] response payload");

    let frame = latestFrame(out);
    expect(frame).not.toContain("LLM I/O DEBUG");

    tui.toggleLogPanel();
    frame = latestFrame(out);
    expect(frame).toContain("LLM I/O DEBUG");
    expect(frame).toContain("request:");
    expect(frame).toContain("request payload");
    expect(frame).toContain("response:");
    expect(frame).toContain("response payload");
  });

  test("cursor anchors to input row after toggling LLM debug", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setLlmDebugEnabled(true);
    tui.setLlmDebugEnabled(false);
    tui.renderInput("abc");

    const lastWrite = out.writes[out.writes.length - 1] || "";
    expect(lastWrite).toContain(`\x1b[${tui.lastInputRow};`);
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
    expect(lastWrite).toContain("↩");
  });

  test("model suggestions render between prompt and status with selection indicator", () => {
    const out = createOut(100, 28);
    const tui = new SimpleTui({
      out,
      workspaceDir: "/tmp/work",
      providerLabel: () => "seed:model",
      getSkillsLabel: () => "none",
      getApprovalLabel: () => "off",
    });

    tui.start();
    tui.setModelSuggestions(["openai/gpt-4.1-mini", "anthropic/claude-3.7-sonnet"], 1);
    const frame = latestFrame(out);
    expect(frame).toContain("models");
    expect(frame).toContain("> anthropic/claude-3.7-sonnet");
    expect(frame).toContain("openai/gpt-4.1-mini");
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

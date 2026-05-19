import { promises as fs } from "node:fs";

describe("web app approval and clarification contract", () => {
  test("timeline hides model call cards unless detail mode is enabled", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");

    expect(script).toContain('if (item.kind === "model" && !state.status.detailMode) return "";');
  });

  test("tool thinking is rendered outside the collapsible details", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");

    expect(script).toContain('const note = String(item.note || item.thought || item.reason || "").trim();');
    expect(script).toContain('<section class="tool-wrap');
    expect(script).toContain('${note ? `<div class="tool-note">${escapeHtml(note)}</div>` : ""}');
    expect(script).not.toContain("<span>Thinking</span>");
    expect(script).not.toContain('${note ? `<div class="tool-reason">${escapeHtml(note)}</div>` : ""}');
  });

  test("frontend listens for clarification events and posts answers to the API", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");

    expect(script).toContain('"clarification.request"');
    expect(script).toContain('"clarification.resolved"');
    expect(script).toContain('data-clarification=');
    expect(script).toContain('postJson("/api/clarifications"');
    expect(script).toContain("selectedIndexes");
  });

  test("approval clicks optimistically remove pending cards before posting decisions", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");
    const handlerStart = script.indexOf("async function handleApprovalClick");
    const handlerEnd = script.indexOf("el.approvalList.addEventListener", handlerStart);
    const handler = script.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain("state.approvals = state.approvals.filter((item) => item.id !== id)");
    expect(handler).toContain("renderApprovals();");
    expect(handler).toContain('postJson("/api/approvals", { id, decision: button.dataset.decision })');
  });

  test("slash suggestions resync composer send state after programmatic insertion", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");
    const start = script.indexOf("function applySuggestion");
    const end = script.indexOf("function pushEvent", start);
    const applySuggestion = script.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(applySuggestion).toContain("el.messageInput.value = text;");
    expect(applySuggestion).toContain("syncComposerState();");
  });

  test("composer clears stale slash suggestions after submit", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");
    const start = script.indexOf('el.composer.addEventListener("submit"');
    const end = script.indexOf('el.messageInput.addEventListener("input"', start);
    const submitHandler = script.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(submitHandler).toContain('el.messageInput.value = "";');
    expect(submitHandler).toContain("renderSlashSuggestions();");
  });

  test("commands button opens slash picker instead of inserting help command", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");

    expect(script).toContain('el.slashHelpBtn.addEventListener("click", () => {\n  applySuggestion("/");\n});');
    expect(script).not.toContain('el.slashHelpBtn.addEventListener("click", () => {\n  applySuggestion("/help");\n});');
  });

  test("diff overlay summarizes tracked and untracked changes", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");

    expect(script).toContain("function formatDiffMeta(data = {})");
    expect(script).toContain('hasTrackedChanges ? "tracked changes" : "no tracked changes"');
    expect(script).toContain('el.diffMeta.textContent = formatDiffMeta(data);');
    expect(script).toContain('function renderDiffHtml(diffText)');
    expect(script).toContain('cls += " add"');
    expect(script).toContain('cls += " del"');
    expect(script).toContain('cls += " hunk"');
  });

  test("frontend exposes plugin commands in fallback suggestions and status metadata", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");
    const html = await fs.readFile("src/web/public/index.html", "utf8");

    expect(html).toContain('id="pluginsLabel"');
    expect(script).toContain('pluginsLabel: document.getElementById("pluginsLabel")');
    expect(script).toContain('snapshot.plugins.map((plugin) => plugin.name).join(", ")');
    expect(script).toContain('{ name: "/plugins", description: "Show active plugins" }');
    expect(script).toContain('"/plugins use"');
    expect(script).toContain('command.pluginName || command.skillName');
  });

  test("paste handler reads image clipboard items before falling back to clipboard files", async () => {
    const script = await fs.readFile("src/web/public/app.js", "utf8");

    expect(script).toContain("async function clipboardItemsToFiles(clipboardData)");
    expect(script).toContain('.filter((item) => ALLOWED_IMAGE_TYPES.has(String(item.type || "").toLowerCase()))');
    expect(script).toContain('.map((item) => item.getAsFile?.())');
    expect(script).toContain('return [...(clipboardData?.files || [])].filter((file) => ALLOWED_IMAGE_TYPES.has(file.type));');
    expect(script).toContain('el.messageInput.addEventListener("paste", async (evt) => {');
    expect(script).toContain('const files = await clipboardItemsToFiles(evt.clipboardData);');
    expect(script).toContain('evt.preventDefault();');
  });
});

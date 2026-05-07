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
});

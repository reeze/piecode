import { promises as fs } from "node:fs";

describe("web app approval and clarification contract", () => {
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

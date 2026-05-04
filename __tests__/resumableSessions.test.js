import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listResumableSessions,
  makeSessionId,
  resolveResumableSessionId,
  saveResumableSession,
  shortSessionId,
} from "../src/lib/resumableSessions.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "piecode-session-test-"));
}

describe("resumable sessions", () => {
  test("saves, lists, and resolves sessions by short id", async () => {
    const workspaceDir = await makeWorkspace();
    const saved = await saveResumableSession(workspaceDir, {
      sessionId: "session-20260102-030405-abcd",
      providerLabel: "seed:model",
      agentHistory: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
      messages: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "world" },
      ],
      timeline: [{ type: "message", role: "user", content: "hello" }],
    });

    expect(saved.sessionId).toBe("session-20260102-030405-abcd");
    const sessions = await listResumableSessions(workspaceDir);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-20260102-030405-abcd",
      shortId: "abcd",
      providerLabel: "seed:model",
      messageCount: 2,
    });
    await expect(resolveResumableSessionId(workspaceDir, "abcd")).resolves.toBe(saved.sessionId);
  });

  test("generates ids suitable for the quick resume command", () => {
    const id = makeSessionId();
    expect(id).toMatch(/^session-\d{8}-\d{6}-[a-z0-9]{4}$/);
    const shortId = shortSessionId(id);
    expect(shortId).toHaveLength(4);
    expect(`piecode --resume ${id}`).toContain(id);
  });
});

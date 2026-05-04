import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendMemory, loadMemory, renderMemoryForPrompt } from "../src/lib/memory.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "piecode-memory-test-"));
}

describe("memory persistence strategy", () => {
  test("writes project memory and renders it for the prompt", async () => {
    const workspaceDir = await makeWorkspace();

    const result = await appendMemory({
      workspaceDir,
      scope: "project",
      content: "Prefer compact TUI layouts in this repo.",
    });

    expect(result.scope).toBe("project");
    expect(result.skipped).toBeUndefined();
    const memory = await loadMemory({
      workspaceDir,
      globalPath: path.join(workspaceDir, "global-memory.md"),
    });
    expect(memory.project.content).toContain("Prefer compact TUI layouts in this repo.");
    expect(renderMemoryForPrompt(memory)).toContain("Project memory (.piecode/MEMORY.md):");
  });

  test("does not append duplicate memory entries", async () => {
    const workspaceDir = await makeWorkspace();

    await appendMemory({
      workspaceDir,
      content: "Use feed-first approval UI.",
    });
    const duplicate = await appendMemory({
      workspaceDir,
      content: "  Use feed-first approval UI.  ",
    });

    expect(duplicate).toMatchObject({ skipped: true, reason: "duplicate" });
    const file = await fs.readFile(path.join(workspaceDir, ".piecode", "MEMORY.md"), "utf8");
    expect(file.match(/Use feed-first approval UI\./g)).toHaveLength(1);
  });

  test("rejects memory that looks like a secret", async () => {
    const workspaceDir = await makeWorkspace();

    await expect(
      appendMemory({
        workspaceDir,
        scope: "global",
        globalPath: path.join(workspaceDir, "global-memory.md"),
        content: "OpenAI API key is sk_test_abcdefghijklmnopqrstuvwxyz123456",
      })
    ).rejects.toThrow(/secret|credential/i);
  });

  test("normalizes personal and user scopes to global memory", async () => {
    const workspaceDir = await makeWorkspace();
    const globalPath = path.join(workspaceDir, "global-memory.md");

    const result = await appendMemory({
      workspaceDir,
      scope: "personal",
      globalPath,
      content: "User prefers terse final answers.",
    });

    expect(result.scope).toBe("global");
    const memory = await loadMemory({ workspaceDir, globalPath });
    expect(memory.global.content).toContain("User prefers terse final answers.");
  });
});

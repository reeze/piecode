import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyLedgerUpdate,
  clearLedger,
  createEmptyLedger,
  deriveLedgerUpdateFromTool,
  formatLedgerForDisplay,
  getLedgerPath,
  isLedgerEmpty,
  loadLedger,
  renderLedgerForPrompt,
  saveLedger,
} from "../src/lib/taskLedger.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "piecode-ledger-"));
}

describe("task ledger state", () => {
  test("starts empty and stays empty until something is recorded", () => {
    expect(isLedgerEmpty(createEmptyLedger())).toBe(true);
    expect(renderLedgerForPrompt(createEmptyLedger())).toBe("");
  });

  test("partial updates merge instead of erasing prior state", () => {
    let ledger = applyLedgerUpdate(createEmptyLedger(), {
      objective: "Add provider registry",
      decisions: ["Use one registry module"],
      changedFiles: ["src/lib/modelCatalog.js"],
    });
    ledger = applyLedgerUpdate(ledger, { changedFiles: ["src/lib/providers.js"] });

    expect(ledger.objective).toBe("Add provider registry");
    expect(ledger.decisions).toEqual(["Use one registry module"]);
    expect(ledger.changedFiles).toEqual(["src/lib/modelCatalog.js", "src/lib/providers.js"]);
  });

  test("appended lists deduplicate repeated entries", () => {
    let ledger = applyLedgerUpdate(createEmptyLedger(), { changedFiles: ["a.js", "b.js"] });
    ledger = applyLedgerUpdate(ledger, { changedFiles: ["a.js"] });
    expect(ledger.changedFiles).toEqual(["b.js", "a.js"]);
  });

  test("todos replace wholesale and normalize unknown statuses", () => {
    const ledger = applyLedgerUpdate(createEmptyLedger(), {
      todos: [
        { content: "write catalog", status: "completed" },
        { content: "wire cli", status: "bogus" },
      ],
    });
    expect(ledger.todos).toEqual([
      { content: "write catalog", status: "completed" },
      { content: "wire cli", status: "pending" },
    ]);
  });

  test("turn counter advances across turns", () => {
    let ledger = applyLedgerUpdate(createEmptyLedger(), { incrementTurn: true });
    ledger = applyLedgerUpdate(ledger, { incrementTurn: true });
    expect(ledger.turnCount).toBe(2);
  });
});

describe("deriving ledger updates from tool calls", () => {
  test("todo_write carries the plan", () => {
    const update = deriveLedgerUpdateFromTool({
      tool: "todo_write",
      input: { todos: [{ content: "step one", status: "in_progress" }] },
    });
    expect(update.todos).toHaveLength(1);
  });

  test("successful edits record changed files", () => {
    expect(deriveLedgerUpdateFromTool({ tool: "write_file", input: { path: "src/a.js" } })).toEqual({
      changedFiles: ["src/a.js"],
    });
    expect(
      deriveLedgerUpdateFromTool({ tool: "replace_in_files", input: { paths: ["src/a.js", "src/b.js"] } })
    ).toEqual({ changedFiles: ["src/a.js", "src/b.js"] });
  });

  test("failed edits are not recorded as changes", () => {
    expect(
      deriveLedgerUpdateFromTool({ tool: "write_file", input: { path: "src/a.js" }, error: "denied" })
    ).toBeNull();
  });

  test("validation commands record their outcome, other shell commands do not", () => {
    expect(
      deriveLedgerUpdateFromTool({ tool: "shell", input: { command: "npm test" }, result: "all suites passed" })
    ).toEqual({ validations: [{ command: "npm test", result: "passed" }] });

    expect(
      deriveLedgerUpdateFromTool({ tool: "shell", input: { command: "npm test" }, result: "1 test failed" })
    ).toEqual({ validations: [{ command: "npm test", result: "failed" }] });

    expect(deriveLedgerUpdateFromTool({ tool: "shell", input: { command: "ls -la" } })).toBeNull();
  });
});

describe("ledger rendering", () => {
  test("prompt section lists open todos before completed ones", () => {
    const ledger = applyLedgerUpdate(createEmptyLedger(), {
      objective: "Ship the registry",
      todos: [
        { content: "done thing", status: "completed" },
        { content: "open thing", status: "in_progress" },
      ],
      nextStep: "wire the cli",
    });
    const text = renderLedgerForPrompt(ledger);
    expect(text).toContain("objective: Ship the registry");
    expect(text.indexOf("open thing")).toBeLessThan(text.indexOf("done thing"));
    expect(text).toContain("next step: wire the cli");
  });

  test("display view summarizes counts and evidence", () => {
    const ledger = applyLedgerUpdate(createEmptyLedger(), {
      todos: [{ content: "a", status: "completed" }],
      validations: [{ command: "npm test", result: "passed" }],
    });
    const lines = formatLedgerForDisplay(ledger);
    expect(lines).toContain("  todos: 1/1 done");
    expect(lines.join("\n")).toContain("npm test → passed");
  });
});

describe("ledger persistence", () => {
  test("round-trips through disk and can be cleared", async () => {
    const workspaceDir = await makeWorkspace();
    try {
      const ledger = applyLedgerUpdate(createEmptyLedger(), {
        objective: "Persist me",
        todos: [{ content: "survive a restart", status: "pending" }],
      });
      const saved = await saveLedger(workspaceDir, ledger);
      expect(saved.ok).toBe(true);
      expect(saved.path).toBe(getLedgerPath(workspaceDir));

      const reloaded = await loadLedger(workspaceDir);
      expect(reloaded.objective).toBe("Persist me");
      expect(reloaded.todos).toEqual([{ content: "survive a restart", status: "pending" }]);
      expect(reloaded.updatedAt).toBeTruthy();

      await clearLedger(workspaceDir);
      expect(isLedgerEmpty(await loadLedger(workspaceDir))).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("a corrupt ledger file degrades to an empty ledger", async () => {
    const workspaceDir = await makeWorkspace();
    try {
      const target = getLedgerPath(workspaceDir);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "{ not json", "utf8");
      expect(isLedgerEmpty(await loadLedger(workspaceDir))).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

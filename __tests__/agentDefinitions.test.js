import os from "os";
import path from "path";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { loadAgentDefinitions, parseAgentDefinitionMarkdown } from "../src/lib/agentDefinitions.js";

describe("agent definitions", () => {
  test("parses frontmatter and prompt body", () => {
    const definition = parseAgentDefinitionMarkdown(
      `---\nname: security-reviewer\ndescription: "Security reviewer"\ntools: read_file, rg, git_diff\nmodel: inherit\ncolor: red\n---\n\nYou review security.`,
      { path: ".AGENTS/security-reviewer.md" }
    );

    expect(definition).toMatchObject({
      name: "security-reviewer",
      description: "Security reviewer",
      tools: ["read_file", "rg", "git_diff"],
      model: "inherit",
      color: "red",
      path: ".AGENTS/security-reviewer.md",
    });
    expect(definition.prompt).toBe("You review security.");
  });

  test("loads project .AGENTS markdown files and ignores README", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "piecode-agents-"));
    await mkdir(path.join(dir, ".AGENTS"));
    await writeFile(path.join(dir, ".AGENTS", "README.md"), "# docs\n", "utf8");
    await writeFile(
      path.join(dir, ".AGENTS", "test-reviewer.md"),
      `---\nname: test-reviewer\ndescription: Test review\ntools: read_file, run_tests\n---\n\nTest body`,
      "utf8"
    );

    const definitions = await loadAgentDefinitions({ workspaceDir: dir });

    expect(definitions).toHaveLength(1);
    expect(definitions[0].name).toBe("test-reviewer");
    expect(definitions[0].tools).toEqual(["read_file", "run_tests"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects invalid agent names", () => {
    expect(() =>
      parseAgentDefinitionMarkdown(`---\nname: ../bad\n---\n\nBody`, { path: ".AGENTS/bad.md" })
    ).toThrow("Invalid agent name");
  });
});

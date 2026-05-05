import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFileMentionContext,
  isSensitiveMentionPath,
  parseContextMentions,
  parseFileMentions,
} from "../src/lib/fileMentionContext.js";

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "piecode-mentions-"));
}

async function writeTempFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

describe("file mention context", () => {
  test("parses full-message file mentions without matching emails", () => {
    const mentions = parseFileMentions("read @README.md and email dev@example.com about @src/cli.js");
    expect(mentions.map((item) => item.path)).toEqual(["README.md", "src/cli.js"]);
  });

  test("inlines small referenced files and preserves original message", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "README.md", "# Hello\nSmall file\n");

    const result = await buildFileMentionContext("请看 @README.md", { cwd: root });

    expect(result.prompt).toContain("Referenced file context:");
    expect(result.prompt).toContain("- README.md: inlined");
    expect(result.prompt).toContain("# Hello\nSmall file");
    expect(result.prompt).toContain("Original user message:\n请看 @README.md");
    expect(result.mentions[0]).toMatchObject({ path: "README.md", status: "inline" });
  });

  test("previews large referenced files instead of inlining full content", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "large.txt", `start\n${"x".repeat(200)}\nend`);

    const result = await buildFileMentionContext("summarize @large.txt", {
      cwd: root,
      inlineMax: 20,
      previewMax: 40,
      totalMax: 1000,
    });

    expect(result.prompt).toContain("- large.txt: preview only");
    expect(result.prompt).toContain("start");
    expect(result.prompt).not.toContain("end");
    expect(result.prompt).toContain("Use read_file if full content is needed");
    expect(result.mentions[0]).toMatchObject({ status: "preview" });
  });

  test("skips sensitive files without including their contents", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, ".env", "API_KEY=super-secret");

    const result = await buildFileMentionContext("inspect @.env", { cwd: root });

    expect(result.prompt).toContain(".env: skipped (path looks sensitive)");
    expect(result.prompt).not.toContain("super-secret");
    expect(isSensitiveMentionPath(".env.local")).toBe(true);
    expect(isSensitiveMentionPath("keys/id_ed25519")).toBe(true);
  });

  test("skips missing, directory, git-related, binary, duplicate, and outside paths safely", async () => {
    const root = await makeTempWorkspace();
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await writeTempFile(root, ".git/config", "secret git config");
    await writeTempFile(root, "bin.dat", Buffer.from([0, 1, 2, 3]));
    await writeTempFile(root, "README.md", "ok");

    const result = await buildFileMentionContext(
      "@missing.txt @docs @.git/config @bin.dat @README.md @README.md @../../outside.txt",
      { cwd: root }
    );

    expect(result.prompt).toContain("missing.txt: skipped (not found)");
    expect(result.prompt).toContain("docs: skipped (directory)");
    expect(result.prompt).toContain(".git/config: skipped (git-related path)");
    expect(result.prompt).toContain("bin.dat: skipped (binary file)");
    expect(result.prompt).toContain("../../outside.txt: skipped (outside workspace)");
    expect((result.prompt.match(/README.md: inlined/g) || []).length).toBe(1);
  });

  test("returns original message unchanged when there are no mentions", async () => {
    const result = await buildFileMentionContext("hello dev@example.com", { cwd: await makeTempWorkspace() });
    expect(result.prompt).toBe("hello dev@example.com");
    expect(result.mentions).toEqual([]);
  });

  test("uses a safe longer code fence when content contains backticks", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "snippet.md", "before\n```js\nconsole.log(1)\n```\nafter");

    const result = await buildFileMentionContext("read @snippet.md", { cwd: root });

    expect(result.prompt).toContain("````markdown");
    expect(result.prompt).toContain("```js");
  });

  test("parses reserved context mentions and file line ranges", () => {
    const mentions = parseContextMentions("review @diff:staged @git:status @src/app.js:2-4 @glob:src/**/*.js");
    expect(mentions.map((item) => item.kind)).toEqual(["diff", "gitStatus", "fileRange", "glob"]);
    expect(mentions[2]).toMatchObject({ path: "src/app.js", range: { start: 2, end: 4 } });
  });

  test("inlines explicit file line ranges only", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "src/app.js", "one\ntwo\nthree\nfour\nfive\n");

    const result = await buildFileMentionContext("explain @src/app.js:2-3", { cwd: root });

    expect(result.prompt).toContain("src/app.js:2-3: line range");
    expect(result.prompt).toContain("2: two");
    expect(result.prompt).toContain("3: three");
    expect(result.prompt).not.toContain("5: five");
    expect(result.mentions[0]).toMatchObject({ kind: "fileRange", status: "inline" });
  });

  test("summarizes directories without inlining file contents", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "src/a.js", "secret content should not appear");
    await writeTempFile(root, "src/nested/b.js", "nested content should not appear");

    const result = await buildFileMentionContext("summarize @dir:src", { cwd: root });

    expect(result.prompt).toContain("src/: directory summary");
    expect(result.prompt).toContain("- src/a.js");
    expect(result.prompt).toContain("- src/nested/");
    expect(result.prompt).not.toContain("secret content should not appear");
    expect(result.mentions[0]).toMatchObject({ kind: "dir", status: "summary" });
  });

  test("summarizes glob matches as a bounded path list", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "src/a.js", "a");
    await writeTempFile(root, "src/b.txt", "b");
    await writeTempFile(root, "src/nested/c.js", "c");

    const result = await buildFileMentionContext("list @glob:src/**/*.js", { cwd: root, globMaxMatches: 10 });

    expect(result.prompt).toContain("glob:src/**/*.js: matched paths");
    expect(result.prompt).toContain("- src/a.js");
    expect(result.prompt).toContain("- src/nested/c.js");
    expect(result.prompt).not.toContain("- src/b.txt");
    expect(result.mentions[0]).toMatchObject({ kind: "glob", status: "summary" });
  });

  test("renders memory mentions from the loaded memory ref", async () => {
    const root = await makeTempWorkspace();
    const memoryRef = {
      value: {
        global: { content: "# Memory\n\n- User prefers concise answers." },
        project: { content: "# Memory\n\n- Use Jest for tests." },
      },
    };

    const result = await buildFileMentionContext("check @memory:project", { cwd: root, memoryRef });

    expect(result.prompt).toContain("memory:project");
    expect(result.prompt).toContain("Use Jest for tests.");
    expect(result.prompt).not.toContain("User prefers concise answers.");
  });

  test("renders workspace and last-run reserved context", async () => {
    const root = await makeTempWorkspace();
    await writeTempFile(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "jest" } }));
    await writeTempFile(root, ".piecode/shell/result-1.txt", "command: npm test\nexit_code: 1\nstdout:\nfailed");

    const result = await buildFileMentionContext("continue from @workspace and @last-run", { cwd: root });

    expect(result.prompt).toContain("workspace summary");
    expect(result.prompt).toContain("package: demo");
    expect(result.prompt).toContain("last-run result-1.txt");
    expect(result.prompt).toContain("exit_code: 1");
  });
});

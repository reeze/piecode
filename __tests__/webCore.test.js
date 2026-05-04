import { clipDiffText, getSessionDiff, parseToolResultDetails } from "../src/web/core.js";
import { isAuthorizedWebRequest, resolveWebBindOptions, validateWebOrigin } from "../src/web/server.js";

describe("web server security helpers", () => {
  test("binds to loopback by default", () => {
    expect(resolveWebBindOptions({}).host).toBe("127.0.0.1");
    expect(resolveWebBindOptions({ PIECODE_WEB_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  test("requires token for api requests", () => {
    const req = { headers: {} };
    const url = new URL("http://localhost/api/state");
    expect(isAuthorizedWebRequest(req, url, "secret")).toBe(false);
    url.searchParams.set("token", "secret");
    expect(isAuthorizedWebRequest(req, url, "secret")).toBe(true);
    expect(isAuthorizedWebRequest({ headers: { "x-piecode-token": "secret" } }, new URL("http://localhost/api/state"), "secret")).toBe(true);
  });

  test("rejects foreign origins", () => {
    expect(validateWebOrigin({ headers: {} }, "127.0.0.1", 3737).ok).toBe(true);
    expect(validateWebOrigin({ headers: { origin: "http://localhost:3737" } }, "127.0.0.1", 3737).ok).toBe(true);
    expect(validateWebOrigin({ headers: { origin: "https://evil.example" } }, "127.0.0.1", 3737).ok).toBe(false);
  });
});

describe("web core helpers", () => {
  test("summarizes edit_file results with expandable diffs", () => {
    const result = parseToolResultDetails("edit_file", JSON.stringify({
      path: "src/app.js",
      changed: true,
      message: "Updated app",
      details: {
        diffStat: "1 file changed",
        diff: "diff --git a/src/app.js b/src/app.js\n+const ok = true;",
      },
    }));

    expect(result).toMatchObject({
      kind: "file_edit",
      path: "src/app.js",
      changed: true,
      message: "Updated app",
      diffStat: "1 file changed",
      expandable: true,
      preview: "Updated app",
    });
    expect(result.diff).toContain("+const ok = true;");
  });

  test("summarizes replace_in_files results without leaking huge payloads by default", () => {
    const result = parseToolResultDetails("replace_in_files", JSON.stringify({
      mode: "literal",
      matched_files: 1,
      replacements: 2,
      files: [{ path: "README.md", replacements: 2 }],
    }));

    expect(result).toMatchObject({
      kind: "bulk_replace",
      mode: "literal",
      matchedFiles: 1,
      replacements: 2,
      expandable: true,
      preview: "literal: 1 file(s), 2 replacement(s)",
    });
    expect(result.files).toEqual([{ path: "README.md", replacements: 2 }]);
  });

  test("clips large diffs and reports omitted characters", () => {
    const result = clipDiffText("a".repeat(10050), 20);

    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBe(50);
    expect(result.text).toContain("[diff truncated: 50 chars omitted]");
  });

  test("builds a session diff from staged, unstaged, and untracked git output", async () => {
    const calls = [];
    const execFile = async (_bin, args) => {
      calls.push(args.join(" "));
      const command = args.join(" ");
      if (command.startsWith("rev-parse")) return { stdout: "true\n" };
      if (command.startsWith("diff --cached")) return { stdout: "diff --git a/a.js b/a.js\n+staged\n" };
      if (command.startsWith("diff --no-ext-diff")) return { stdout: "diff --git a/b.js b/b.js\n+unstaged\n" };
      if (command.startsWith("ls-files")) return { stdout: "new.txt\n" };
      return { stdout: "" };
    };

    const result = await getSessionDiff("/workspace", { execFile });

    expect(result.ok).toBe(true);
    expect(result.diff).toContain("# Staged changes");
    expect(result.diff).toContain("+staged");
    expect(result.diff).toContain("# Unstaged changes");
    expect(result.diff).toContain("+unstaged");
    expect(result.diff).toContain("?? new.txt");
    expect(result.untrackedFiles).toEqual(["new.txt"]);
    expect(calls).toContain("rev-parse --is-inside-work-tree");
  });
});

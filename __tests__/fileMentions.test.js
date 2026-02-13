import {
  applyFileMentionSelection,
  getFileMentionSuggestions,
  isGitRelatedPath,
  parseActiveFileMention,
  scoreFilePath,
} from "../src/lib/fileMentions.js";

describe("file mentions", () => {
  test("detects active @mention token around cursor", () => {
    const parsed = parseActiveFileMention("please inspect @src/li", 22);
    expect(parsed).toMatchObject({
      query: "src/li",
      start: 15,
      end: 22,
    });
  });

  test("does not detect email-like text as file mention", () => {
    expect(parseActiveFileMention("email me at dev@example.com", 20)).toBeNull();
  });

  test("scores basename prefix higher than loose path matches", () => {
    const prefix = scoreFilePath("src/lib/tui.js", "tu");
    const loose = scoreFilePath("src/cli.js", "tu");
    expect(prefix).toBeGreaterThan(loose);
  });

  test("filters and ranks fuzzy suggestions, excluding git files", () => {
    const files = [
      "src/cli.js",
      "src/lib/tui.js",
      "src/lib/tuiLineEditor.js",
      ".git/config",
      ".gitignore",
    ];
    const out = getFileMentionSuggestions("look at @tui", 12, files, 5);
    expect(out.mention?.query).toBe("tui");
    expect(out.suggestions[0]).toBe("src/lib/tui.js");
    expect(out.suggestions).not.toContain(".git/config");
    expect(out.suggestions).not.toContain(".gitignore");
  });

  test("replaces active token with selected file path", () => {
    const out = applyFileMentionSelection("check @src/li first", 13, "src/lib/tui.js");
    expect(out).toMatchObject({
      line: "check @src/lib/tui.js first",
      cursor: 21,
      mention: { start: 6, end: 13 },
    });
  });

  test("detects git-related paths", () => {
    expect(isGitRelatedPath(".git/config")).toBe(true);
    expect(isGitRelatedPath("docs/.gitkeep")).toBe(true);
    expect(isGitRelatedPath("src/lib/tui.js")).toBe(false);
  });
});

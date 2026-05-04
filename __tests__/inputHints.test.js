import { buildInputHints, DEFAULT_INPUT_HINTS, sanitizeInputHints } from "../src/lib/inputHints.js";

describe("input hints", () => {
  test("returns default hints for empty context", () => {
    expect(buildInputHints({})).toEqual(DEFAULT_INPUT_HINTS.slice(0, 5));
  });

  test("prioritizes error recovery hints", () => {
    const hints = buildInputHints({ assistantText: "Command failed with exit 1", hadError: true });
    expect(hints[0]).toBe("修复刚才的报错并重试");
    expect(hints).toContain("解释为什么会失败");
  });

  test("prioritizes failing test hints", () => {
    const hints = buildInputHints({ assistantText: "Jest tests failed", testsFailed: true });
    expect(hints[0]).toBe("修复失败的测试");
    expect(hints).toContain("解释测试失败的原因");
  });

  test("suggests review and tests after file changes", () => {
    const hints = buildInputHints({
      assistantText: "Updated src/app.js",
      toolCalls: ["edit_file"],
      changedFiles: ["src/app.js"],
    });
    expect(hints).toContain("review 当前改动");
    expect(hints).toContain("运行相关测试");
    expect(hints).toContain("总结修改了哪些文件");
  });

  test("suggests answering assistant questions", () => {
    const hints = buildInputHints({ assistantText: "你想让我继续实现测试吗？" });
    expect(hints).toContain("回答上面的问题");
  });

  test("sanitizes, deduplicates, truncates, and falls back", () => {
    expect(sanitizeInputHints([])).toEqual(DEFAULT_INPUT_HINTS.slice(0, 5));
    const hints = sanitizeInputHints([
      "  A\nB  ",
      "A B",
      "\x1b[31mcolored\x1b[0m",
      "x".repeat(100),
    ]);
    expect(hints[0]).toBe("A B");
    expect(hints[1]).toBe("colored");
    expect(hints[2].length).toBeLessThanOrEqual(72);
    expect(hints).toHaveLength(3);
  });
});

import { EventEmitter } from "node:events";
import { TuiLineEditor } from "../src/lib/tuiLineEditor.js";

function emitKey(emitter, str, key) {
  emitter.emit("keypress", str, key || {});
}

describe("tui line editor", () => {
  test("submits on plain enter", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    emitKey(source, "h", { name: "h" });
    emitKey(source, "i", { name: "i" });
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("hi");
    rl.close();
  });

  test("shift+enter does not submit", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    emitKey(source, "h", { name: "h" });
    emitKey(source, "i", { name: "i" });
    emitKey(source, "\r", { name: "enter", shift: true });
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("hi");
    rl.close();
  });

  test("plain enter with shift flag still submits", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    emitKey(source, "o", { name: "o" });
    emitKey(source, "k", { name: "k" });
    emitKey(source, "\r", { name: "enter", shift: true });
    await expect(pending).resolves.toBe("ok");
    rl.close();
  });

  test("modified-enter sentinel does not submit", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    emitKey(source, "a", { name: "a" });
    emitKey(source, "\x1f", { name: "enter" });
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("a");
    rl.close();
  });

  test("shift-enter glyph is ignored and not inserted", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    emitKey(source, "x", { name: "x" });
    emitKey(source, "↩", { name: "enter", shift: true });
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("x");
    rl.close();
  });

  test("ctrl+d on empty line aborts as eof", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    emitKey(source, "\u0004", { name: "d", ctrl: true });
    await expect(pending).rejects.toThrow("EOT");
    rl.close();
  });

  test("shouldHandleKeypress can reserve ctrl+c for outer TUI handling", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({
      keypressSource: source,
      shouldHandleKeypress: (_str, key = {}) => !(key.ctrl && key.name === "c"),
    });
    const pending = rl.question("");
    emitKey(source, "\u0003", { name: "c", ctrl: true });

    const pendingState = await Promise.race([
      pending.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(pendingState).toBe("pending");
    rl.close();
  });

  test("submit() resolves pending question with current line", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    rl.write("plan");
    rl.submit();
    await expect(pending).resolves.toBe("plan");
    rl.close();
  });

  test("write supports ctrl+b/ctrl+f cursor movement for programmatic completions", () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });

    rl.write("中文🙂abc");
    rl.write(null, { ctrl: true, name: "b" });
    rl.write(null, { ctrl: true, name: "b" });
    expect(rl.cursor).toBe("中文🙂a".length);
    rl.write("X");
    expect(rl.line).toBe("中文🙂aXbc");
    rl.write(null, { ctrl: true, name: "f" });
    rl.write("Y");
    expect(rl.line).toBe("中文🙂aXbYc");
    rl.close();
  });

  test("handleKeypress can collect and submit input without a pending question", () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });

    rl.handleKeypress("/", { name: "/" }, { allowWithoutPending: true });
    rl.handleKeypress("a", { name: "a" }, { allowWithoutPending: true });
    rl.handleKeypress("g", { name: "g" }, { allowWithoutPending: true });
    const submitted = rl.handleKeypress("\r", { name: "enter" }, { allowWithoutPending: true });

    expect(submitted).toEqual({ submitted: true, value: "/ag" });
    expect(rl.line).toBe("");
    rl.close();
  });

  test("history up/down recalls previous entries", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source, history: ["second", "first"] });
    const pending = rl.question("");
    emitKey(source, "", { name: "up" });
    expect(rl.line).toBe("second");
    emitKey(source, "", { name: "up" });
    expect(rl.line).toBe("first");
    emitKey(source, "", { name: "down" });
    expect(rl.line).toBe("second");
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("second");
    rl.close();
  });

  test("ctrl+u preserves the history scratch draft when leaving history navigation", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source, history: ["second", "first"] });
    const pending = rl.question("");

    rl.write("draft text");
    emitKey(source, "", { name: "up" });
    expect(rl.line).toBe("second");

    emitKey(source, "", { ctrl: true, name: "u" });
    expect(rl.line).toBe("");

    emitKey(source, "", { name: "down" });
    expect(rl.line).toBe("draft text");
    expect(rl.cursor).toBe("draft text".length);

    rl.close();
    await expect(pending).rejects.toThrow("readline was closed");
  });

  test("backspace deletes across multiline boundaries", async () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });
    const pending = rl.question("");
    rl.write("abc");
    rl.write("\n");
    rl.write("def");
    expect(rl.line).toBe("abc\ndef");
    emitKey(source, "", { name: "backspace" });
    emitKey(source, "", { name: "backspace" });
    emitKey(source, "", { name: "backspace" });
    emitKey(source, "", { name: "backspace" });
    expect(rl.line).toBe("abc");
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("abc");
    rl.close();
  });

  test("up and down move within multiline input instead of replacing it with history", () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source, history: ["previous prompt"] });

    rl.write("first\nsecond\nthird");
    expect(rl.cursor).toBe("first\nsecond\nthird".length);

    rl.handleKeypress("", { name: "up" }, { allowWithoutPending: true });
    expect(rl.line).toBe("first\nsecond\nthird");
    expect(rl.cursor).toBe("first\nsecon".length);

    rl.handleKeypress("", { name: "up" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("first".length);

    rl.handleKeypress("", { name: "up" }, { allowWithoutPending: true });
    expect(rl.line).toBe("first\nsecond\nthird");
    expect(rl.cursor).toBe("first".length);

    rl.handleKeypress("", { name: "down" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("first\nsecon".length);

    rl.close();
  });

  test("home and end target the current logical line in multiline input", () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });

    rl.write("alpha\nbeta\ncharlie");
    rl.cursor = "alpha\nbe".length;

    rl.handleKeypress("", { name: "home" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("alpha\n".length);

    rl.handleKeypress("", { name: "end" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("alpha\nbeta".length);

    rl.handleKeypress("", { ctrl: true, name: "a" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe(0);

    rl.handleKeypress("", { ctrl: true, name: "e" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("alpha\nbeta\ncharlie".length);
    rl.close();
  });

  test("cursor movement and deletion are grapheme-aware for CJK and emoji", () => {
    const source = new EventEmitter();
    const rl = new TuiLineEditor({ keypressSource: source });

    rl.write("中文🙂a");
    expect(rl.cursor).toBe("中文🙂a".length);
    rl.handleKeypress("", { name: "left" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("中文🙂".length);
    rl.handleKeypress("", { name: "left" }, { allowWithoutPending: true });
    expect(rl.cursor).toBe("中文".length);
    rl.handleKeypress("", { name: "backspace" }, { allowWithoutPending: true });
    expect(rl.line).toBe("中🙂a");
    expect(rl.cursor).toBe("中".length);
    rl.handleKeypress("", { name: "delete" }, { allowWithoutPending: true });
    expect(rl.line).toBe("中a");
    rl.close();
  });

  test("ignores keypresses when shouldHandleKeypress blocks input", async () => {
    const source = new EventEmitter();
    let blocked = true;
    const rl = new TuiLineEditor({
      keypressSource: source,
      shouldHandleKeypress: () => !blocked,
    });
    const pending = rl.question("");
    emitKey(source, "x", { name: "x" });
    emitKey(source, "\r", { name: "enter" });
    expect(rl.line).toBe("");

    const pendingState = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(pendingState).toBe("pending");

    blocked = false;
    emitKey(source, "o", { name: "o" });
    emitKey(source, "k", { name: "k" });
    emitKey(source, "\r", { name: "enter" });
    await expect(pending).resolves.toBe("ok");
    rl.close();
  });
});

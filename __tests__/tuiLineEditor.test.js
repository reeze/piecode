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
});

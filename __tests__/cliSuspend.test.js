import { EventEmitter } from "node:events";
import { createTuiKeypressSource, isSuspendKey } from "../src/cli.js";

describe("CLI suspend handling", () => {
  test("detects CTRL+Z keypresses", () => {
    expect(isSuspendKey("\x1a", { name: "z", ctrl: true })).toBe(true);
    expect(isSuspendKey("\x1a", {})).toBe(true);
    expect(isSuspendKey("z", { name: "z", ctrl: false })).toBe(false);
  });

  test("TUI keypress source can suspend and resume raw mode", () => {
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = false;
    const calls = [];
    input.setRawMode = (value) => {
      calls.push(Boolean(value));
      input.isRaw = Boolean(value);
    };

    const source = createTuiKeypressSource({ input });
    source.suspend();
    source.resume();
    source.destroy();

    expect(calls).toEqual([true, false, true, false]);
  });
});

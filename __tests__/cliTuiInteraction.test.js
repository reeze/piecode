import {
  applyCommandPickerSelectionForSubmit,
  isPickerCancelKey,
} from "../src/lib/cliTuiInteraction.js";

describe("CLI TUI picker interactions", () => {
  test("submitting a command picker selection applies the selected command", () => {
    expect(applyCommandPickerSelectionForSubmit({
      currentLine: "/mo",
      mode: "command",
      selectedItem: "/model",
    })).toBe("/model");
  });

  test("submitting a slash command with arguments keeps the typed line, not the stale suggestion", () => {
    expect(applyCommandPickerSelectionForSubmit({
      currentLine: "/task start demo -- node bg.js",
      mode: "command",
      selectedItem: "/help",
    })).toBe("/task start demo -- node bg.js");
  });

  test("bare Escape from tmux cancels pickers even when Node marks it meta", () => {
    expect(isPickerCancelKey("\x1b", {
      name: "escape",
      sequence: "\x1b",
      ctrl: false,
      meta: true,
      shift: false,
    })).toBe(true);
  });
});

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

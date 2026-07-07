export function isPickerCancelKey(str = "", key = {}) {
  const name = String(key?.name || "").toLowerCase();
  if (name !== "escape") return false;
  if (key?.ctrl || key?.shift) return false;
  const sequence = String(key?.sequence || str || "");
  // In tmux, Node can report a bare Escape as meta:true with sequence "\x1b".
  // Treat that as a plain picker-cancel key while still avoiding modified keys.
  return !key?.meta || sequence === "\x1b" || sequence === "\u001b";
}

export function applyCommandPickerSelectionForSubmit({ currentLine = "", mode = "command", selectedItem = "" } = {}) {
  const line = String(currentLine || "");
  const selected = String(selectedItem || "");
  if (String(mode || "command") !== "command") return line;
  if (!selected) return line;
  // Only let the highlighted suggestion replace the line while the user is still
  // completing the command word. Once they've typed arguments (e.g. "/task start x"),
  // the picker's fallback suggestion is stale — submit what they actually typed.
  // ponytail: prefix check, swap for fuzzy match only if suggestions go fuzzy.
  return selected.startsWith(line.trimStart()) ? selected : line;
}

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
  const selected = String(selectedItem || "");
  if (String(mode || "command") !== "command") return String(currentLine || "");
  return selected || String(currentLine || "");
}

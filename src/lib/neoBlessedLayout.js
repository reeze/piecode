export class NeoBlessedLayout {
  constructor({ blessed, input, output }) {
    this.blessed = blessed;
    const rawTerm = String(process.env.TERM || "").toLowerCase();
    const terminal = rawTerm.includes("ghostty") ? "xterm-256color" : (process.env.TERM || "xterm-256color");
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      input,
      output,
      terminal,
      autoPadding: false,
      warnings: false,
      dockBorders: false,
    });
    this.mainBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-3",
      tags: false,
      wrap: false,
      scrollable: true,
      alwaysScroll: true,
    });
    this.inputBox = blessed.box({
      parent: this.screen,
      bottom: 2,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
    });
    this.sepBox = blessed.box({
      parent: this.screen,
      bottom: 1,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
    });
    this.statusBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
    });
    this.hintBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      hidden: true,
    });
    this.last = { inputTop: 0, cursorRowOffset: 0, cursorCol: 1 };
  }

  render({
    workspaceLines = [],
    inputLines = [],
    statusLine = "",
    hintLine = "",
    cursorRowOffset = 0,
    cursorCol = 1,
  } = {}) {
    const rows = Math.max(16, this.screen.rows || 30);
    const cols = Math.max(40, this.screen.cols || 100);
    const safeInputLines = Array.isArray(inputLines) && inputLines.length > 0 ? inputLines : [" ❯ "];
    const inputHeight = Math.max(1, safeInputLines.length);
    const hasHint = Boolean(String(hintLine || "").trim());

    this.statusBox.bottom = 0;
    this.sepBox.bottom = hasHint ? 2 : 1;
    this.inputBox.bottom = hasHint ? 3 : 2;
    this.inputBox.height = inputHeight;
    this.hintBox.hidden = !hasHint;
    if (hasHint) this.hintBox.bottom = 1;

    const reservedBottom = inputHeight + (hasHint ? 3 : 2);
    const mainHeight = Math.max(1, rows - reservedBottom);
    this.mainBox.height = mainHeight;

    const sep = "─".repeat(Math.max(1, cols - 1));
    this.mainBox.setContent(String(workspaceLines.join("\n")));
    this.inputBox.setContent(String(safeInputLines.join("\n")));
    this.sepBox.setContent(String(sep));
    this.statusBox.setContent(String(statusLine || ""));
    if (hasHint) this.hintBox.setContent(String(hintLine || ""));

    const inputTop = mainHeight;
    this.last = {
      inputTop,
      cursorRowOffset: Math.max(0, Number(cursorRowOffset) || 0),
      cursorCol: Math.max(1, Number(cursorCol) || 1),
    };
    this.screen.render();
    this.screen.program.showCursor();
    this.screen.program.cup(
      Math.max(0, this.last.inputTop + this.last.cursorRowOffset),
      Math.max(0, this.last.cursorCol - 1)
    );
  }

  destroy() {
    try {
      if (this.screen) {
        this.screen.program.showCursor();
        this.screen.destroy();
      }
    } catch {
      // best effort
    }
  }
}

export class TuiLineEditor {
  constructor({
    keypressSource,
    history = [],
    historySize = 500,
    removeHistoryDuplicates = true,
    shouldHandleKeypress = null,
  } = {}) {
    this.keypressSource = keypressSource;
    this.history = Array.isArray(history) ? [...history] : [];
    this.historySize = Number.isFinite(historySize) ? Math.max(1, historySize) : 500;
    this.removeHistoryDuplicates = Boolean(removeHistoryDuplicates);
    this.closed = false;
    this.input = { destroyed: false };
    this.line = "";
    this.cursor = 0;
    this.pending = null;
    this.historyIndex = -1;
    this.historyScratch = "";
    this.shouldHandleKeypress =
      typeof shouldHandleKeypress === "function" ? shouldHandleKeypress : null;
    this._onKeypress = this._onKeypress.bind(this);
    if (this.keypressSource && typeof this.keypressSource.on === "function") {
      this.keypressSource.on("keypress", this._onKeypress);
    }
  }

  write(data, key = null) {
    if (this.closed) {
      const err = new Error("readline was closed");
      err.code = "ERR_USE_AFTER_CLOSE";
      throw err;
    }
    if (key && key.ctrl && String(key.name || "").toLowerCase() === "u") {
      this.line = "";
      this.cursor = 0;
      this.historyIndex = -1;
      this.historyScratch = "";
      return;
    }
    if (key && key.ctrl && String(key.name || "").toLowerCase() === "a") {
      this.cursor = 0;
      return;
    }
    if (key && key.ctrl && String(key.name || "").toLowerCase() === "e") {
      this.cursor = this.line.length;
      return;
    }
    if (typeof data !== "string" || !data) return;
    const head = this.line.slice(0, this.cursor);
    const tail = this.line.slice(this.cursor);
    this.line = `${head}${data}${tail}`;
    this.cursor += data.length;
  }

  async question(_prompt = "") {
    if (this.closed) {
      throw new Error("readline was closed");
    }
    if (this.pending) {
      throw new Error("question already pending");
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  submit() {
    this._submitCurrentLine();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.destroyed = true;
    if (this.keypressSource && typeof this.keypressSource.off === "function") {
      this.keypressSource.off("keypress", this._onKeypress);
    }
    if (this.pending) {
      const reject = this.pending.reject;
      this.pending = null;
      reject(new Error("readline was closed"));
    }
  }

  _submitCurrentLine() {
    const value = this.line;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (value.trim()) {
      if (this.removeHistoryDuplicates) {
        this.history = this.history.filter((item) => item !== value);
      }
      this.history.unshift(value);
      if (this.history.length > this.historySize) {
        this.history = this.history.slice(0, this.historySize);
      }
    }
    this.line = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.historyScratch = "";
    pending.resolve(value);
  }

  _abortCurrentLine(reason, code = "ABORT_ERR") {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    const err = new Error(reason || "The operation was aborted");
    if (code) err.code = code;
    pending.reject(err);
  }

  _moveHistory(direction) {
    if (!Array.isArray(this.history) || this.history.length === 0) return;
    if (direction < 0) {
      // Up: older entries
      if (this.historyIndex < 0) {
        this.historyScratch = this.line;
        this.historyIndex = 0;
      } else {
        this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
      }
      this.line = this.history[this.historyIndex] || "";
      this.cursor = this.line.length;
      return;
    }
    // Down: newer entries / scratch
    if (this.historyIndex < 0) return;
    this.historyIndex -= 1;
    if (this.historyIndex < 0) {
      this.line = this.historyScratch || "";
      this.cursor = this.line.length;
      this.historyScratch = "";
      return;
    }
    this.line = this.history[this.historyIndex] || "";
    this.cursor = this.line.length;
  }

  _onKeypress(str, key = {}) {
    if (!this.pending || this.closed) return;
    if (this.shouldHandleKeypress && this.shouldHandleKeypress(str, key) === false) return;
    const name = String(key?.name || "").toLowerCase();
    const ctrl = Boolean(key?.ctrl);
    const meta = Boolean(key?.meta);
    const shift = Boolean(key?.shift);

    if (ctrl && name === "c") {
      this._abortCurrentLine("The operation was aborted", "ABORT_ERR");
      return;
    }
    if (ctrl && name === "d") {
      if (!this.line) {
        // Surface as EOF-like input abort (not SIGINT) so caller can handle "press twice to exit".
        this._abortCurrentLine("EOT", "");
      }
      return;
    }

    if (ctrl && name === "a") {
      this.cursor = 0;
      return;
    }
    if (ctrl && name === "e") {
      this.cursor = this.line.length;
      return;
    }

    if (name === "left") {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (name === "right") {
      this.cursor = Math.min(this.line.length, this.cursor + 1);
      return;
    }
    if (name === "home") {
      this.cursor = 0;
      return;
    }
    if (name === "end") {
      this.cursor = this.line.length;
      return;
    }

    if (name === "backspace") {
      if (this.cursor <= 0) return;
      this.line = `${this.line.slice(0, this.cursor - 1)}${this.line.slice(this.cursor)}`;
      this.cursor -= 1;
      return;
    }
    if (name === "delete") {
      if (this.cursor >= this.line.length) return;
      this.line = `${this.line.slice(0, this.cursor)}${this.line.slice(this.cursor + 1)}`;
      return;
    }

    if (!ctrl && !meta && !shift && name === "up") {
      this._moveHistory(-1);
      return;
    }
    if (!ctrl && !meta && !shift && name === "down") {
      this._moveHistory(1);
      return;
    }

    if ((name === "return" || name === "enter") && !meta && !ctrl) {
      this._submitCurrentLine();
      return;
    }
    if (name === "return" || name === "enter") {
      // Modified Enter variants are handled by the outer TUI multiline handler.
      return;
    }

    if (ctrl && name === "j") {
      // Multiline shortcut is handled by outer TUI key handler.
      return;
    }
    if (str === "\x1f") {
      // Internal modified-enter sentinel; outer TUI handler manages multiline.
      return;
    }
    if (str === "↩" || str === "↵") {
      // Some terminals map modified-enter to glyphs; never insert these into input.
      return;
    }

    if (typeof str === "string" && str && !ctrl && !meta && str !== "\r" && str !== "\n") {
      const head = this.line.slice(0, this.cursor);
      const tail = this.line.slice(this.cursor);
      this.line = `${head}${str}${tail}`;
      this.cursor += str.length;
    }
  }
}

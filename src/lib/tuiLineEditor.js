const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemeBoundaries(text) {
  const source = String(text || "");
  const out = [0];
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(source)) {
      const next = Number(part.index) + String(part.segment || "").length;
      if (next > out[out.length - 1]) out.push(next);
    }
  } else {
    let idx = 0;
    for (const ch of source) {
      idx += ch.length;
      out.push(idx);
    }
  }
  if (out[out.length - 1] !== source.length) out.push(source.length);
  return out;
}

function previousGraphemeIndex(text, cursor) {
  const safeCursor = Math.max(0, Math.min(String(text || "").length, Number(cursor) || 0));
  const boundaries = graphemeBoundaries(text);
  let previous = 0;
  for (const boundary of boundaries) {
    if (boundary >= safeCursor) return previous;
    previous = boundary;
  }
  return previous;
}

function nextGraphemeIndex(text, cursor) {
  const source = String(text || "");
  const safeCursor = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  for (const boundary of graphemeBoundaries(source)) {
    if (boundary > safeCursor) return boundary;
  }
  return source.length;
}

function splitLineRanges(text) {
  const source = String(text || "");
  const out = [];
  let start = 0;
  for (let i = 0; i <= source.length; i += 1) {
    if (i === source.length || source[i] === "\n") {
      out.push({ start, end: i, text: source.slice(start, i) });
      start = i + 1;
    }
  }
  return out.length > 0 ? out : [{ start: 0, end: 0, text: "" }];
}

function graphemeColumn(text, offset) {
  const safeOffset = Math.max(0, Math.min(String(text || "").length, Number(offset) || 0));
  let column = 0;
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary <= 0) continue;
    if (boundary > safeOffset) break;
    column += 1;
  }
  return column;
}

function offsetForGraphemeColumn(text, column) {
  const safeColumn = Math.max(0, Math.floor(Number(column) || 0));
  const boundaries = graphemeBoundaries(text);
  return boundaries[Math.min(safeColumn, boundaries.length - 1)] || 0;
}

function cursorPosition(text, cursor) {
  const source = String(text || "");
  const safeCursor = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  const lines = splitLineRanges(source);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (safeCursor <= line.end || i === lines.length - 1) {
      return {
        lines,
        lineIndex: i,
        column: graphemeColumn(line.text, safeCursor - line.start),
      };
    }
  }
  return { lines, lineIndex: lines.length - 1, column: 0 };
}

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
    if (key && key.ctrl && String(key.name || "").toLowerCase() === "b") {
      this.cursor = previousGraphemeIndex(this.line, this.cursor);
      return;
    }
    if (key && key.ctrl && String(key.name || "").toLowerCase() === "f") {
      this.cursor = nextGraphemeIndex(this.line, this.cursor);
      return;
    }
    if (typeof data !== "string" || !data) return;
    const head = this.line.slice(0, this.cursor);
    const tail = this.line.slice(this.cursor);
    this.line = `${head}${data}${tail}`;
    this.cursor += data.length;
  }

  async question() {
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

  _submitCurrentLine({ allowWithoutPending = false } = {}) {
    const value = this.line;
    const pending = this.pending;
    if (!pending && !allowWithoutPending) return { submitted: false, value: "" };
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
    if (pending) pending.resolve(value);
    return { submitted: true, value };
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

  _moveVertical(direction) {
    if (!String(this.line || "").includes("\n")) return false;
    const pos = cursorPosition(this.line, this.cursor);
    const nextLineIndex = pos.lineIndex + (direction < 0 ? -1 : 1);
    if (nextLineIndex < 0 || nextLineIndex >= pos.lines.length) return true;
    const nextLine = pos.lines[nextLineIndex];
    this.cursor = nextLine.start + offsetForGraphemeColumn(nextLine.text, pos.column);
    return true;
  }

  _moveToLogicalLineBoundary(which) {
    if (!String(this.line || "").includes("\n")) return false;
    const pos = cursorPosition(this.line, this.cursor);
    const line = pos.lines[pos.lineIndex] || pos.lines[0];
    this.cursor = which === "end" ? line.end : line.start;
    return true;
  }

  handleKeypress(str, key = {}, { allowWithoutPending = false } = {}) {
    if ((!this.pending && !allowWithoutPending) || this.closed) return { submitted: false, value: "" };
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
    if (ctrl && name === "u") {
      this.line = "";
      this.cursor = 0;
      return { submitted: false, value: "" };
    }

    if (name === "left") {
      this.cursor = previousGraphemeIndex(this.line, this.cursor);
      return;
    }
    if (name === "right") {
      this.cursor = nextGraphemeIndex(this.line, this.cursor);
      return;
    }
    if (name === "home") {
      if (this._moveToLogicalLineBoundary("start")) return;
      this.cursor = 0;
      return;
    }
    if (name === "end") {
      if (this._moveToLogicalLineBoundary("end")) return;
      this.cursor = this.line.length;
      return;
    }

    if (name === "backspace") {
      if (this.cursor <= 0) return;
      const previous = previousGraphemeIndex(this.line, this.cursor);
      this.line = `${this.line.slice(0, previous)}${this.line.slice(this.cursor)}`;
      this.cursor = previous;
      return;
    }
    if (name === "delete") {
      if (this.cursor >= this.line.length) return;
      const next = nextGraphemeIndex(this.line, this.cursor);
      this.line = `${this.line.slice(0, this.cursor)}${this.line.slice(next)}`;
      return;
    }

    if (!ctrl && !meta && !shift && name === "up") {
      if (this._moveVertical(-1)) return;
      this._moveHistory(-1);
      return;
    }
    if (!ctrl && !meta && !shift && name === "down") {
      if (this._moveVertical(1)) return;
      this._moveHistory(1);
      return;
    }

    if ((name === "return" || name === "enter") && !meta && !ctrl) {
      return this._submitCurrentLine({ allowWithoutPending });
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
    return { submitted: false, value: "" };
  }

  _onKeypress(str, key = {}) {
    this.handleKeypress(str, key);
  }
}

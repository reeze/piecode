function cleanLine(line) {
  return String(line ?? "").replace(/\r/g, "");
}

function splitLines(text) {
  const value = String(text || "").replace(/\r/g, "");
  if (!value) return [];
  return value.split("\n");
}

function separatorLine(glyph, width) {
  const char = String(glyph || "-").slice(0, 1) || "-";
  return char.repeat(Math.max(1, Number(width) || 1));
}

function terminalRenderWidth(output, fallback = 100) {
  const columns = Number(output?.columns) || Number(fallback) || 100;
  return Math.max(20, columns - 1);
}

function clamp(value, min, max) {
  const n = Math.floor(Number(value) || 0);
  return Math.max(min, Math.min(max, n));
}

function charDisplayWidth(ch) {
  const cp = String(ch || "").codePointAt(0);
  if (cp == null) return 0;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

const graphemeSegmenter = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function visibleWidth(text) {
  const value = String(text || "");
  let width = 0;
  for (let i = 0; i < value.length;) {
    const ansiMatch = value.slice(i).match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/);
    if (ansiMatch) {
      i += ansiMatch[0].length;
      continue;
    }
    const nextAnsi = value.slice(i).search(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/);
    const end = nextAnsi < 0 ? value.length : i + nextAnsi;
    const plain = value.slice(i, end);
    if (graphemeSegmenter) {
      for (const segment of graphemeSegmenter.segment(plain)) {
        width += [...segment.segment].reduce((sum, char) => sum + charDisplayWidth(char), 0);
      }
    } else {
      for (const char of plain) width += charDisplayWidth(char);
    }
    i = end;
  }
  return width;
}

function truncateDisplayLine(text, width) {
  const source = String(text || "");
  const maxWidth = Math.max(0, Number(width) || 0);
  if (maxWidth <= 0) return "";
  if (visibleWidth(source) <= maxWidth) return source;
  let out = "";
  let used = 0;
  let sawAnsi = false;
  for (let i = 0; i < source.length;) {
    const ansiMatch = source.slice(i).match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/);
    if (ansiMatch) {
      out += ansiMatch[0];
      sawAnsi = true;
      i += ansiMatch[0].length;
      continue;
    }
    const segment = graphemeSegmenter
      ? graphemeSegmenter.segment(source.slice(i))[Symbol.iterator]().next().value?.segment || source[i]
      : source.codePointAt(i) > 0xffff ? source.slice(i, i + 2) : source[i];
    const widthForSegment = [...segment].reduce((sum, char) => sum + charDisplayWidth(char), 0);
    if (used + widthForSegment > maxWidth) break;
    out += segment;
    used += widthForSegment;
    i += segment.length;
  }
  return sawAnsi ? `${out}\x1b[0m` : out;
}

function padLine(line, width) {
  const text = cleanLine(line);
  const maxWidth = Math.max(1, Number(width) || 1);
  const clipped = truncateDisplayLine(text, maxWidth);
  const pad = Math.max(0, maxWidth - visibleWidth(clipped));
  return `${clipped}${" ".repeat(pad)}`;
}

function resolveRawCursor(frame, width, rows) {
  const lines = Array.isArray(frame?.frameLines) ? frame.frameLines.map(cleanLine) : [];
  const safeLines = lines.length > 0 ? lines : [""];
  const cursorRow = clamp(frame?.cursorRow || 1, 1, Math.max(1, safeLines.length));
  const cursorCol = clamp(frame?.cursorCol || 1, 1, width);
  const start = safeLines.length > rows ? Math.min(Math.max(0, cursorRow - rows), safeLines.length - rows) : 0;
  const visible = safeLines.slice(start, start + rows);
  return {
    row: clamp(cursorRow - start, 1, Math.max(1, visible.length)),
    col: cursorCol,
    visible,
  };
}

function resolveStructuredCursor(frame, width, rows) {
  const workspaceLines = Array.isArray(frame?.workspaceLines) ? frame.workspaceLines.map(cleanLine) : [];
  const attentionLines = Array.isArray(frame?.attentionLines) ? frame.attentionLines.map(cleanLine) : [];
  const inputLines = Array.isArray(frame?.inputLines) && frame.inputLines.length > 0
    ? frame.inputLines.map(cleanLine)
    : [""];
  const statusLine = cleanLine(frame?.statusLine || "");
  const hintLines = splitLines(frame?.hintLine || "");
  const bottomRows = attentionLines.length + 1 + inputLines.length + 1 + (statusLine ? 1 : 0) + hintLines.length;
  const visibleWorkspace = visibleWorkspaceLines(workspaceLines, rows, bottomRows);
  const cursorRowOffset = Math.max(0, Math.floor(Number(frame?.cursorRowOffset) || 0));
  return {
    row: clamp(visibleWorkspace.length + attentionLines.length + 2 + cursorRowOffset, 1, rows),
    col: clamp(frame?.cursorCol || 1, 1, width),
    visibleWorkspace,
    attentionLines,
    inputLines,
    statusLine,
    hintLines,
  };
}

function visibleWorkspaceLines(workspaceLines, rows, bottomRows) {
  const budget = Math.max(0, rows - bottomRows);
  if (budget <= 0) return [];
  if (workspaceLines.length <= budget) return workspaceLines;
  return workspaceLines.slice(workspaceLines.length - budget);
}

function padFrameRows(lines, rows, width) {
  const out = (Array.isArray(lines) ? lines : []).map((line) => padLine(line, width));
  const targetRows = Math.max(1, Math.floor(Number(rows) || 1));
  while (out.length < targetRows) {
    out.push(padLine("", width));
  }
  return out.slice(0, targetRows);
}

function terminalFrameLines(frame, width, rows) {
  if (frame?.mode === "rawFrame") {
    const { visible } = resolveRawCursor(frame, width, rows);
    return padFrameRows(visible, rows, width);
  }
  const { visibleWorkspace, attentionLines, inputLines, statusLine, hintLines } = resolveStructuredCursor(frame, width, rows);
  const separatorGlyph = String(frame?.separatorGlyph || "-").slice(0, 1) || "-";
  const separator = separatorLine(separatorGlyph, width);
  const lines = [
    ...visibleWorkspace,
    ...attentionLines,
    separator,
    ...inputLines,
    separator,
    ...(statusLine ? [statusLine] : []),
    ...hintLines,
  ];
  return padFrameRows(lines, rows, width);
}

export class InkTuiLayout {
  constructor({ input, output, error = process.stderr } = {}) {
    this.input = input || process.stdin;
    this.output = output || process.stdout;
    this.error = error;
    this.renderVersion = 0;
    this.cursorTarget = { row: 1, col: 1 };
    this.inAlternateScreen = false;
    this.frame = {
      workspaceLines: [],
      attentionLines: [],
      inputLines: [""],
      statusLine: "",
      hintLine: "",
      separatorGlyph: "-",
      cursorRowOffset: 0,
      cursorCol: 1,
      columns: terminalRenderWidth(this.output, 100),
      rows: Math.max(8, this.output.rows || 30),
    };
  }

  render(frame = {}) {
    this.frame = {
      ...this.frame,
      ...frame,
      columns: terminalRenderWidth(this.output, this.frame.columns || 100),
      rows: Math.max(8, this.output.rows || this.frame.rows || 30),
    };

    this.cursorTarget = this.resolveCursorTarget(this.frame);
    if (!this.inAlternateScreen) {
      this.output.write("\x1b[?1049h\x1b[2J\x1b[H");
      this.inAlternateScreen = true;
    }
    this.paintFrame();
  }

  resolveCursorTarget(frame = this.frame) {
    const width = Math.max(20, Number(frame?.columns) || 100);
    const rows = Math.max(8, Number(frame?.rows) || 30);
    if (frame?.mode === "rawFrame") {
      const { row, col } = resolveRawCursor(frame, width, rows);
      return { row, col };
    }
    const { row, col } = resolveStructuredCursor(frame, width, rows);
    return { row, col };
  }

  paintFrame() {
    this.renderVersion += 1;
    const width = Math.max(20, Number(this.frame?.columns) || 100);
    const rows = Math.max(8, Number(this.frame?.rows) || 30);
    const lines = terminalFrameLines(this.frame, width, rows);
    const row = clamp(this.cursorTarget?.row || 1, 1, rows);
    const col = clamp(this.cursorTarget?.col || 1, 1, width);
    try {
      this.output.write(`\x1b[?25l\x1b[H\x1b[J${lines.join("\r\n")}\x1b[${row};${col}H\x1b[?25h`);
    } catch {
      // best effort
    }
  }

  destroy() {
    try {
      this.renderVersion += 1;
    } catch {
      // best effort
    } finally {
      try {
        if (this.inAlternateScreen) {
          this.output.write("\x1b[?1049l");
          this.inAlternateScreen = false;
        }
        this.output.write("\x1b[?25h");
      } catch {
        // best effort
      }
    }
  }
}

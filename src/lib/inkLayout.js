import React from "react";
import { Box, Text, render } from "ink";

const h = React.createElement;

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

function stripAnsi(text) {
  return String(text || "").replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/g, "");
}

function visibleWidth(text) {
  return stripAnsi(text).length;
}

function padLine(line, width) {
  const text = cleanLine(line);
  const maxWidth = Math.max(1, Number(width) || 1);
  const clipped = visibleWidth(text) > maxWidth ? text.slice(0, maxWidth) : text;
  const pad = Math.max(0, maxWidth - visibleWidth(clipped));
  return `${clipped}${" ".repeat(pad)}`;
}

function Line({ children, width = 1, dim = false, bold = false }) {
  return h(Text, { wrap: "truncate", dimColor: dim, bold }, padLine(children, width));
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
  const inputLines = Array.isArray(frame?.inputLines) && frame.inputLines.length > 0
    ? frame.inputLines.map(cleanLine)
    : [""];
  const statusLine = cleanLine(frame?.statusLine || "");
  const hintLines = splitLines(frame?.hintLine || "");
  const bottomRows = 1 + inputLines.length + 1 + (statusLine ? 1 : 0) + hintLines.length;
  const visibleWorkspace = visibleWorkspaceLines(workspaceLines, rows, bottomRows);
  const cursorRowOffset = Math.max(0, Math.floor(Number(frame?.cursorRowOffset) || 0));
  return {
    row: clamp(visibleWorkspace.length + 2 + cursorRowOffset, 1, rows),
    col: clamp(frame?.cursorCol || 1, 1, width),
    visibleWorkspace,
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

function padFrameRows(elements, rows, keyPrefix, width) {
  const out = Array.isArray(elements) ? [...elements] : [];
  const targetRows = Math.max(1, Math.floor(Number(rows) || 1));
  while (out.length < targetRows) {
    out.push(h(Line, { key: `${keyPrefix}-clear-${out.length}`, width }, ""));
  }
  return out.slice(0, targetRows);
}

function InkRawFrame({ frame, width, rows }) {
  const { visible } = resolveRawCursor(frame, width, rows);
  const elements = visible.map((line, index) => h(Line, { key: `raw-${index}`, width }, line));
  return h(
    Box,
    { flexDirection: "column", width, height: rows, overflow: "hidden" },
    ...padFrameRows(elements, rows, "raw", width)
  );
}

function InkStructuredFrame({ frame, width, rows }) {
  const { visibleWorkspace, inputLines, statusLine, hintLines } = resolveStructuredCursor(frame, width, rows);
  const separatorGlyph = String(frame?.separatorGlyph || "-").slice(0, 1) || "-";
  const separator = separatorLine(separatorGlyph, width);
  const elements = [];

  visibleWorkspace.forEach((line, index) => {
    elements.push(h(Line, { key: `w-${index}`, width }, line));
  });
  elements.push(h(Line, { key: "sep-top", width, dim: true }, separator));
  inputLines.forEach((line, index) => {
    elements.push(h(Line, { key: `i-${index}`, width, bold: index === 0 }, line));
  });
  elements.push(h(Line, { key: "sep-bottom", width, dim: true }, separator));
  if (statusLine) elements.push(h(Line, { key: "status", width, dim: true }, statusLine));
  hintLines.forEach((line, index) => {
    elements.push(h(Line, { key: `h-${index}`, width, dim: true }, line));
  });

  return h(
    Box,
    { flexDirection: "column", width, height: rows, overflow: "hidden" },
    ...padFrameRows(elements, rows, "structured", width)
  );
}

function InkTuiApp({ frame }) {
  const width = Math.max(20, Number(frame?.columns) || 100);
  const rows = Math.max(8, Number(frame?.rows) || 30);
  if (frame?.mode === "rawFrame") {
    return h(InkRawFrame, { frame, width, rows });
  }
  return h(InkStructuredFrame, { frame, width, rows });
}

export class InkTuiLayout {
  constructor({ input, output, error = process.stderr } = {}) {
    this.input = input || process.stdin;
    this.output = output || process.stdout;
    this.error = error;
    this.instance = null;
    this.renderVersion = 0;
    this.cursorTarget = { row: 1, col: 1 };
    this.inAlternateScreen = false;
    this.frame = {
      workspaceLines: [],
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
    const tree = h(InkTuiApp, { frame: this.frame });
    if (!this.instance) {
      this.output.write("\x1b[?1049h\x1b[2J\x1b[H");
      this.inAlternateScreen = true;
      this.instance = render(tree, {
        stdin: this.input,
        stdout: this.output,
        stderr: this.error,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
        alternateScreen: true,
        incrementalRendering: false,
        maxFps: 20,
      });
      this.scheduleCursorSync();
      return;
    }
    this.instance.rerender(tree);
    this.scheduleCursorSync();
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

  scheduleCursorSync() {
    const version = ++this.renderVersion;
    const sync = () => {
      if (!this.instance || version !== this.renderVersion) return;
      const row = clamp(this.cursorTarget?.row || 1, 1, Math.max(1, this.frame.rows || 30));
      const col = clamp(this.cursorTarget?.col || 1, 1, Math.max(1, this.frame.columns || 100));
      try {
        this.output.write(`\x1b[${row};${col}H\x1b[?25h`);
      } catch {
        // best effort
      }
    };

    const waitUntilRenderFlush = this.instance?.waitUntilRenderFlush?.bind(this.instance);
    if (waitUntilRenderFlush) {
      waitUntilRenderFlush().then(sync, sync);
      return;
    }
    setImmediate(sync);
  }

  destroy() {
    try {
      this.renderVersion += 1;
      if (this.instance) {
        this.instance.unmount();
        this.instance.cleanup?.();
      }
    } catch {
      // best effort
    } finally {
      this.instance = null;
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

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

function Line({ children, dim = false, bold = false }) {
  const line = cleanLine(children);
  return h(Text, { wrap: "truncate", dimColor: dim, bold }, line === "" ? " " : line);
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

function InkRawFrame({ frame, width, rows }) {
  const { visible } = resolveRawCursor(frame, width, rows);
  return h(
    Box,
    { flexDirection: "column", width, overflow: "hidden" },
    ...visible.map((line, index) => h(Line, { key: `raw-${index}` }, line))
  );
}

function InkStructuredFrame({ frame, width, rows }) {
  const { visibleWorkspace, inputLines, statusLine, hintLines } = resolveStructuredCursor(frame, width, rows);
  const separatorGlyph = String(frame?.separatorGlyph || "-").slice(0, 1) || "-";
  const separator = separatorLine(separatorGlyph, width);

  return h(
    Box,
    { flexDirection: "column", width, overflow: "hidden" },
    ...visibleWorkspace.map((line, index) => h(Line, { key: `w-${index}` }, line)),
    h(Line, { key: "sep-top", dim: true }, separator),
    ...inputLines.map((line, index) => h(Line, { key: `i-${index}`, bold: index === 0 }, line)),
    h(Line, { key: "sep-bottom", dim: true }, separator),
    statusLine ? h(Line, { key: "status", dim: true }, statusLine) : null,
    ...hintLines.map((line, index) => h(Line, { key: `h-${index}`, dim: true }, line))
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
        this.output.write("\x1b[?25h");
      } catch {
        // best effort
      }
    }
  }
}

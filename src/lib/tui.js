import { DEFAULT_INPUT_HINTS, sanitizeInputHints } from "./inputHints.js";

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/g;
const TERMINAL_PAINT_PREFIX = "\x1b[?25l\x1b%G\x1b(B\x1b[0m\x1b[2J\x1b[H";

function stripAnsi(text) {
  return String(text || "").replace(ANSI_PATTERN, "");
}

function truncateLine(line, width) {
  const text = String(line ?? "");
  const maxWidth = Math.max(0, Number(width) || 0);
  if (maxWidth <= 0) return "";
  if (stringDisplayWidth(text) <= maxWidth) return text;

  const ellipsis = maxWidth > 3 ? "..." : "";
  const targetWidth = Math.max(0, maxWidth - stringDisplayWidth(ellipsis));
  let out = "";
  let used = 0;
  let sawAnsi = false;
  for (let i = 0; i < text.length;) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
    if (ansiMatch) {
      out += ansiMatch[0];
      sawAnsi = true;
      i += ansiMatch[0].length;
      continue;
    }
    const ch = text[i];
    const cp = text.codePointAt(i);
    const char = cp != null && cp > 0xffff ? text.slice(i, i + 2) : ch;
    const w = charDisplayWidth(char);
    if (used + w > targetWidth) break;
    out += char;
    used += w;
    i += char.length;
  }
  return `${out}${ellipsis}${sawAnsi ? "\x1b[0m" : ""}`;
}

function wrapText(text, width) {
  const source = String(text ?? "").replace(/\r/g, "");
  const maxWidth = Math.max(1, Number(width) || 1);
  if (maxWidth <= 1) return [source];
  const out = [];

  const splitLongWord = (word) => {
    const chunks = [];
    let chunk = "";
    let chunkWidth = 0;
    for (let i = 0; i < word.length;) {
      const ansiMatch = word.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (ansiMatch) {
        chunk += ansiMatch[0];
        i += ansiMatch[0].length;
        continue;
      }
      const cp = word.codePointAt(i);
      const char = cp != null && cp > 0xffff ? word.slice(i, i + 2) : word[i];
      const charWidth = charDisplayWidth(char);
      if (chunk && chunkWidth + charWidth > maxWidth) {
        chunks.push(chunk);
        chunk = "";
        chunkWidth = 0;
      }
      chunk += char;
      chunkWidth += charWidth;
      i += char.length;
    }
    if (chunk || chunks.length === 0) chunks.push(chunk);
    return chunks;
  };

  for (const paragraph of source.split("\n")) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const wordWidth = stringDisplayWidth(word);
      if (!line) {
        if (wordWidth <= maxWidth) {
          line = word;
        } else {
          const chunks = splitLongWord(word);
          out.push(...chunks.slice(0, -1));
          line = chunks[chunks.length - 1] || "";
        }
        continue;
      }
      const next = `${line} ${word}`;
      if (stringDisplayWidth(next) <= maxWidth) {
        line = next;
      } else {
        out.push(line);
        if (wordWidth <= maxWidth) {
          line = word;
        } else {
          const chunks = splitLongWord(word);
          out.push(...chunks.slice(0, -1));
          line = chunks[chunks.length - 1] || "";
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function renderInlineMarkdown(line) {
  let out = String(line || "");

  // Images first so they do not get picked up as normal links.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt, url) => `${color("image", "1;35")}${alt ? color(` ${alt}`, "35") : ""}${color(` (${url})`, "2;37")}`
  );
  out = out.replace(
    /`([^`]+)`/g,
    (_m, content) => color(content, "34")
  );
  out = out.replace(
    /(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g,
    (_m, _d, content) => color(content, "1")
  );
  out = out.replace(
    /(~~)(?!\s)(.+?)(?<!\s)\1/g,
    (_m, _d, content) => color(content, "9;2")
  );
  out = out.replace(
    /(^|[^*_])([*_])(?!\s)([^*_]+?)(?<!\s)\2/g,
    (_m, prefix, _d, content) => `${prefix}${color(content, "3")}`
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => `${color(text, "4;34")}${color(` (${url})`, "2;37")}`
  );
  return out;
}

function stripMarkdownForTableCell(value) {
  return stripAnsi(renderInlineMarkdown(String(value || "").trim()));
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;
  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells.length >= 2 ? cells : null;
}

function parseMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  if (!cells) return null;
  const aligns = [];
  for (const cell of cells) {
    const value = String(cell || "").trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

function padTableCell(text, width, align = "left") {
  const value = String(text || "");
  const pad = Math.max(0, width - stringDisplayWidth(value));
  if (align === "right") return `${" ".repeat(pad)}${value}`;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(pad - left)}`;
  }
  return `${value}${" ".repeat(pad)}`;
}

function renderMarkdownTable(lines, startIndex) {
  const header = splitMarkdownTableRow(lines[startIndex]);
  const aligns = parseMarkdownTableSeparator(lines[startIndex + 1]);
  if (!header || !aligns) return null;

  const rows = [];
  let i = startIndex + 2;
  while (i < lines.length) {
    const row = splitMarkdownTableRow(lines[i]);
    if (!row) break;
    rows.push(row);
    i += 1;
  }

  const columnCount = Math.max(header.length, aligns.length, ...rows.map((row) => row.length));
  const normalize = (row) => Array.from({ length: columnCount }, (_v, idx) => stripMarkdownForTableCell(row[idx] || ""));
  const normalizedHeader = normalize(header);
  const normalizedRows = rows.map(normalize);
  const widths = Array.from({ length: columnCount }, (_v, idx) =>
    Math.min(
      40,
      Math.max(
        stringDisplayWidth(normalizedHeader[idx] || ""),
        ...normalizedRows.map((row) => stringDisplayWidth(row[idx] || "")),
        3
      )
    )
  );
  const renderRow = (row, style = "") => {
    const cells = row.map((cell, idx) => padTableCell(cell, widths[idx], aligns[idx] || "left"));
    const text = `│ ${cells.join(" │ ")} │`;
    return style ? color(text, style) : text;
  };
  const sep = color(`├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`, "2;37");
  return {
    nextIndex: i,
    rendered: [renderRow(normalizedHeader, "1"), sep, ...normalizedRows.map((row) => renderRow(row))],
  };
}

function parseMarkdownBlocks(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", lines: paragraph });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w.+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = String(fence[1] || "").trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", lang, lines: codeLines, closed: i < lines.length });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      blocks.push({ type: "blank" });
      continue;
    }

    const table = i + 1 < lines.length ? renderMarkdownTable(lines, i) : null;
    if (table) {
      flushParagraph();
      blocks.push({ type: "table", rendered: table.rendered });
      i = table.nextIndex - 1;
      continue;
    }

    const header = line.match(/^(#{1,6})\s+(.+)$/);
    if (header) {
      flushParagraph();
      blocks.push({ type: "heading", level: header[1].length, text: header[2] });
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ type: "hr" });
      continue;
    }

    const quoteMatch = line.match(/^(>+)\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      const quoteLines = [];
      let maxDepth = 1;
      while (i < lines.length) {
        const q = lines[i].match(/^(>+)\s?(.*)$/);
        if (!q) break;
        maxDepth = Math.max(maxDepth, q[1].length);
        quoteLines.push({ depth: q[1].length, text: q[2] });
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "quote", lines: quoteLines, depth: maxDepth });
      continue;
    }

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX~-])\]\s+(.+)$/);
    if (task) {
      flushParagraph();
      blocks.push({
        type: "task",
        indent: task[1],
        state: String(task[2] || " "),
        text: task[3],
      });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: "bullet", indent: bullet[1], text: bullet[2] });
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      blocks.push({ type: "ordered", indent: ordered[1], number: ordered[2], text: ordered[3] });
      continue;
    }

    const indentedCode = line.match(/^( {4}|\t)(.*)$/);
    if (indentedCode) {
      flushParagraph();
      const codeLines = [];
      while (i < lines.length) {
        const c = lines[i].match(/^( {4}|\t)(.*)$/);
        if (!c) break;
        codeLines.push(c[2]);
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "code", lang: "", lines: codeLines, closed: true, indented: true });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

function normalizeTimelineSpacing(lines) {
  const result = [];
  let previousGroup = "";

  const classify = (line) => {
    const plain = stripAnsi(String(line || "")).trimStart();
    if (!plain) return "blank";
    if (/^(?:◆|\*)\s+Task:/i.test(plain)) return "task";
    if (/^(?:↳|->)\s+/.test(plain)) return "tool-result";
    if (/^(?:›|>)\s+/.test(plain)) return "tool";
    if (/^(?:•|\*|✓|×|\[ok\]|\[x\])\s+/.test(plain)) return "response";
    if (/^\s{2,}\S/.test(String(line || ""))) return previousGroup || "continuation";
    return "content";
  };

  for (const line of Array.isArray(lines) ? lines : []) {
    const group = classify(line);
    const shouldSeparate =
      result.length > 0 &&
      group !== "blank" &&
      previousGroup &&
      previousGroup !== "blank" &&
      previousGroup !== group;
    if (shouldSeparate && result[result.length - 1] !== "") result.push("");
    result.push(line);
    previousGroup = group;
  }

  return result;
}

function renderMarkdownBlock(block) {
  if (!block || typeof block !== "object") return [];
  switch (block.type) {
    case "blank":
      return [""];
    case "code":
      return block.lines.map((line) => color(line || " ", "36"));
    case "table":
      return Array.isArray(block.rendered) ? block.rendered : [];
    case "heading": {
      const level = Number(block.level) || 1;
      const prefix = level <= 2 ? "◆" : level <= 4 ? "›" : "·";
      const rendered = renderInlineMarkdown(block.text);
      return [level <= 2 ? color(`${prefix} ${rendered}`, "1;36") : color(`${prefix} ${rendered}`, "1")];
    }
    case "hr":
      return [];
    case "quote":
      return (Array.isArray(block.lines) ? block.lines : []).map((item) => {
        const depth = Math.max(1, Number(item.depth) || 1);
        const bars = color("│".repeat(Math.min(3, depth)), "2;37");
        return `${bars} ${color(renderInlineMarkdown(item.text), "3;37")}`;
      });
    case "task": {
      const state = String(block.state || " ");
      const marker = /x/i.test(state) ? color("[x]", "1;32") : /[~-]/.test(state) ? color("[~]", "1;33") : color("[ ]", "2;37");
      return [`${block.indent || ""}${marker} ${renderInlineMarkdown(block.text)}`];
    }
    case "bullet": {
      const depth = Math.floor(String(block.indent || "").replace(/\t/g, "  ").length / 2);
      const glyph = depth <= 0 ? "•" : depth === 1 ? "◦" : "▪";
      return [`${block.indent || ""}${color(glyph, "2;37")} ${renderInlineMarkdown(block.text)}`];
    }
    case "ordered":
      return [`${block.indent || ""}${color(`${block.number}.`, "2;37")} ${renderInlineMarkdown(block.text)}`];
    case "paragraph":
      return (Array.isArray(block.lines) ? block.lines : [block.text]).map((line) => renderInlineMarkdown(line));
    default:
      return [renderInlineMarkdown(block.text || "")];
  }
}

function renderMarkdownLines(text) {
  return parseMarkdownBlocks(text).flatMap((block) => renderMarkdownBlock(block));
}

function highlightOverlaySectionLine(line) {
  const text = String(line || "");
  if (/^\s*SYSTEM:/i.test(text)) {
    return text.replace(/^\s*SYSTEM:/i, (m) => color(m.trim(), "1;30;46"));
  }
  if (/^\s*USER:/i.test(text)) {
    return text.replace(/^\s*USER:/i, (m) => color(m.trim(), "1;30;42"));
  }
  if (/^\s*MESSAGES:/i.test(text)) {
    return text.replace(/^\s*MESSAGES:/i, (m) => color(m.trim(), "1;30;44"));
  }
  if (/^\s*TOOLS:/i.test(text)) {
    return text.replace(/^\s*TOOLS:/i, (m) => color(m.trim(), "1;30;45"));
  }
  if (/^\s*Request:/i.test(text)) {
    return text.replace(/^\s*Request:/i, (m) => color(m.trim(), "1;36"));
  }
  if (/^\s*Response:/i.test(text)) {
    return text.replace(/^\s*Response:/i, (m) => color(m.trim(), "1;35"));
  }
  if (/^\s*Response Key Content:/i.test(text)) {
    return text.replace(/^\s*Response Key Content:/i, (m) => color(m.trim(), "1;33"));
  }
  if (/^\s*Response Raw:/i.test(text)) {
    return text.replace(/^\s*Response Raw:/i, (m) => color(m.trim(), "1;90"));
  }
  if (/^\s*Thinking Output:/i.test(text)) {
    return text.replace(/^\s*Thinking Output:/i, (m) => color(m.trim(), "1;32"));
  }
  if (/"role"\s*:\s*"user"/i.test(text)) {
    return color(text, "30;102");
  }
  return text;
}

function trimWorkspaceText(text, maxChars = 6000) {
  const source = String(text || "");
  const limit = Math.max(200, Number(maxChars) || 6000);
  if (source.length <= limit) return { text: source, trimmed: 0 };
  const trimmed = source.length - limit;
  return {
    text: `${source.slice(0, limit)}\n\n[trimmed ${trimmed} chars]`,
    trimmed,
  };
}

function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp == null) return 0;
  // Control chars, combining marks, zero-width joiners, and variation selectors
  // do not advance the terminal cursor by themselves.
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
  // East Asian wide/fullwidth + emoji ranges.
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

function isEmojiCodePoint(cp) {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  );
}

function graphemeDisplayWidth(cluster) {
  const text = String(cluster || "");
  if (!text) return 0;
  let width = 0;
  let hasEmoji = false;
  let hasJoinerOrVariation = false;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const char = cp != null && cp > 0xffff ? text.slice(i, i + 2) : text[i];
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) hasJoinerOrVariation = true;
    if (isEmojiCodePoint(cp)) hasEmoji = true;
    width += charDisplayWidth(char);
    i += char.length;
  }
  // ZWJ emoji and emoji-presentation clusters render as one terminal glyph.
  if (hasEmoji && hasJoinerOrVariation) return 2;
  return width;
}

function stringDisplayWidth(value) {
  const text = String(value || "");
  let width = 0;
  for (let i = 0; i < text.length;) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
    if (ansiMatch) {
      i += ansiMatch[0].length;
      continue;
    }
    const ansiIndex = text.slice(i).search(/\x1b\[[0-9;?]*[ -/]*[@-~]/);
    const end = ansiIndex < 0 ? text.length : i + ansiIndex;
    const plain = text.slice(i, end);
    if (graphemeSegmenter) {
      for (const segment of graphemeSegmenter.segment(plain)) {
        width += graphemeDisplayWidth(segment.segment);
      }
    } else {
      for (let j = 0; j < plain.length;) {
        const cp = plain.codePointAt(j);
        const char = cp != null && cp > 0xffff ? plain.slice(j, j + 2) : plain[j];
        width += charDisplayWidth(char);
        j += char.length;
      }
    }
    i = end;
  }
  return width;
}

function formatCompactNumber(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const v = (value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1);
    return `${v.replace(/\.0$/, "")}m`;
  }
  if (abs >= 1_000) {
    const v = (value / 1_000).toFixed(abs >= 10_000 ? 0 : 1);
    return `${v.replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

function separatorLine(width, useUnicode = true) {
  const glyph = useUnicode ? "─" : "-";
  return `\x1b[90m${glyph.repeat(Math.max(1, Number(width) || 1))}\x1b[0m`;
}

function shouldUseUnicodeSymbols(env = process.env) {
  const explicit = String(env.PIECODE_TUI_UNICODE || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicit)) return true;
  if (["0", "false", "no", "off"].includes(explicit)) return false;
  if (String(env.PIECODE_TUI_ASCII || "").trim()) return false;
  const term = String(env.TERM || "").toLowerCase();
  const termProgram = String(env.TERM_PROGRAM || "").toLowerCase();
  const lang = String(env.LC_ALL || env.LC_CTYPE || env.LANG || "").toLowerCase();
  if (term === "linux" || term === "dumb" || term.includes("vt100")) return false;
  if (termProgram.includes("linux")) return false;
  if (lang && !/(utf-?8|utf8)/i.test(lang)) return false;
  return true;
}

function makeTuiSymbols(useUnicode = true) {
  return useUnicode
    ? {
        prompt: "❯",
        task: "◆",
        tool: "›",
        result: "",
        response: "•",
        ok: "✓",
        fail: "×",
        dot: "·",
        agent: "◦",
        bullet: "•",
        nestedBullet: "◦",
        deepBullet: "▪",
        quoteBar: "│",
        subheading: "›",
        up: "↑",
        down: "↓",
        todoDoneNotice: "所有 TODO 已完成，可以结束了",
      }
    : {
        prompt: ">",
        task: "*",
        tool: ">",
        result: "->",
        response: "*",
        ok: "[ok]",
        fail: "[x]",
        dot: "-",
        agent: "-",
        bullet: "*",
        nestedBullet: "-",
        deepBullet: "-",
        quoteBar: "|",
        subheading: ">",
        up: "up:",
        down: "down:",
        todoDoneNotice: "All TODO completed.",
      };
}

function padDisplayLine(line, width) {
  const text = String(line ?? "");
  const maxWidth = Math.max(0, Number(width) || 0);
  if (maxWidth <= 0) return "";
  const truncated = truncateLine(text, maxWidth);
  const pad = Math.max(0, maxWidth - stringDisplayWidth(stripAnsi(truncated)));
  return `${truncated}${" ".repeat(pad)}`;
}

function renderFrameLines(lines, width, height = 0) {
  const paintWidth = Math.max(1, (Number(width) || 1) - 1);
  const out = (Array.isArray(lines) ? lines : []).map((line) => padDisplayLine(line, paintWidth));
  const minHeight = Math.max(0, Number(height) || 0);
  while (out.length < minHeight) out.push(padDisplayLine("", paintWidth));
  return out.join("\n");
}

function terminalFrame(frame) {
  // Some commands can leave terminal newline handling in a state where LF no
  // longer returns to column 1. Use CRLF for full-frame paints so the cursor
  // position stays stable after long shell/tool runs.
  return String(frame || "").replace(/\n/g, "\r\n");
}

function colorFullLine(line, code, width) {
  return color(padDisplayLine(line, Math.max(1, (Number(width) || 1) - 1)), code);
}

function hasBackgroundColor(line) {
  return /\x1b\[[0-9;]*4\d(?:;[0-9]*)*m|\x1b\[[0-9;]*48;[0-9;]*m/.test(String(line || ""));
}

function timelineContinuationIndent(line) {
  const plain = stripAnsi(String(line || ""));
  if (!plain.trim()) return "";
  const leading = plain.match(/^\s*/)?.[0] || "";
  const trimmed = plain.slice(leading.length);
  if (/^(?:◆|\*)\s+Task:/i.test(trimmed)) return leading;
  if (/^(?:↳|->)\s+/.test(trimmed)) return `${leading}  `;
  if (/^(?:›|>)\s+/.test(trimmed)) return `${leading}  `;
  const ordered = trimmed.match(/^(\d+[.)])\s+/);
  if (ordered) return `${leading}${" ".repeat(stringDisplayWidth(ordered[1]) + 1)}`;
  if (/^(?:•|◦|▪|-)\s+/.test(trimmed)) return `${leading}  `;
  if (/^(?:•|\*|✓|×|\[ok\]|\[x\]|\[i\])\s+/.test(trimmed)) return `${leading}  `;
  if (leading.length > 0) return leading;
  return "  ";
}

function wrapTimelineLine(line, width) {
  // Full-line background blocks (notably Task rows) must not be word-wrapped:
  // wrapText splits on whitespace and drops padded trailing spaces, which makes
  // the background color cover only the text instead of the whole row.
  if (hasBackgroundColor(line) && stringDisplayWidth(stripAnsi(line)) <= Math.max(0, Number(width) || 0)) {
    return [line];
  }
  const chunks = wrapText(line, width);
  if (chunks.length <= 1) return chunks;
  const indent = timelineContinuationIndent(line);
  if (!indent) return chunks;
  const continuationWidth = Math.max(8, Math.max(1, Number(width) || 1) - stringDisplayWidth(indent));
  const out = [chunks[0]];
  for (const chunk of chunks.slice(1)) {
    const nested = wrapText(chunk, continuationWidth);
    out.push(...nested.map((part) => (part ? `${indent}${part}` : "")));
  }
  return out;
}

export class SimpleTui {
  constructor({ out, workspaceDir, providerLabel, getSkillsLabel, getApprovalLabel, layout = null }) {
    this.out = out;
    this.workspaceDir = workspaceDir;
    this.providerLabel = providerLabel;
    this.getSkillsLabel = getSkillsLabel;
    this.getApprovalLabel = getApprovalLabel;
    this.layout = layout;
    this.logs = [];
    this.maxLogs = 2000;
    this.activity = [];
    this.maxActivity = 8;
    this.timeline = [];
    this.maxTimeline = 2000;
    this.todos = [];
    this.showTodoPanel = false;
    this.active = false;
    this.modelState = "idle";
    this.modelName = "";
    this.lastTurnMs = null;
    this.lastError = "";
    this.lastTool = "";
    this.lastStatus = "Ready";
    this.taskStartedAt = 0;
    this.taskCompletedAt = 0;
    this.thinking = false;
    this.thinkingStage = "";
    this.contextUsed = 0;
    this.contextLimit = 0;
    this.turnTokensSent = 0;
    this.turnTokensReceived = 0;
    this.sessionTokensSent = 0;
    this.sessionTokensReceived = 0;
    this.turnStartedAt = 0;
    this.currentTaskText = "";
    this.llmDebugEnabled = false;
    this.lastLlmRequest = "";
    this.lastLlmResponse = "";
    this.showRawLogs = false;
    this.lastFrameLineCount = 0;
    this.lastInputRow = 0;
    this.lastInputLine = "";
    this.approvalPrompt = "";
    this.approvalMeta = null;
    this.approvalDefaultYes = false;
    this.clarificationPrompt = null;
    this.inputHint = "";
    this.startupShortcutHint = "";
    this.inputHints = sanitizeInputHints(DEFAULT_INPUT_HINTS);
    this.inputHintIndex = 0;
    this.currentInput = "";
    this.thinkingTick = 0;
    this.thinkingTimer = null;
    this.animateThinking = String(process.env.PIECODE_TUI_ANIMATION || "").trim() === "1";
    this.modelSuggestionsVisible = false;
    this.modelSuggestions = [];
    this.modelSuggestionIndex = 0;
    this.modelSuggestionWindowStart = 0;
    this.modelSuggestionMaxVisible = 8;
    this.commandSuggestionsVisible = false;
    this.commandSuggestions = [];
    this.commandSuggestionIndex = 0;
    this.commandSuggestionLabel = "commands";
    this.scrollOffset = 0;
    this.lastScrollMax = 0;
    this.lastScrollSourceLength = 0;
    this.thoughtStreamText = "";
    this.thoughtStreamVisible = false;
    this.planModeEnabled = false;
    this.projectInstructionsStatus = {
      state: "unknown",
      source: "AGENTS.md",
      detail: "",
    };
    this.showProjectInstructionsStatus = true;
    this.transientStatusNotice = "";
    this.overlayVisible = false;
    this.overlayTitle = "";
    this.overlayText = "";
    this.overlayScroll = 0;
    this.overlayMode = "";
    this.overlayHint = "";
    this.overlaySearchActive = false;
    this.overlaySearchQuery = "";
    this.mouseCaptureEnabled = String(process.env.PIECODE_MOUSE_CAPTURE || "").trim() === "1";
    this.unicodeSymbols = shouldUseUnicodeSymbols(process.env);
    this.symbols = makeTuiSymbols(this.unicodeSymbols);
  }

  isMouseCaptureEnabled() {
    return Boolean(this.mouseCaptureEnabled);
  }

  start() {
    this.active = true;
    // Keep terminal-native selection enabled by default; mouse capture is opt-in.
    if (!this.layout && this.mouseCaptureEnabled) {
      this.out.write("\x1b[?1000h\x1b[?1006h");
    }
    if (!this.layout) this.out.write("\x1b[?25h");
    this.render("", "Ready. Type /help for commands.");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stopThinkingAnimation();
    // Disable mouse reporting on exit (only if it was enabled).
    if (!this.layout) {
      if (this.mouseCaptureEnabled) this.out.write("\x1b[?1000l\x1b[?1006l");
      this.out.write("\x1b[2J\x1b[H\x1b[?25h");
    }
  }

  event(line) {
    if (String(line || "").startsWith("[task] ")) {
      this.currentTaskText = String(line).slice(7).trim();
      this.taskStartedAt = Date.now();
      this.taskCompletedAt = 0;
      this.scrollOffset = 0;
    }
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${line}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(this.logs.length - this.maxLogs);
    }
    this.activity.push(entry);
    if (this.activity.length > this.maxActivity) {
      this.activity = this.activity.slice(this.activity.length - this.maxActivity);
    }
    const timelineLines = this.formatTimelineLines(String(line || ""));
    const spacedTimelineLines = this.withTimelineSpacing(timelineLines);
    for (const item of spacedTimelineLines) {
      this.timeline.push(item);
    }
    if (this.timeline.length > this.maxTimeline) {
      this.timeline = this.timeline.slice(this.timeline.length - this.maxTimeline);
    }
  }

  scrollLines(delta) {
    const amount = Number(delta) || 0;
    const step = Math.max(1, Math.round(Math.abs(amount)));
    const direction = amount < 0 ? -1 : 1;
    const max = Math.max(0, Number(this.lastScrollMax) || 0);
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + direction * step));
    this.render();
    return this.scrollOffset;
  }

  scrollPage(direction = 1) {
    const page = Math.max(3, Math.floor((this.out.rows || 30) * 0.5));
    return this.scrollLines((Number(direction) < 0 ? -1 : 1) * page);
  }

  scrollToTop() {
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.render();
    return this.scrollOffset;
  }

  scrollToBottom() {
    this.scrollOffset = 0;
    this.render();
    return this.scrollOffset;
  }

  onModelCall(label) {
    this.modelState = "running";
    this.modelName = label || this.modelName;
    this.thinking = true;
    this.thinkingStage = "model";
    this.lastStatus = "Model call in progress";
    this.render();
  }

  onToolUse(toolName) {
    this.lastTool = toolName || this.lastTool;
    this.lastStatus = `Using tool: ${toolName}`;
    this.render();
  }

  onTurnSuccess(durationMs) {
    this.taskCompletedAt = Date.now();
    this.modelState = "idle";
    this.thinking = false;
    this.thinkingStage = "";
    this.stopThinkingAnimation();
    this.lastTurnMs = Number.isFinite(durationMs) ? Math.round(durationMs) : this.lastTurnMs;
    this.lastError = "";
    this.lastStatus = "Turn completed";
    this.render();
  }

  onTurnError(errorMessage, durationMs) {
    this.taskCompletedAt = Date.now();
    this.modelState = "error";
    this.thinking = false;
    this.thinkingStage = "";
    this.stopThinkingAnimation();
    this.lastError = String(errorMessage || "");
    this.lastTurnMs = Number.isFinite(durationMs) ? Math.round(durationMs) : this.lastTurnMs;
    this.lastStatus = "Turn failed";
    this.render();
  }

  beginTurn() {
    this.showProjectInstructionsStatus = false;
    this.startupShortcutHint = "";
    this.transientStatusNotice = "";
    this.turnTokensSent = 0;
    this.turnTokensReceived = 0;
    this.turnStartedAt = Date.now();
    this.render();
  }

  addTokenUsage({ sent = 0, received = 0 } = {}) {
    const sentN = Number.isFinite(sent) ? Math.max(0, Math.round(sent)) : 0;
    const recvN = Number.isFinite(received) ? Math.max(0, Math.round(received)) : 0;
    if (!sentN && !recvN) return;
    this.turnTokensSent += sentN;
    this.turnTokensReceived += recvN;
    this.sessionTokensSent += sentN;
    this.sessionTokensReceived += recvN;
    this.render();
  }

  getTurnTokenUsage() {
    return {
      sent: this.turnTokensSent,
      received: this.turnTokensReceived,
    };
  }

  getSessionTokenUsage() {
    return {
      sent: this.sessionTokensSent,
      received: this.sessionTokensReceived,
    };
  }

  formatElapsedSinceTurnStart() {
    const startedAt = this.turnStartedAt || this.taskStartedAt;
    if (!startedAt) return "0.0s";
    const endedAt = this.thinking || this.modelState === "running" ? Date.now() : this.taskCompletedAt || Date.now();
    const ms = Math.max(0, endedAt - startedAt);
    return `${(ms / 1000).toFixed(1)}s`;
  }

  formatTaskContextLine(width) {
    const task = String(this.currentTaskText || "").replace(/\s+/g, " ").trim();
    if (!task) return "";
    const elapsed = this.formatElapsedSinceTurnStart();
    const status = this.taskCompletedAt ? (this.modelState === "error" ? "Failed" : "Done") : "";
    const prefix = `${this.symbols.task} Task: ${status ? `${status} · ` : ""}`;
    const fixedBudget = stringDisplayWidth(prefix) + stringDisplayWidth(elapsed) + 6;
    const body = truncateLine(task, Math.max(16, width - fixedBudget));
    return colorFullLine(` ${prefix}${body} · ${elapsed} `, "1;37;48;5;236", width);
  }

  visibleTimelineHasCurrentTask(lines = []) {
    const task = String(this.currentTaskText || "").replace(/\s+/g, " ").trim();
    if (!task || this.showRawLogs) return false;
    return (Array.isArray(lines) ? lines : []).some((line) => {
      const plain = stripAnsi(String(line || "")).replace(/\s+/g, " ").trim();
      return /(?:Task:|Task ·)/i.test(plain) && plain.includes(task);
    });
  }

  setLlmDebugEnabled(enabled) {
    this.llmDebugEnabled = Boolean(enabled);
    this.lastStatus = this.llmDebugEnabled ? "LLM debug ON" : "LLM debug OFF";
    this.render();
  }

  setLlmRequest(payload) {
    this.lastLlmRequest = String(payload || "");
    if (this.llmDebugEnabled && this.showRawLogs) this.render();
  }

  setLlmResponse(payload) {
    this.lastLlmResponse = String(payload || "");
    if (this.llmDebugEnabled && this.showRawLogs) this.render();
  }

  onThinking(stage = "") {
    this.thinking = true;
    this.thinkingStage = String(stage || "thinking");
    this.lastStatus = "thinking...";
    this.startThinkingAnimation();
    this.render();
  }

  onThinkingDone() {
    this.thinking = false;
    this.thinkingStage = "";
    this.stopThinkingAnimation();
    this.render();
  }

  setLiveThought(content) {
    const text = String(content || "").replace(/\s+/g, " ").trim();
    this.thoughtStreamVisible = false;
    this.thoughtStreamText = text ? `Thinking: ${text}` : "";
    if (text) this.lastStatus = "thinking...";
    this.render();
  }

  clearLiveThought() {
    if (!this.thoughtStreamVisible && !this.thoughtStreamText) return;
    this.thoughtStreamVisible = false;
    this.thoughtStreamText = "";
    this.render();
  }

  setProjectInstructionsStatus(status = null) {
    const source = String(status?.source || "AGENTS.md").trim() || "AGENTS.md";
    const stateRaw = String(status?.state || "").trim().toLowerCase();
    const allowedStates = new Set(["loaded", "missing", "empty", "error", "unknown"]);
    const state = allowedStates.has(stateRaw) ? stateRaw : "unknown";
    const detail = String(status?.detail || "").trim();
    this.projectInstructionsStatus = { source, state, detail };
    this.render();
  }

  setProjectInstructionsVisible(visible) {
    this.showProjectInstructionsStatus = Boolean(visible);
    this.render();
  }

  startThinkingAnimation() {
    if (!this.animateThinking) return;
    if (this.thinkingTimer) return;
    this.thinkingTimer = setInterval(() => {
      if (!this.active || !this.thinking) return;
      this.thinkingTick = (this.thinkingTick + 1) % 5;
      this.render();
    }, 900);
  }

  stopThinkingAnimation() {
    if (!this.thinkingTimer) return;
    clearInterval(this.thinkingTimer);
    this.thinkingTimer = null;
  }

  setContextUsage(used, limit) {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 0;
    const rawUsed = Number.isFinite(used) ? Math.max(0, Math.round(used)) : 0;
    const safeUsed = safeLimit > 0 ? Math.min(rawUsed, safeLimit) : rawUsed;
    this.contextUsed = safeUsed;
    this.contextLimit = safeLimit;
    this.render();
  }

  resetContextUsage() {
    this.contextUsed = 0;
    this.turnTokensSent = 0;
    this.turnTokensReceived = 0;
    this.turnStartedAt = 0;
    this.render();
  }

  toggleLogPanel() {
    this.showRawLogs = !this.showRawLogs;
    this.lastStatus = this.showRawLogs ? "Raw logs view (CTRL+L)" : "Timeline view (CTRL+L)";
    this.render();
    return this.showRawLogs;
  }

  setRawLogsVisible(visible) {
    this.showRawLogs = Boolean(visible);
    this.lastStatus = this.showRawLogs ? "Raw logs view" : "Timeline view";
    this.render();
  }

  toggleTasks() {
    return this.toggleLogPanel();
  }

  toggleTodoPanel() {
    this.showTodoPanel = !this.showTodoPanel;
    this.lastStatus = this.showTodoPanel ? "TODO panel visible (CTRL+T)" : "TODO panel hidden";
    this.render();
    return this.showTodoPanel;
  }

  setTodos(todos) {
    const previousTodos = Array.isArray(this.todos) ? this.todos : [];
    const previousTotal = previousTodos.length;
    const previousDone = previousTodos.filter((t) => String(t?.status || "").toLowerCase() === "completed").length;
    this.todos = Array.isArray(todos) ? todos : [];
    const nextTotal = this.todos.length;
    const nextDone = this.todos.filter((t) => String(t?.status || "").toLowerCase() === "completed").length;
    const becameAllCompleted =
      nextTotal > 0 &&
      nextDone === nextTotal &&
      !(previousTotal > 0 && previousDone === previousTotal);
    if (becameAllCompleted) {
      this.transientStatusNotice = this.symbols.todoDoneNotice;
      this.lastStatus = "Task completed";
    }
    this.render();
  }

  setApprovalPrompt(prompt, defaultYes = false, meta = null) {
    this.approvalPrompt = String(prompt || "").trim();
    this.approvalMeta =
      meta && typeof meta === "object"
        ? {
            question: String(meta.question || "").trim(),
            command: String(meta.command || "").trim(),
            reason: String(meta.reason || "").trim(),
            details: String(meta.details || "").trim(),
          }
        : null;
    this.approvalDefaultYes = Boolean(defaultYes);
    this.lastStatus = "Awaiting approval";
    this.render();
  }

  clearApprovalPrompt() {
    this.approvalPrompt = "";
    this.approvalMeta = null;
    this.approvalDefaultYes = false;
    this.render();
  }

  setClarificationPrompt(prompt = null) {
    this.clarificationPrompt = prompt && typeof prompt === "object" ? prompt : null;
    this.lastStatus = this.clarificationPrompt ? "Awaiting clarification" : this.lastStatus;
    this.render();
  }

  clearClarificationPrompt() {
    this.clarificationPrompt = null;
    this.render();
  }

  formatClarificationLines(width) {
    const prompt = this.clarificationPrompt && typeof this.clarificationPrompt === "object" ? this.clarificationPrompt : null;
    if (!prompt) return [];
    const question = String(prompt.question || "").trim();
    const options = Array.isArray(prompt.options) ? prompt.options : [];
    const selected = prompt.selected instanceof Set ? prompt.selected : new Set();
    const index = Math.max(0, Math.min(options.length - 1, Number(prompt.index) || 0));
    const multiple = Boolean(prompt.multiple);
    const lines = [color(` ? ${multiple ? "choose one or more" : "choose one"}`, "1;33")];
    if (question) lines.push(truncateLine(`   ${color("q:", "1;36")} ${question}`, width));
    options.slice(0, 12).forEach((option, idx) => {
      const active = idx === index;
      const checked = multiple ? (selected.has(idx) ? "◉" : "◯") : (active ? "●" : "○");
      const marker = active ? ">" : " ";
      const label = String(option?.label || option?.value || option || "").trim();
      const description = String(option?.description || "").trim();
      const body = `${marker} ${checked} ${label}${description ? ` - ${description}` : ""}`;
      lines.push(truncateLine(`   ${active ? color(body, "1;32") : color(body, "2;37")}`, width));
    });
    if (options.length > 12) lines.push(truncateLine(`   ${color(`... ${options.length - 12} more`, "2;37")}`, width));
    const help = multiple
      ? "↑/↓ move  space toggle  enter confirm  esc cancel"
      : "↑/↓ move  enter confirm  esc cancel";
    lines.push(truncateLine(`   ${color(help, "2;36")}`, width));
    return lines;
  }

  setInputHint(hint) {
    this.inputHint = String(hint || "").trim();
    this.render();
  }

  setInputHints(hints = []) {
    this.inputHints = sanitizeInputHints(hints);
    this.inputHintIndex = 0;
    this.render();
  }

  advanceInputHint() {
    if (!Array.isArray(this.inputHints) || this.inputHints.length === 0) {
      this.inputHints = sanitizeInputHints(DEFAULT_INPUT_HINTS);
      this.inputHintIndex = 0;
      return "";
    }
    this.inputHintIndex = (this.inputHintIndex + 1) % this.inputHints.length;
    this.render();
    return this.getCurrentInputHint();
  }

  getCurrentInputHint() {
    const hints = sanitizeInputHints(this.inputHints);
    this.inputHints = hints;
    const idx = Math.max(0, Math.min(hints.length - 1, Number(this.inputHintIndex) || 0));
    this.inputHintIndex = idx;
    return hints[idx] || DEFAULT_INPUT_HINTS[0] || "";
  }

  clearInputHint() {
    if (!this.inputHint) return;
    this.inputHint = "";
    this.render();
  }

  setStartupShortcutHint(hint) {
    this.startupShortcutHint = String(hint || "").trim();
    this.render();
  }

  clearStartupShortcutHint() {
    if (!this.startupShortcutHint) return;
    this.startupShortcutHint = "";
    this.render();
  }

  setPlanMode(enabled) {
    const next = Boolean(enabled);
    if (this.planModeEnabled === next) return;
    this.planModeEnabled = next;
    this.render();
  }

  openOverlay(title, text, options = {}) {
    this.overlayVisible = true;
    this.overlayTitle = String(title || "Details");
    this.overlayText = String(text || "");
    this.overlayScroll = 0;
    this.overlayMode = String(options?.mode || "");
    this.overlayHint = String(options?.hint || "");
    this.overlaySearchActive = false;
    this.overlaySearchQuery = "";
    this.render();
  }

  closeOverlay() {
    if (!this.overlayVisible) return;
    this.overlayVisible = false;
    this.overlayTitle = "";
    this.overlayText = "";
    this.overlayScroll = 0;
    this.overlayMode = "";
    this.overlayHint = "";
    this.overlaySearchActive = false;
    this.overlaySearchQuery = "";
    this.render();
  }

  isOverlayOpen() {
    return this.overlayVisible;
  }

  getOverlayMode() {
    return this.overlayMode;
  }

  isOverlaySearchActive() {
    return this.overlayVisible && this.overlaySearchActive;
  }

  startOverlaySearch() {
    if (!this.overlayVisible) return false;
    this.overlaySearchActive = true;
    this.overlaySearchQuery = "";
    this.render();
    return true;
  }

  appendOverlaySearch(text) {
    if (!this.overlayVisible || !this.overlaySearchActive) return "";
    this.overlaySearchQuery += String(text || "");
    this.render();
    return this.overlaySearchQuery;
  }

  backspaceOverlaySearch() {
    if (!this.overlayVisible || !this.overlaySearchActive) return "";
    this.overlaySearchQuery = this.overlaySearchQuery.slice(0, -1);
    this.render();
    return this.overlaySearchQuery;
  }

  cancelOverlaySearch() {
    if (!this.overlayVisible || !this.overlaySearchActive) return false;
    this.overlaySearchActive = false;
    this.overlaySearchQuery = "";
    this.render();
    return true;
  }

  findInOverlay(pattern) {
    if (!this.overlayVisible) return -1;
    const needle = String(pattern || "").toLowerCase();
    if (!needle) return -1;
    const width = Math.max(20, Math.max(40, this.out.columns || 100) - 1);
    const layout = this.buildOverlayLayout(width);
    const lines = layout.wrapped.map((line) => String(line || "").toLowerCase());
    if (lines.length === 0) return -1;
    const start = Math.max(0, Math.min(lines.length - 1, this.overlayScroll + 1));
    for (let i = start; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) {
        this.overlayScroll = i;
        this.render();
        return i;
      }
    }
    for (let i = 0; i < start; i += 1) {
      if (lines[i].includes(needle)) {
        this.overlayScroll = i;
        this.render();
        return i;
      }
    }
    return -1;
  }

  submitOverlaySearch() {
    if (!this.overlayVisible || !this.overlaySearchActive) return false;
    const query = this.overlaySearchQuery;
    this.overlaySearchActive = false;
    this.overlaySearchQuery = "";
    const idx = this.findInOverlay(query);
    if (idx >= 0) return true;
    this.render();
    return false;
  }

  scrollOverlayLines(delta) {
    if (!this.overlayVisible) return 0;
    const step = Math.max(1, Math.round(Math.abs(Number(delta) || 0)));
    const direction = Number(delta) < 0 ? -1 : 1;
    this.overlayScroll = Math.max(0, this.overlayScroll + direction * step);
    this.render();
    return this.overlayScroll;
  }

  scrollOverlayPage(direction = 1) {
    if (!this.overlayVisible) return 0;
    const page = Math.max(3, Math.floor((this.out.rows || 30) * 0.6));
    return this.scrollOverlayLines(direction * page);
  }

  buildOverlayLayout(width) {
    const rawText = String(this.overlayText || "").replace(/\r/g, "");
    const renderedLines = renderMarkdownLines(rawText);
    const wrapped = [];
    const rawStartOffsets = [];
    for (const line of renderedLines) {
      rawStartOffsets.push(wrapped.length);
      const chunks = wrapText(line, width);
      if (chunks.length === 0) wrapped.push("");
      else wrapped.push(...chunks);
    }
    let requestOffset = 0;
    let responseOffset = Math.max(0, wrapped.length - 1);
    for (let i = 0; i < renderedLines.length; i += 1) {
      const line = stripAnsi(String(renderedLines[i] || "")).trimStart().toLowerCase();
      if (line.startsWith("request:")) requestOffset = rawStartOffsets[i] || 0;
      if (line.startsWith("response:")) responseOffset = rawStartOffsets[i] || responseOffset;
    }
    return { wrapped, requestOffset, responseOffset };
  }

  jumpOverlaySection(which = "request") {
    if (!this.overlayVisible) return 0;
    const width = Math.max(20, Math.max(40, this.out.columns || 100) - 1);
    const layout = this.buildOverlayLayout(width);
    this.overlayScroll = which === "response" ? layout.responseOffset : layout.requestOffset;
    this.render();
    return this.overlayScroll;
  }

  jumpOverlayCurrentSectionBottom() {
    if (!this.overlayVisible) return 0;
    const width = Math.max(20, Math.max(40, this.out.columns || 100) - 1);
    const height = Math.max(16, this.out.rows || 30);
    const viewport = Math.max(4, height - 4);
    const layout = this.buildOverlayLayout(width);
    const inResponse = this.overlayScroll >= layout.responseOffset;
    const sectionStart = inResponse ? layout.responseOffset : layout.requestOffset;
    const sectionEnd = inResponse ? layout.wrapped.length : layout.responseOffset;
    const target = Math.max(sectionStart, Math.max(0, sectionEnd - viewport));
    this.overlayScroll = target;
    this.render();
    return this.overlayScroll;
  }

  setModelSuggestions(options, selectedIndex = 0) {
    const list = Array.isArray(options) ? options.map((item) => String(item || "")).filter(Boolean) : [];
    this.modelSuggestions = list;
    this.modelSuggestionsVisible = this.modelSuggestions.length > 0;
    if (!this.modelSuggestionsVisible) {
      this.modelSuggestionIndex = 0;
      this.modelSuggestionWindowStart = 0;
    } else {
      const clamped = Math.max(0, Math.min(this.modelSuggestions.length - 1, Number(selectedIndex) || 0));
      this.modelSuggestionIndex = clamped;
      this.ensureModelSuggestionWindow();
    }
    this.render();
  }

  clearModelSuggestions() {
    if (!this.modelSuggestionsVisible && this.modelSuggestions.length === 0) return;
    this.modelSuggestionsVisible = false;
    this.modelSuggestions = [];
    this.modelSuggestionIndex = 0;
    this.modelSuggestionWindowStart = 0;
    this.render();
  }

  ensureModelSuggestionWindow() {
    const total = this.modelSuggestions.length;
    if (total <= 0) {
      this.modelSuggestionIndex = 0;
      this.modelSuggestionWindowStart = 0;
      return;
    }
    const maxVisible = Math.max(1, Number(this.modelSuggestionMaxVisible) || 8);
    const maxStart = Math.max(0, total - maxVisible);
    const clampedIndex = Math.max(0, Math.min(total - 1, Number(this.modelSuggestionIndex) || 0));
    let start = Math.max(0, Math.min(maxStart, Number(this.modelSuggestionWindowStart) || 0));
    if (clampedIndex < start) start = clampedIndex;
    if (clampedIndex >= start + maxVisible) start = clampedIndex - maxVisible + 1;
    this.modelSuggestionIndex = clampedIndex;
    this.modelSuggestionWindowStart = Math.max(0, Math.min(maxStart, start));
  }

  getModelSuggestionViewport() {
    this.ensureModelSuggestionWindow();
    const total = this.modelSuggestions.length;
    if (total <= 0) {
      return { total: 0, start: 0, end: 0, items: [], hiddenAbove: 0, hiddenBelow: 0 };
    }
    const maxVisible = Math.max(1, Number(this.modelSuggestionMaxVisible) || 8);
    const start = this.modelSuggestionWindowStart;
    const end = Math.min(total, start + maxVisible);
    const items = this.modelSuggestions.slice(start, end);
    return {
      total,
      start,
      end,
      items,
      hiddenAbove: start,
      hiddenBelow: Math.max(0, total - end),
    };
  }

  setCommandSuggestions(options, selectedIndex = 0, label = "commands") {
    const list = Array.isArray(options) ? options.map((item) => String(item || "")).filter(Boolean) : [];
    this.commandSuggestions = list.slice(0, 8);
    this.commandSuggestionLabel = String(label || "commands");
    this.commandSuggestionsVisible = this.commandSuggestions.length > 0;
    if (!this.commandSuggestionsVisible) {
      this.commandSuggestionIndex = 0;
    } else {
      const clamped = Math.max(0, Math.min(this.commandSuggestions.length - 1, Number(selectedIndex) || 0));
      this.commandSuggestionIndex = clamped;
    }
    this.render();
  }

  clearCommandSuggestions() {
    if (!this.commandSuggestionsVisible && this.commandSuggestions.length === 0) return;
    this.commandSuggestionsVisible = false;
    this.commandSuggestions = [];
    this.commandSuggestionIndex = 0;
    this.commandSuggestionLabel = "commands";
    this.render();
  }

  formatApprovalLines(width) {
    const prompt = String(this.approvalPrompt || "");
    const meta = this.approvalMeta && typeof this.approvalMeta === "object" ? this.approvalMeta : null;
    const lines = [];
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

    let question = String(meta?.question || "").trim();
    let command = String(meta?.command || "").trim();
    let detailsText = String(meta?.reason || meta?.details || "").trim();

    if (!question || !command || !detailsText) {
      const cmdMatch = prompt.match(/\$\s+([^\n]+)$/m);
      const promptCommand = cmdMatch?.[1] ? String(cmdMatch[1]).trim() : "";
      const promptQuestion = prompt
        .replace(/\$\s+[^\n]+$/m, "")
        .replace(/Approve\s*\[[^\]]+\]\s*:?\s*/i, "")
        .trim();
      if (!command && promptCommand) command = promptCommand;
      if (!question && promptQuestion) question = promptQuestion;
    }

    if (question.toLowerCase().startsWith("shell:")) {
      let shellBody = question.slice("shell:".length).trim();
      let shellReason = "";
      const trailingReason = shellBody.match(/\s+\(([^()]*)\)\s*$/);
      if (trailingReason?.[1]) {
        shellReason = String(trailingReason[1]).trim();
        shellBody = shellBody.slice(0, trailingReason.index).trim();
      }
      if (!command && shellBody) command = shellBody;
      if (!detailsText && shellReason) detailsText = shellReason;
      question = "Approve shell command?";
    }

    if (!question && command) {
      question = "Approve command execution?";
    }

    lines.push(color(" ? approval required", "1;33"));
    if (question) {
      lines.push(truncateLine(`   ${color("q:", "1;36")} ${question}`, width));
    }
    if (command) {
      lines.push(truncateLine(`   ${color("$", "1;35")} ${color(command, "37")}`, width));
    }
    if (!detailsText && prompt && normalize(prompt) !== normalize(question) && normalize(prompt) !== normalize(command)) {
      detailsText = prompt;
    }
    if (detailsText && normalize(detailsText) !== normalize(question)) {
      lines.push(truncateLine(`   ${color("why:", "1;35")} ${detailsText}`, width));
    }
    const choiceLine = this.approvalDefaultYes
      ? `${color("y", "1;32")}:once ${color("r", "1;36")}:remember ${color("a", "1;33")}:session ${color("n", "1;31")}:deny ${color("enter", "1;33")}:${color("once", "32")}`
      : `${color("y", "1;32")}:once ${color("r", "1;36")}:remember ${color("a", "1;33")}:session ${color("n", "1;31")}:deny ${color("enter", "1;33")}:${color("deny", "31")}`;
    lines.push(truncateLine(`   ${choiceLine}`, width));
    return lines;
  }

  withTimelineSpacing(lines) {
    const items = Array.isArray(lines) ? lines : [];
    if (items.length === 0) return [];
    const previous = this.timeline.length > 0 ? this.timeline[this.timeline.length - 1] : "";
    return normalizeTimelineSpacing(previous ? [previous, ...items] : items).slice(previous ? 1 : 0);
  }

  formatTimelineLines(line) {
    const timelineItem = (marker, text, markerColor = "2;37") => {
      const body = String(text || "").trim();
      if (!body) return [];
      const prefix = marker ? `${color(marker, markerColor)} ` : "";
      return [`${prefix}${body}`];
    };
    const timelineBlock = (marker, lines, markerColor = "2;37") => {
      const items = (Array.isArray(lines) ? lines : [lines]).map((item) => String(item || "")).filter(Boolean);
      if (items.length === 0) return [];
      const prefix = marker ? `${color(marker, markerColor)} ` : "";
      return items.map((item, index) => (index === 0 ? `${prefix}${item}` : `  ${item}`));
    };
    const responseBlock = (marker, lines, markerColor = "1;32") => {
      const items = (Array.isArray(lines) ? lines : [lines]).map((item) => String(item || ""));
      while (items.length > 0 && !items[0].trim()) items.shift();
      while (items.length > 0 && !items[items.length - 1].trim()) items.pop();
      if (items.length === 0) return [];
      let usedMarker = false;
      const isStructural = (item) => {
        const plain = stripAnsi(String(item || "")).trimStart();
        return /^(?:[•◦▪]\s+|\d+[.)]\s+|\[[ xX~-]\]\s+|[◆›·]\s+|│)/.test(plain);
      };
      return items.map((item) => {
        if (!item.trim()) return "";
        if (isStructural(item)) return item;
        if (!usedMarker) {
          usedMarker = true;
          return `${color(marker, markerColor)} ${item}`;
        }
        return `  ${item}`;
      });
    };
    const toolLabel = (tool, details = "") => {
      const name = String(tool || "tool");
      const body = String(details || "").trim();
      const clean = body ? body.replace(/^\((.*)\)$/, "$1").trim() : "";
      const showDetails = this.showRawLogs || Boolean(clean) || /^\[trace\]|\b(?:path|command|query|regex|find|oldText|newText|content|input)=/i.test(clean);
      const suffix = clean && showDetails ? ` ${color(clean, "2;37")}` : "";
      switch (name) {
        case "read_file":
          return `${color("Read", "36")}${suffix}`;
        case "read_files":
          return `${color("Read files", "36")}${suffix}`;
        case "list_files":
          return `${color("List", "36")}${suffix}`;
        case "glob_files":
          return `${color("Glob", "36")}${suffix}`;
        case "find_files":
          return `${color("Find", "36")}${suffix}`;
        case "rg":
        case "grep":
        case "search_files":
          return `${color("Search", "36")}${suffix}`;
        case "web_search":
        case "search_web":
          return `${color("Web search", "36")}${suffix}`;
        case "subagent":
          return `${color("Subagent", "36")}${suffix}`;
        case "collaborate":
          return `${color("Agents", "36")}${suffix}`;
        case "git_status":
          return color("Git status", "36");
        case "git_diff":
          return `${color("Git diff", "36")}${suffix}`;
        case "run_tests":
          return `${color("Test", "36")}${suffix}`;
        case "edit_file":
          return `${color("Edit", "36")}${suffix}`;
        case "write_file":
          return `${color("Write", "36")}${suffix}`;
        case "apply_patch":
          return `${color("Patch", "36")}${suffix}`;
        case "replace_in_files":
          return `${color("Replace", "36")}${suffix}`;
        default:
          return `${color(name, "36")}${suffix}`;
      }
    };
    const compactJsonDetail = (text, keys = ["task", "path", "query", "pattern", "command"]) => {
      const source = String(text || "").trim();
      if (!source.startsWith("{")) return "";
      try {
        const parsed = JSON.parse(source);
        for (const key of keys) {
          const value = parsed?.[key];
          if (typeof value === "string" && value.trim()) return trimWorkspaceText(value.replace(/\s+/g, " "), 120).text;
        }
      } catch {
        // keep empty
      }
      return "";
    };
    const runLabel = (raw) => {
      const body = String(raw || "").trim();
      const shellCommandMatch = body.match(/^shell\s+command=("[^"]*"|\S+)/);
      if (shellCommandMatch?.[1]) {
        let command = shellCommandMatch[1];
        try {
          command = JSON.parse(shellCommandMatch[1]);
        } catch {
          // use raw token
        }
        return { label: "Shell", detail: String(command || "").trim() };
      }
      const shellMatch = body.match(/^shell\s+(.+)$/);
      if (shellMatch?.[1]) return { label: "Shell", detail: shellMatch[1].trim() };
      if (/^(?:npm|pnpm|yarn|bun|deno|node|python3?|git|make|cargo|go|pytest|jest)\b/.test(body)) {
        return { label: "Shell", detail: body };
      }
      const patterns = [
        [/^read files?\s+(.+)$/i, "Read"],
        [/^list\s+(.+)$/i, "List"],
        [/^glob\s+(.+)$/i, "Glob"],
        [/^find\s+(.+)$/i, "Find"],
        [/^search\s+(.+)$/i, "Search"],
        [/^git status$/i, "Git status"],
        [/^git diff(?:\s+(.+))?$/i, "Git diff"],
        [/^test\s+(.+)$/i, "Test"],
        [/^edit\s+(.+)$/i, "Edit"],
        [/^write\s+(.+)$/i, "Write"],
        [/^apply patch(?:\s+(.+))?$/i, "Patch"],
        [/^replace\s+(.+)$/i, "Replace"],
        [/^web search\s*(.*)$/i, "Web search"],
      ];
      for (const [regex, label] of patterns) {
        const match = body.match(regex);
        if (match) return { label, detail: String(match[1] || "").trim() };
      }
      const agentMatch = body.match(/^(?:subagent|collaborate)\s*(.*)$/i);
      if (agentMatch) {
        const rawDetail = String(agentMatch[1] || "").trim();
        return { label: "Agents", detail: compactJsonDetail(rawDetail) || "" };
      }
      return { label: "Tool", detail: body };
    };
    const padLeft = (text) => {
      const s = String(text || "");
      if (!s) return s;
      if (s.startsWith(" ")) return s;
      return ` ${s}`;
    };
    const padAll = (lines) =>
      (Array.isArray(lines) ? lines : [lines]).map((item) => {
        if (item === "") return item;
        return padLeft(item);
      });
    if (!line) return [];
    if (line.startsWith("[task] ")) {
      const width = Math.max(20, (this.out?.columns || 100) - 1);
      const textWidth = Math.max(8, width - stringDisplayWidth(` ${this.symbols.task} Task:  `));
      const taskLines = wrapText(line.slice(7).trim(), textWidth);
      return taskLines.map((taskLine, index) => {
        const prefix = index === 0 ? `${this.symbols.task} Task: ` : "  ";
        return colorFullLine(` ${prefix}${taskLine} `, "1;37;48;5;236", width);
      });
    }
    if (line.startsWith("[model] ")) {
      return [];
    }
    if (line.startsWith("[plan]")) {
      return [];
    }
    if (line.startsWith("[thinking] ")) {
      // Raw request/response payload traces are noisy; the visible thinking row
      // is driven by [thought] entries and the transient spinner/status line.
      return [];
    }
    if (line.startsWith("[thought] ")) {
      // Thought updates are already surfaced through the transient thinking
      // status/running line. Do not append them to the persistent timeline,
      // otherwise streaming/tool thoughts can appear repeatedly in workspace.
      return [];
    }
    if (line.startsWith("[progress] ")) {
      const body = trimWorkspaceText(line.slice(11).trim(), 800).text;
      if (!body) return [];
      return timelineItem(this.symbols.response, color(body, "35"), "1;35");
    }
    if (line.startsWith("[run] ")) {
      const rawRun = line.slice(6).trim();
      const approvalMatch = line.match(/approval=("[^"]*"|\\S+)/);
      let approval = "";
      if (approvalMatch?.[1]) {
        try {
          approval = JSON.parse(approvalMatch[1]);
        } catch {
          approval = approvalMatch[1];
        }
      }
      const run = runLabel(rawRun);
      const safeDisplay = trimWorkspaceText(run.detail || "", 320).text.replace(/\n/g, " ");
      const tag =
        approval === "approved"
          ? color("[APPROVED]", "1;33")
          : approval === "auto"
          ? color("[AUTO]", "2;32")
          : "";
      const detail = safeDisplay ? ` ${color(safeDisplay, "36")}` : "";
      return timelineItem(this.symbols.tool, `${color(run.label || "Tool", "1;36")}${detail}${tag ? ` ${tag}` : ""}`, "1;36");
    }
    if (line.startsWith("[tool] ")) {
      const body = line.slice(7).trim();
      if (/^shell\b/i.test(body)) {
        // Shell tool usage is rendered from the `[run] shell ...` entry to avoid duplicate lines.
        return [];
      }
      if (/^(todo_write|todowrite)\b/i.test(body)) {
        // Keep todo changes in status bar only.
        return [];
      }
      const match = body.match(/^([a-zA-Z0-9_.-]+)\s*(.*)$/);
      return timelineItem(this.symbols.tool, toolLabel(match?.[1] || body, match?.[2] || ""), "1;36");
    }
    if (line.startsWith("[tools] ")) {
      const body = line.slice(8).trim();
      return timelineItem(this.symbols.tool, `${color("Run", "1;36")} ${body}`, "1;36");
    }
    if (line.startsWith("[agent] ")) {
      return timelineItem(this.symbols.agent, `${color("Agent", "1;35")} ${trimWorkspaceText(line.slice(8).trim(), 600).text}`, "1;35");
    }
    if (line.startsWith("[response] ")) {
      const text = trimWorkspaceText(line.slice(11).trim(), 8000).text;
      if (!text) return responseBlock(this.symbols.response, "<empty>");
      const chunks = renderMarkdownLines(text).filter((chunk) => chunk !== undefined);
      if (chunks.length === 0) return responseBlock(this.symbols.response, "<empty>");
      return responseBlock(this.symbols.response, chunks, "1;32");
    }
    if (line.startsWith("[result] ")) {
      const body = line.slice(9).trim();
      const lower = body.toLowerCase();
      const failed = /\b(fail(?:ed|ure)?|error|aborted|denied|timeout|timed out)\b/.test(lower);
      const ok = !failed && /\b(done|ok|success|succeeded|completed)\b/.test(lower);
      const icon = failed ? "[x]" : ok ? "[ok]" : "[i]";
      const iconColor = failed ? "1;31" : ok ? "1;32" : "2;37";
      return timelineItem(failed ? this.symbols.fail : ok ? this.symbols.ok : this.symbols.response, color(body, "2;37"), iconColor);
    }
    if (line.startsWith("[tool-result] ")) {
      const body = trimWorkspaceText(line.slice(14).trimEnd(), 2000).text;
      if (!body.trim()) return [];
      const compact = body
        .replace(/\r/g, "")
        .split("\n")
        .map((part) => part.trimEnd())
        .filter((part) => part.trim())
        .slice(0, 6);
      const rendered = compact.length > 0 ? compact : [body];
      return timelineBlock(
        this.symbols.result,
        rendered.map((part) => color(part.trimStart(), "2;37")),
        "2;37"
      );
    }
    if (line.startsWith("[banner-1] ")) {
      return [color(line.slice(11), "1;82")];
    }
    if (line.startsWith("[banner-title] ")) {
      const raw = String(line.slice(15) || "");
      const title = raw.trim();
      if (!title) return [color(raw, "1;92")];
      const leftPad = Math.max(0, raw.indexOf(title));
      return [`${" ".repeat(leftPad)}${color(` ${title} `, "1;30;42")}`];
    }
    if (line.startsWith("[banner-title-inline] ")) {
      const raw = String(line.slice(22) || "");
      let rendered = raw;
      rendered = rendered.replace(" Pie Code ", color(" Pie Code ", "1;30;42"));
      rendered = rendered.replace("let's cook", color("let's cook", "2;37"));
      rendered = rendered.replace("simple like pie", color("simple like pie", "2;37"));
      return padAll([rendered]);
    }
    if (line.startsWith("[banner-slogan] ")) {
      return padAll([color(line.slice(16), "2;37")]);
    }
    if (line.startsWith("[banner-2] ")) {
      return [color(line.slice(11), "1;118")];
    }
    if (line.startsWith("[banner-3] ")) {
      return [color(line.slice(11), "1;154")];
    }
    if (line.startsWith("[banner-4] ")) {
      return [color(line.slice(11), "1;177")];
    }
    if (line.startsWith("[banner-5] ")) {
      return [color(line.slice(11), "1;201")];
    }
    if (line.startsWith("[banner-6] ")) {
      return [color(line.slice(11), "1;213")];
    }
    if (line.startsWith("[banner-7] ")) {
      return [color(line.slice(11), "1;177")];
    }
    if (line.startsWith("[banner-8] ")) {
      return [color(line.slice(11), "1;154")];
    }
    if (line.startsWith("[banner-meta] ")) {
      return padAll([color(line.slice(14), "2;37")]);
    }
    if (line.startsWith("[banner-hint] ")) {
      return padAll([color(line.slice(14), "2;36")]);
    }
    if (line.startsWith("loaded project instructions:")) {
      return padAll([color(line, "2;37")]);
    }
    if (/^(#{1,6})\s+/.test(line)) {
      return padAll(renderMarkdownLines(line));
    }
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/.test(line)) {
      return padAll(renderMarkdownLines(line));
    }
    if (/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\))/.test(line)) {
      return padAll(renderMarkdownLines(line));
    }
    if (line.startsWith("error:")) {
      return padAll([color(line, "31")]);
    }
    if (line.startsWith("[")) {
      // Hide internal event noise in workspace timeline.
      return [];
    }
    return timelineItem(this.symbols.response, trimWorkspaceText(line, 1200).text);
  }

  buildInputState(input, width, cursorIndex = null) {
    const rawInput = String(input || "");
    const normalizedSource = rawInput.replace(/\r/g, "").replace(/\t/g, "  ");
    const safeCursorIndex =
      Number.isFinite(cursorIndex) && Number(cursorIndex) >= 0
        ? Math.min(normalizedSource.length, Math.max(0, Math.floor(Number(cursorIndex))))
        : normalizedSource.length;
    const beforeCursor = normalizedSource.slice(0, safeCursorIndex);

    const promptGlyph = this.symbols.prompt;
    const firstPrefix = ` ${promptGlyph} `;
    const contPrefix = "   ";
    const placeholder = this.getCurrentInputHint() || 'Try "fix lint errors"';
    const hasContent = normalizedSource.length > 0;
    const logicalLines = hasContent ? normalizedSource.split("\n") : [""];
    const wrapInputLine = (lineText, firstWidth, continuationWidth) => {
      const source = String(lineText || "");
      const firstLimit = Math.max(1, firstWidth);
      const continuationLimit = Math.max(1, continuationWidth);
      if (!source) return [""];
      const chunks = [];
      let chunk = "";
      let chunkWidth = 0;
      let widthLimit = firstLimit;
      const segments = graphemeSegmenter
        ? Array.from(graphemeSegmenter.segment(source), (segment) => segment.segment)
        : Array.from(source);
      for (const segment of segments) {
        const text = segment === "\t" ? "  " : segment;
        const w = graphemeDisplayWidth(text);
        if (chunk && chunkWidth + w > widthLimit) {
          chunks.push(chunk);
          chunk = "";
          chunkWidth = 0;
          widthLimit = continuationLimit;
        }
        if (!chunk && w > widthLimit) {
          chunks.push(text);
          widthLimit = continuationLimit;
          continue;
        }
        chunk += text;
        chunkWidth += w;
      }
      chunks.push(chunk);
      return chunks;
    };

    const visibleLines = [];
    for (let lineIdx = 0; lineIdx < logicalLines.length; lineIdx += 1) {
      const lineText = logicalLines[lineIdx];
      const rowPrefix = lineIdx === 0 ? firstPrefix : contPrefix;
      const firstWidth = Math.max(1, width - stringDisplayWidth(rowPrefix));
      const continuationWidth = Math.max(1, width - stringDisplayWidth(contPrefix));
      const chunks = wrapInputLine(lineText, firstWidth, continuationWidth);
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
        const prefix = lineIdx === 0 && chunkIdx === 0 ? firstPrefix : contPrefix;
        const chunk = chunks[chunkIdx];
        if (lineIdx === 0 && chunkIdx === 0 && chunk.startsWith("!")) {
          visibleLines.push(`${prefix}${color("!", "31")}${chunk.slice(1)}`);
        } else {
          visibleLines.push(`${prefix}${chunk}`);
        }
      }
    }
    if (!hasContent) {
      const maxLineWidth = Math.max(0, width - stringDisplayWidth(firstPrefix));
      visibleLines[0] = `${firstPrefix}\x1b[2m${truncateLine(placeholder, maxLineWidth)}\x1b[0m`;
    }

    let wrappedCursorRowOffset = 0;
    let cursorShown = "";
    const cursorLogicalLines = beforeCursor.split("\n");
    for (let lineIdx = 0; lineIdx < cursorLogicalLines.length; lineIdx += 1) {
      const lineText = cursorLogicalLines[lineIdx];
      const rowPrefix = lineIdx === 0 ? firstPrefix : contPrefix;
      const firstWidth = Math.max(1, width - stringDisplayWidth(rowPrefix));
      const continuationWidth = Math.max(1, width - stringDisplayWidth(contPrefix));
      const chunks = wrapInputLine(lineText, firstWidth, continuationWidth);
      if (lineIdx < cursorLogicalLines.length - 1) {
        wrappedCursorRowOffset += chunks.length;
      } else {
        wrappedCursorRowOffset += Math.max(0, chunks.length - 1);
        cursorShown = chunks[chunks.length - 1] || "";
      }
    }

    const cursorPrefix = wrappedCursorRowOffset === 0 ? firstPrefix : contPrefix;
    // Keep the cursor inside the same conservative input width used for
    // wrapping. Placing it in the terminal's last column can trigger implicit
    // auto-wrap in several terminals/tmux/mobile clients, making the visible
    // cursor appear one row below the input.
    const cursorCol = Math.max(
      1,
      Math.min(Math.max(1, width - 1), 1 + stringDisplayWidth(cursorPrefix) + stringDisplayWidth(cursorShown))
    );

    return {
      lines: visibleLines,
      cursorCol,
      cursorRowOffset: wrappedCursorRowOffset,
    };
  }

  renderInput(input = "", cursorIndex = null) {
    if (!this.active) return;
    this.currentInput = String(input || "");
    this.render(this.currentInput, this.lastStatus || "waiting for input", cursorIndex);
  }

  formatStatusLine(width) {
    const state =
      this.modelState === "running"
        ? "\x1b[33mrunning\x1b[0m"
        : this.modelState === "error"
          ? "\x1b[31merror\x1b[0m"
          : "\x1b[32midle\x1b[0m";
    const time = this.lastTurnMs == null ? "-" : `${this.lastTurnMs}ms`;
    const tool = this.lastTool || "-";
    const phase = this.thinking
      ? ` | phase: \x1b[33mthinking${this.thinkingStage ? `(${this.thinkingStage})` : ""}\x1b[0m`
      : "";
    const ctx =
      this.contextLimit > 0
        ? ` | ctx: ${formatCompactNumber(this.contextUsed)}/${formatCompactNumber(this.contextLimit)} (${Math.min(999, Math.round((this.contextUsed / this.contextLimit) * 100))}%)`
        : "";
    const todoSummary =
      this.todos.length > 0
        ? ` | TODO(${this.todos.filter((t) => t.status === "completed").length}/${this.todos.length})`
        : "";
    const text = ` model: ${this.modelName || this.providerLabel()} | state: ${state} | last: ${time} | tool: ${tool}${ctx}${todoSummary}${phase}`;
    return truncateLine(text, width);
  }

  formatProjectInstructionsLabel() {
    if (!this.showProjectInstructionsStatus) return "";
    const status = this.projectInstructionsStatus || {};
    const source = String(status.source || "AGENTS.md");
    if (status.state === "loaded") {
      return `${source}: loaded`;
    }
    if (status.state === "missing") {
      return `${source}: not found`;
    }
    if (status.state === "empty") {
      return `${source}: empty`;
    }
    if (status.state === "error") {
      const reason = status.detail ? ` (${status.detail})` : "";
      return `${source}: unreadable${reason}`;
    }
    return "";
  }

  formatTransientStatusLabel() {
    return String(this.transientStatusNotice || "").trim();
  }

  render(input = this.currentInput, status = "", cursorIndex = null) {
    if (!this.active) return;
    this.currentInput = String(input || "");
    const statusText = String(status || "").trim();
    if (statusText) this.lastStatus = statusText;

    const termWidth = Math.max(40, this.out.columns || 100);
    const width = Math.max(20, termWidth - 1);
    const height = Math.max(16, this.out.rows || 30);

    if (this.overlayVisible) {
      const sep = separatorLine(width, this.unicodeSymbols);
      const title = truncateLine(` ${this.overlayTitle}`, width);
      const fallbackHint = " /:search  j/k: scroll  J/K: req/resp  g: section end  ctrl-f/b: page  q: close ";
      const hintText = this.overlaySearchActive
        ? ` /${this.overlaySearchQuery}  (enter: jump, esc: cancel, backspace: edit)`
        : this.overlayHint || fallbackHint;
      const hint = truncateLine(hintText, width);
      const { wrapped } = this.buildOverlayLayout(width);
      const viewport = Math.max(4, height - 4);
      const maxStart = Math.max(0, wrapped.length - viewport);
      this.overlayScroll = Math.max(0, Math.min(this.overlayScroll, maxStart));
      const visible = wrapped
        .slice(this.overlayScroll, this.overlayScroll + viewport)
        .map((line) => highlightOverlaySectionLine(line));
      const scrollLabel = ` lines ${Math.min(wrapped.length, this.overlayScroll + 1)}-${Math.min(wrapped.length, this.overlayScroll + visible.length)} / ${wrapped.length}`;
      const statusLine = truncateLine(scrollLabel, width);
      const frameLines = [sep, `\x1b[1m${title}\x1b[0m`, sep, ...visible, sep, `\x1b[2m${statusLine}\x1b[0m`, `\x1b[2m${hint}\x1b[0m`];
      const frame = renderFrameLines(frameLines, width, height);
      this.lastFrameLineCount = frameLines.length;
      this.lastInputRow = 1;
      this.lastInputLine = "";
      if (this.layout) {
        this.layout.render({
          workspaceLines: frameLines,
          inputLines: [""],
          statusLine: "",
          hintLine: "",
          cursorRowOffset: 0,
          cursorCol: 1,
        });
        return;
      }
      this.out.write(TERMINAL_PAINT_PREFIX + terminalFrame(frame) + `\x1b[1;1H\x1b[?25h`);
      return;
    }

    const sep = separatorLine(width, this.unicodeSymbols);
    // Leave one spare cell for interactive bottom chrome. Several mobile
    // terminals and tmux combinations auto-wrap when wide text reaches the
    // last column, which makes the input/status rows drift by one line.
    const bottomWidth = Math.max(20, width - 1);
    const errorLine = this.lastError ? truncateLine(` error: ${this.lastError}`, width) : "";

    const headerLines = errorLine ? 1 : 0;
    const todoLines = this.showTodoPanel
      ? Math.min(
          1 + this.todos.length,
          7
        )
      : 0;
    const todoBlockLines = this.showTodoPanel ? 1 + todoLines : 0; // sep + content
    const approvalContentLines = this.approvalPrompt ? this.formatApprovalLines(width) : [];
    const approvalLines = this.approvalPrompt ? 1 + approvalContentLines.length : 0;
    const clarificationContentLines = this.clarificationPrompt ? this.formatClarificationLines(width) : [];
    const clarificationLines = this.clarificationPrompt ? 1 + clarificationContentLines.length : 0;
    const commandSuggestionLines = this.commandSuggestionsVisible ? (1 + this.commandSuggestions.length) : 0;
    const modelSuggestionViewport = this.modelSuggestionsVisible ? this.getModelSuggestionViewport() : null;
    const modelSuggestionLines = modelSuggestionViewport
      ? 1 +
        modelSuggestionViewport.items.length +
        (modelSuggestionViewport.hiddenAbove > 0 ? 1 : 0) +
        (modelSuggestionViewport.hiddenBelow > 0 ? 1 : 0)
      : 0;
    const hintLines = this.inputHint ? 1 : 0;
    const shortcutHintLines = this.startupShortcutHint ? 1 : 0;
    const rawTaskContextLine = this.formatTaskContextLine(width);
    const taskContextLines = rawTaskContextLine ? 2 : 0;
    const thinkingLines = this.thinking ? 1 : 0;
    const thoughtWrapped = [];
    const thoughtStreamLines = 0;
    const inputState = this.buildInputState(this.currentInput, bottomWidth, cursorIndex);
    const inputLineCount = Math.max(1, inputState.lines.length);
    const bottomLines = inputLineCount + 2 + commandSuggestionLines + modelSuggestionLines + hintLines + shortcutHintLines; // input + separator + status/hints
    const reservedLines =
      headerLines +
      todoBlockLines +
      approvalLines +
      clarificationLines +
      taskContextLines +
      thinkingLines +
      thoughtStreamLines +
      bottomLines;
    const wrappedLogs = this.logs.flatMap((line) => wrapText(line, width));
    const wrappedTimeline = this.timeline.flatMap((line) => wrapTimelineLine(line, width));
    const sourceLines = this.showRawLogs ? wrappedLogs : wrappedTimeline;
    // Keep layout in natural flow (not sticky), but adapt visible workspace lines
    // to the actual terminal space left after input/status blocks.
    const viewportLogBudget = Math.max(1, height - reservedLines);
    const maxLogLines = Math.max(1, Math.min(Math.max(1, sourceLines.length || 1), viewportLogBudget));
    const maxScroll = Math.max(0, sourceLines.length - maxLogLines);
    this.lastScrollMax = maxScroll;
    this.lastScrollSourceLength = sourceLines.length;
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);
    const start = Math.max(0, sourceLines.length - maxLogLines - this.scrollOffset);
    const visibleLogs = sourceLines.slice(start, start + maxLogLines);
    const taskContextLine = this.visibleTimelineHasCurrentTask(visibleLogs) ? "" : rawTaskContextLine;
    const visibleStart = sourceLines.length === 0 ? 0 : start + 1;
    const visibleEnd = Math.min(sourceLines.length, start + visibleLogs.length);
    const viewName = this.showRawLogs ? "raw" : "timeline";
    const scrollLabel = this.scrollOffset > 0
      ? ` | ${viewName}:${visibleStart}-${visibleEnd}/${sourceLines.length}`
      : sourceLines.length > maxLogLines
        ? ` | ${viewName}:bottom ${visibleEnd}/${sourceLines.length}`
        : "";
    const ctxStatus =
      this.contextLimit > 0
        ? ` | ctx:${formatCompactNumber(this.contextUsed)}/${formatCompactNumber(this.contextLimit)}(${Math.min(999, Math.round((this.contextUsed / this.contextLimit) * 100))}%)`
        : "";
    const todoDone = this.todos.filter((t) => String(t?.status || "").toLowerCase() === "completed").length;
    const todoStatus = this.todos.length > 0 ? ` | TODO(${todoDone}/${this.todos.length})` : "";
    const planStatus = this.planModeEnabled ? " | plan:on" : "";
    const promptStatusRaw = `${this.lastStatus || "idle"}${planStatus}${ctxStatus}${todoStatus}${scrollLabel}`;
    const bashMode = /^\s*!/.test(this.currentInput) ? " | mode:bash" : "";
    const leftStatusLabel = this.formatTransientStatusLabel() || this.formatProjectInstructionsLabel();
    let promptStatus = "";
    if (leftStatusLabel) {
      const left = truncateLine(` ${leftStatusLabel}`, width);
      const fixedLeft = stringDisplayWidth(left);
      const rightBudget = Math.max(0, bottomWidth - fixedLeft - 1);
      const right = truncateLine(`${promptStatusRaw}${bashMode}`, rightBudget);
      const pad = Math.max(1, bottomWidth - fixedLeft - stringDisplayWidth(right));
      promptStatus = `${left}${" ".repeat(pad)}${right}`;
    } else {
      const raw = `${promptStatusRaw}${bashMode}`;
      promptStatus =
        stringDisplayWidth(raw) >= bottomWidth
          ? truncateLine(raw, bottomWidth)
          : `${" ".repeat(Math.max(0, bottomWidth - stringDisplayWidth(raw)))}${raw}`;
    }
    const approvalBlock = this.approvalPrompt ? [sep, ...approvalContentLines] : [];
    const clarificationBlock = this.clarificationPrompt ? [sep, ...clarificationContentLines] : [];
    const taskContextBlock = taskContextLine ? ["", taskContextLine] : [];
    const thinkingColors = ["82", "118", "154", "190", "201"];
    const thinkingColor = thinkingColors[this.thinkingTick % thinkingColors.length];
    const spinFrames = this.unicodeSymbols ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
    const spin = spinFrames[this.thinkingTick % spinFrames.length];
    const thought = String(this.thoughtStreamText || "").trim();
    const thoughtSuffix = thought ? ` · ${truncateLine(thought.replace(/^Thinking:\s*/i, ""), Math.max(20, width - 46))}` : "";
    const runningLine = ` ${spin} thinking${this.thinkingStage ? `:${this.thinkingStage}` : ""} · ${this.formatElapsedSinceTurnStart()}${thoughtSuffix}`;
    const thinkingBlock = this.thinking ? [color(runningLine, `1;${thinkingColor}`)] : [];
    const thoughtStreamBlock = [];

    const todoMark = (status) =>
      status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
    const todoLinesBlock = this.showTodoPanel
      ? [
          sep,
          ...[
            " TODO",
            ...(this.todos.length === 0
              ? ["(no tasks yet)"]
              : this.todos
                  .slice(0, Math.max(0, todoLines - 1))
                  .map((todo) => `${todoMark(todo.status)} ${todo.content}`)),
          ].map((line) => truncateLine(line, width)),
        ]
      : [];

    const commandSuggestionBlock = this.commandSuggestionsVisible
      ? [
          color(` ${this.commandSuggestionLabel}`, "2;37"),
          ...this.commandSuggestions.map((command, idx) => {
            const selected = idx === this.commandSuggestionIndex;
            const text = selected ? color(`> ${command}`, "1;32") : color(`  ${command}`, "2;37");
            return truncateLine(` ${text}`, bottomWidth);
          }),
        ]
      : [];

    const modelSuggestionBlock = this.modelSuggestionsVisible
      ? [
          (() => {
            const current = String(this.providerLabel?.() || this.modelName || "").trim();
            const label = current ? ` models <${current}>` : " models";
            return color(label, "2;37");
          })(),
          ...(modelSuggestionViewport && modelSuggestionViewport.hiddenAbove > 0
            ? [truncateLine(` ${color(`... ${modelSuggestionViewport.hiddenAbove} above`, "2;37")}`, bottomWidth)]
            : []),
          ...((modelSuggestionViewport?.items || []).map((modelId, offset) => {
            const absoluteIndex = (modelSuggestionViewport?.start || 0) + offset;
            const selected = absoluteIndex === this.modelSuggestionIndex;
            const text = selected ? color(`> ${modelId}`, "1;32") : color(`  ${modelId}`, "2;37");
            return truncateLine(` ${text}`, bottomWidth);
          })),
          ...(modelSuggestionViewport && modelSuggestionViewport.hiddenBelow > 0
            ? [truncateLine(` ${color(`... ${modelSuggestionViewport.hiddenBelow} below`, "2;37")}`, bottomWidth)]
            : []),
        ]
      : [];

    const beforeInputLines = [
      ...(errorLine ? [`\x1b[31m${errorLine}\x1b[0m`] : []),
      ...visibleLogs,
      ...todoLinesBlock,
      ...approvalBlock,
      ...clarificationBlock,
      ...taskContextBlock,
      ...thinkingBlock,
      ...thoughtStreamBlock,
      sep,
    ];
    const frameLines = [
      ...beforeInputLines,
      ...inputState.lines.map((line) => `\x1b[1m${line}\x1b[0m`),
      ...commandSuggestionBlock,
      ...modelSuggestionBlock,
      sep,
      `\x1b[2m${promptStatus}\x1b[0m`,
      ...(this.startupShortcutHint ? [`\x1b[2m${truncateLine(` ${this.startupShortcutHint}`, bottomWidth)}\x1b[0m`] : []),
      ...(this.inputHint ? [`\x1b[2m${truncateLine(` ${this.inputHint}`, bottomWidth)}\x1b[0m`] : []),
    ];

    const frame = renderFrameLines(frameLines, width, height);
    this.lastFrameLineCount = frameLines.length;
    this.lastInputRow = Math.max(1, beforeInputLines.length + 1);
    this.lastInputLine = inputState.lines.join("\n");
    const cursorRow = Math.max(1, Math.min(height, this.lastInputRow + Math.max(0, inputState.cursorRowOffset)));
    if (this.layout) {
      const inputComposite = [
        ...inputState.lines.map((line) => line),
        ...commandSuggestionBlock,
        ...modelSuggestionBlock,
      ];
      this.layout.render({
        workspaceLines: beforeInputLines.slice(0, -1),
        inputLines: inputComposite,
        statusLine: promptStatus,
        separatorGlyph: this.unicodeSymbols ? "─" : "-",
        hintLine: [
          this.startupShortcutHint ? truncateLine(` ${this.startupShortcutHint}`, bottomWidth) : "",
          this.inputHint ? truncateLine(` ${this.inputHint}`, bottomWidth) : "",
        ].filter(Boolean).join("\n"),
        cursorRowOffset: Math.max(0, inputState.cursorRowOffset),
        cursorCol: inputState.cursorCol,
      });
      return;
    }
    this.out.write(TERMINAL_PAINT_PREFIX + terminalFrame(frame) + `\x1b[${cursorRow};${inputState.cursorCol}H\x1b[?25h`);
  }
}

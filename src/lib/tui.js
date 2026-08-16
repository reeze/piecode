import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import { DEFAULT_INPUT_HINTS, sanitizeInputHints } from "./inputHints.js";

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/g;
const TERMINAL_PAINT_PREFIX = "\x1b[?25l\x1b%G\x1b(B\x1b[0m\x1b[2J\x1b[H";
function markdownItHighlight(md) {
  md.inline.ruler.before("emphasis", "piecode_highlight", (state, silent) => {
    const start = state.pos;
    const marker = state.src.slice(start, start + 2);
    if (marker !== "==") return false;
    if (state.src[start + 2] === "=") return false;

    let end = start + 2;
    while ((end = state.src.indexOf("==", end)) >= 0) {
      if (state.src[end - 1] === "\\" || state.src[end + 2] === "=") {
        end += 2;
        continue;
      }
      break;
    }
    if (end < 0 || end === start + 2) return false;
    if (silent) return true;

    const oldMax = state.max;
    state.pos = start + 2;
    state.max = end;
    const oldSrc = state.src;
    state.src = oldSrc.slice(0, end);
    const open = state.push("mark_open", "mark", 1);
    open.markup = "==";
    state.md.inline.tokenize(state);
    const close = state.push("mark_close", "mark", -1);
    close.markup = "==";
    state.src = oldSrc;
    state.pos = end + 2;
    state.max = oldMax;
    return true;
  });
}

const markdownParser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
})
  .enable("table")
  .use(markdownItTaskLists)
  .use(markdownItHighlight);

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

function normalizeCodeLang(lang = "") {
  const value = String(lang || "").trim().toLowerCase();
  if (["js", "jsx", "javascript", "mjs", "cjs"].includes(value)) return "js";
  if (["ts", "tsx", "typescript", "mts", "cts"].includes(value)) return "js";
  if (["json", "jsonc"].includes(value)) return "json";
  if (["sh", "bash", "zsh", "shell", "shellscript"].includes(value)) return "shell";
  if (["diff", "patch"].includes(value)) return "diff";
  if (["md", "markdown"].includes(value)) return "markdown";
  return value;
}

function scanCodeLine(line, {
  keywords = new Set(),
  builtins = new Set(),
  commentStart = "//",
  hashComments = false,
  variables = false,
} = {}) {
  const source = String(line ?? "");
  let out = "";
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i);
    if (commentStart && rest.startsWith(commentStart)) {
      out += color(rest, "2;37");
      break;
    }
    if (hashComments && rest.startsWith("#")) {
      out += color(rest, "2;37");
      break;
    }
    if (variables && rest.startsWith("$")) {
      const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*|^\$\{[^}]+\}/);
      if (match) {
        out += color(match[0], "1;36");
        i += match[0].length;
        continue;
      }
    }
    const quote = source[i];
    if (quote === "\"" || quote === "'" || quote === "`") {
      let token = quote;
      i += 1;
      while (i < source.length) {
        const ch = source[i];
        token += ch;
        i += 1;
        if (ch === "\\") {
          if (i < source.length) {
            token += source[i];
            i += 1;
          }
          continue;
        }
        if (ch === quote) break;
      }
      out += color(token, "32");
      continue;
    }
    const number = rest.match(/^\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/);
    if (number) {
      out += color(number[0], "35");
      i += number[0].length;
      continue;
    }
    const ident = rest.match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (ident) {
      const token = ident[0];
      if (keywords.has(token)) out += color(token, "1;35");
      else if (builtins.has(token)) out += color(token, "36");
      else out += token;
      i += token.length;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function highlightJsonLine(line) {
  const source = String(line ?? "");
  let out = "";
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i);
    if (rest[0] === "\"") {
      let token = "\"";
      i += 1;
      while (i < source.length) {
        const ch = source[i];
        token += ch;
        i += 1;
        if (ch === "\\") {
          if (i < source.length) {
            token += source[i];
            i += 1;
          }
          continue;
        }
        if (ch === "\"") break;
      }
      const after = source.slice(i).trimStart();
      out += color(token, after.startsWith(":") ? "1;34" : "32");
      continue;
    }
    const literal = rest.match(/^(true|false|null)\b/);
    if (literal) {
      out += color(literal[0], literal[0] === "null" ? "2;37" : "33");
      i += literal[0].length;
      continue;
    }
    const number = rest.match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
    if (number) {
      out += color(number[0], "35");
      i += number[0].length;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function highlightDiffLine(line) {
  const source = String(line ?? "");
  if (source.startsWith("+") && !source.startsWith("+++")) return color(source, "32");
  if (source.startsWith("-") && !source.startsWith("---")) return color(source, "31");
  if (source.startsWith("@@")) return color(source, "1;36");
  if (/^(diff --git|index |--- |\+\+\+ )/.test(source)) return color(source, "2;37");
  return source;
}

function highlightCodeLine(line, lang = "") {
  const normalized = normalizeCodeLang(lang);
  if (normalized === "json") return highlightJsonLine(line);
  if (normalized === "diff") return highlightDiffLine(line);
  if (normalized === "shell") {
    return scanCodeLine(line, {
      keywords: new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "case", "esac", "while", "function"]),
      builtins: new Set(["cd", "echo", "export", "source", "npm", "pnpm", "yarn", "node", "git", "rg"]),
      commentStart: "",
      hashComments: true,
      variables: true,
    });
  }
  if (normalized === "js") {
    return scanCodeLine(line, {
      keywords: new Set([
        "await", "async", "break", "case", "catch", "class", "const", "continue", "default", "else", "export",
        "extends", "finally", "for", "from", "function", "if", "import", "let", "new", "return", "switch",
        "throw", "try", "typeof", "var", "while", "yield", "true", "false", "null", "undefined"
      ]),
      builtins: new Set(["Array", "Boolean", "Date", "JSON", "Map", "Math", "Number", "Object", "Promise", "React", "Set", "String", "console", "process"]),
      commentStart: "//",
    });
  }
  if (normalized === "markdown") {
    return String(line ?? "").replace(/^(#{1,6})\s+(.+)$/, (_m, marks, title) => `${color(marks, "2;37")} ${color(title, "1;36")}`);
  }
  return color(line || " ", "36");
}

function truncateDisplayText(text, maxWidth) {
  const source = String(text || "");
  const limit = Math.max(1, Number(maxWidth) || 1);
  if (stringDisplayWidth(source) <= limit) return source;
  const ellipsis = limit > 1 ? "…" : "";
  const target = Math.max(0, limit - stringDisplayWidth(ellipsis));
  let out = "";
  let used = 0;
  for (const segment of graphemeSegmenter ? graphemeSegmenter.segment(source) : source) {
    const textSegment = typeof segment === "string" ? segment : segment.segment;
    const width = stringDisplayWidth(textSegment);
    if (used + width > target) break;
    out += textSegment;
    used += width;
  }
  return `${out}${ellipsis}`;
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

function renderInlineTokens(tokens = []) {
  const items = Array.isArray(tokens) ? tokens : [];
  let out = "";
  const marks = [];
  const style = () => marks.filter(Boolean).join(";");
  const apply = (text) => {
    const value = String(text || "");
    const code = style();
    return code ? color(value, code) : value;
  };

  for (const token of items) {
    switch (token.type) {
      case "text":
      case "code_inline":
        out += token.type === "code_inline" ? color(token.content, "34") : apply(token.content);
        break;
      case "softbreak":
      case "hardbreak":
        out += "\n";
        break;
      case "strong_open":
        marks.push("1");
        break;
      case "strong_close":
        marks.pop();
        break;
      case "em_open":
        marks.push("3");
        break;
      case "em_close":
        marks.pop();
        break;
      case "s_open":
        marks.push("9;2");
        break;
      case "s_close":
        marks.pop();
        break;
      case "mark_open":
        marks.push("30;43");
        break;
      case "mark_close":
        marks.pop();
        break;
      case "link_open": {
        const href = token.attrGet?.("href") || "";
        marks.push("4;34");
        if (href) token._piecodeHref = href;
        break;
      }
      case "link_close": {
        marks.pop();
        break;
      }
      case "image": {
        const src = token.attrGet?.("src") || "";
        const alt = token.content || token.attrGet?.("alt") || "";
        out += `${color("image", "1;35")}${alt ? color(` ${alt}`, "35") : ""}${src ? color(` (${src})`, "2;37") : ""}`;
        break;
      }
      case "html_inline": {
        const html = String(token.content || "");
        if (/task-list-item-checkbox/i.test(html)) {
          out += /checked/i.test(html) ? color("[x]", "1;32") : color("[ ]", "2;37");
        } else {
          out += apply(token.content);
        }
        break;
      }
      default:
        if (token.content) out += apply(token.content);
        break;
    }
    if (token.type === "link_close") {
      const open = [...items].reverse().find((item) => item.type === "link_open" && item._piecodeHref);
      if (open?._piecodeHref) out += color(` (${open._piecodeHref})`, "2;37");
    }
  }
  return out;
}

function renderInlineToken(token) {
  if (!token) return "";
  if (Array.isArray(token.children)) return renderInlineTokens(token.children);
  return renderInlineMarkdown(token.content || "");
}

function renderMarkdownTableFromTokens(tokens, startIndex, { maxWidth = 100 } = {}) {
  const rows = [];
  const aligns = [];
  let currentRow = null;
  let currentCell = null;
  let inHeader = false;
  let i = startIndex;

  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "table_close") break;
    if (token.type === "thead_open") inHeader = true;
    if (token.type === "thead_close") inHeader = false;
    if (token.type === "tr_open") currentRow = { header: inHeader, cells: [] };
    if ((token.type === "th_open" || token.type === "td_open") && currentRow) {
      currentCell = "";
      if (token.type === "th_open") aligns.push(token.attrGet?.("style")?.includes("right") ? "right" : token.attrGet?.("style")?.includes("center") ? "center" : "left");
    }
    if (token.type === "inline" && currentCell != null) currentCell += stripAnsi(renderInlineToken(token));
    if ((token.type === "th_close" || token.type === "td_close") && currentRow && currentCell != null) {
      currentRow.cells.push(currentCell.trim());
      currentCell = null;
    }
    if (token.type === "tr_close" && currentRow) {
      rows.push(currentRow.cells);
      currentRow = null;
    }
  }

  const header = rows[0] || [];
  const bodyRows = rows.slice(1);
  const columnCount = Math.max(header.length, aligns.length, ...bodyRows.map((row) => row.length), 0);
  if (columnCount === 0) return { nextIndex: i, rendered: [] };
  const normalize = (row) => Array.from({ length: columnCount }, (_v, idx) => row[idx] || "");
  const normalizedHeader = normalize(header);
  const normalizedRows = bodyRows.map(normalize);
  const allRows = [normalizedHeader, ...normalizedRows];
  const minCellWidth = 3;
  const maxCellWidth = 40;
  const borderWidth = columnCount > 0 ? (columnCount * 3) + 1 : 0;
  const availableCellsWidth = Math.max(columnCount * minCellWidth, Math.max(20, Number(maxWidth) || 100) - borderWidth);
  const widths = Array.from({ length: columnCount }, (_v, idx) =>
    Math.max(minCellWidth, Math.min(maxCellWidth, Math.max(...allRows.map((row) => stringDisplayWidth(row[idx] || "")), minCellWidth)))
  );
  while (widths.reduce((sum, width) => sum + width, 0) > availableCellsWidth) {
    let widestIndex = 0;
    for (let idx = 1; idx < widths.length; idx += 1) {
      if (widths[idx] > widths[widestIndex]) widestIndex = idx;
    }
    if (widths[widestIndex] <= minCellWidth) break;
    widths[widestIndex] -= 1;
  }
  const renderRow = (row, style = "") => {
    const cells = row.map((cell, idx) => padTableCell(truncateDisplayText(cell, widths[idx]), widths[idx], aligns[idx] || "left"));
    const text = `│ ${cells.join(" │ ")} │`;
    return style ? color(text, style) : text;
  };
  const sep = color(`├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`, "2;37");
  return { nextIndex: i, rendered: [renderRow(normalizedHeader, "1"), sep, ...normalizedRows.map((row) => renderRow(row))] };
}

function listIndent(level) {
  return "  ".repeat(Math.max(0, Number(level) || 0));
}

function listGlyph(level) {
  if (level <= 0) return "•";
  if (level === 1) return "◦";
  return "▪";
}

function renderMarkdownLines(text, options = {}) {
  const tokens = markdownParser.parse(String(text || "").replace(/\r/g, ""), {});
  const maxTableWidth = Math.max(20, Number(options.maxTableWidth) || 100);
  const lines = [];
  const listStack = [];
  const listTightStack = [];
  let quoteDepth = 0;
  let pendingListItem = null;

  const appendInline = (token) => {
    const rendered = renderInlineToken(token);
    for (let part of String(rendered || "").split("\n")) {
      if (!part) continue;
      if (pendingListItem) {
        const taskMatch = stripAnsi(part).match(/^\s*(\[[x ]\])\s+/i);
        const marker = taskMatch
          ? ""
          : pendingListItem.type === "ordered"
            ? color(`${pendingListItem.number}.`, "2;37")
            : color(listGlyph(pendingListItem.level), "2;37");
        if (taskMatch) part = part.replace(/^\s+/, "");
        lines.push(`${listIndent(pendingListItem.level)}${marker}${marker ? " " : ""}${part}`);
        pendingListItem = null;
      } else if (quoteDepth > 0) {
        lines.push(`${color("│".repeat(Math.min(3, quoteDepth)), "2;37")} ${color(part, "3;37")}`);
      } else {
        lines.push(part);
      }
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    switch (token.type) {
      case "bullet_list_open":
        listStack.push({ type: "bullet", next: 1 });
        listTightStack.push(Boolean(token.hidden));
        break;
      case "ordered_list_open":
        listStack.push({ type: "ordered", next: Math.max(1, Number(token.attrGet?.("start") || token.info) || 1) });
        listTightStack.push(Boolean(token.hidden));
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listStack.pop();
        listTightStack.pop();
        break;
      case "list_item_open": {
        const list = listStack[listStack.length - 1] || { type: "bullet", next: 1 };
        const level = Math.max(0, listStack.length - 1);
        pendingListItem = { type: list.type, level, number: list.next };
        list.next += 1;
        break;
      }
      case "list_item_close":
        pendingListItem = null;
        break;
      case "heading_open": {
        const inline = tokens[i + 1]?.type === "inline" ? tokens[i + 1] : null;
        const level = Number(token.tag?.replace(/^h/, "")) || 1;
        const prefix = level <= 2 ? "◆" : level <= 4 ? "›" : "·";
        const rendered = renderInlineToken(inline);
        lines.push(level <= 2 ? color(`${prefix} ${rendered}`, "1;36") : color(`${prefix} ${rendered}`, "1"));
        if (inline) i += 2;
        break;
      }
      case "paragraph_open":
        if (pendingListItem && listTightStack[listTightStack.length - 1]) {
          let offset = i + 1;
          if (tokens[offset]?.type === "inline") offset += 1;
          if (tokens[offset]?.type === "paragraph_close") i = offset;
        }
        break;
      case "paragraph_close":
        break;
      case "inline":
        appendInline(token);
        break;
      case "fence":
      case "code_block": {
        const codeLines = String(token.content || "").replace(/\n$/, "").split("\n");
        lines.push(...codeLines.map((line) => highlightCodeLine(line || " ", token.info || "")));
        break;
      }
      case "blockquote_open":
        quoteDepth += 1;
        break;
      case "blockquote_close":
        quoteDepth = Math.max(0, quoteDepth - 1);
        break;
      case "hr":
        break;
      case "table_open": {
        const table = renderMarkdownTableFromTokens(tokens, i, { maxWidth: maxTableWidth });
        lines.push(...table.rendered);
        i = table.nextIndex;
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

function normalizeTimelineSpacing(lines) {
  const result = [];
  let previousGroup = "";

  const classify = (line) => {
    const raw = String(line || "");
    const stripped = stripAnsi(String(line || ""));
    const plain = stripped.trimStart();
    if (!plain) return "blank";
    if (/^(?:◆|\*|❯)\s+(?:Task:\s*)?/i.test(plain)) return "task";
    if (/^(?:↳|->)\s+/.test(plain)) return "tool-result";
    if (/^(?:›|>)\s+/.test(plain)) return "tool";
    if (/^(?:✓|\[ok\])\s+.*\b(?:done|completed|success|succeeded)\b/i.test(plain)) return "done-result";
    if (/\x1b\[1;35m(?:•|\*)\x1b\[0m/.test(raw)) return "update";
    if (/^(?:•|\*|✓|×|\[ok\]|\[x\])\s+/.test(plain)) return "response";
    if (/^\s{2,}\S/.test(stripped)) return previousGroup || "continuation";
    return "content";
  };

  const shouldSeparateGroups = (previous, current) => {
    if (!previous || previous === "blank" || current === "blank" || previous === current) return false;
    if (current === "tool-result" && previous === "tool") return false;
    return true;
  };

  for (const line of Array.isArray(lines) ? lines : []) {
    const group = classify(line);
    if (result.length === 0 && group === "done-result") {
      result.push("");
    }
    if (result.length > 0 && shouldSeparateGroups(previousGroup, group) && result[result.length - 1] !== "") {
      result.push("");
    }
    result.push(line);
    previousGroup = group;
  }

  return result;
}

function isDoneResultTimelineLine(line) {
  const plain = stripAnsi(String(line || "")).trim();
  return /^(?:✓|\[ok\])\s+.*\b(?:done|completed|success|succeeded)\b/i.test(plain);
}

function dedupeAdjacentResultRows(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const result = [];
  let previousResult = "";
  for (const line of source) {
    const plain = stripAnsi(String(line || "")).trim();
    if (plain && isDoneResultTimelineLine(line)) {
      if (previousResult && previousResult === plain) continue;
      previousResult = plain;
    } else if (plain) {
      previousResult = "";
    }
    result.push(line);
  }
  return result;
}

function highlightDiffLineForDisplay(line) {
  const source = String(line ?? "");
  if (source.startsWith("+") && !source.startsWith("+++")) return color(source, "32");
  if (source.startsWith("-") && !source.startsWith("---")) return color(source, "31");
  if (source.startsWith("@@")) return color(source, "1;36");
  if (/^(diff --git|index |--- |\+\+\+ |# )/.test(source)) return color(source, "2;37");
  return source;
}

function renderDiffLines(text, { maxLines = 120 } = {}) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const limit = Math.max(1, Number(maxLines) || 120);
  const shown = lines.slice(0, limit).map((line) => highlightDiffLineForDisplay(line || " "));
  if (lines.length > limit) {
    shown.push(color(`... (${lines.length - limit} more diff lines)`, "2;37"));
  }
  return shown;
}

function highlightOverlaySectionLine(line) {
  const text = String(line || "");
  if (text.startsWith("+") && !text.startsWith("+++")) return color(text, "32");
  if (text.startsWith("-") && !text.startsWith("---")) return color(text, "31");
  if (text.startsWith("@@")) return color(text, "1;36");
  if (/^(diff --git|index |--- |\+\+\+ |# (?:Staged|Unstaged|Untracked))/i.test(text)) return color(text, "2;37");
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
  if (/^\s*Overview:/i.test(text)) {
    return text.replace(/^\s*Overview:/i, (m) => color(m.trim(), "1;33"));
  }
  if (/^\s*Sections:/i.test(text)) {
    return text.replace(/^\s*Sections:/i, (m) => color(m.trim(), "1;36"));
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

function joinStatusParts(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" | ");
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
        result: "↳",
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
  const maxHeight = Math.max(0, Number(height) || 0);
  const source = Array.isArray(lines) ? lines : [];
  const visible = maxHeight > 0 && source.length > maxHeight ? source.slice(source.length - maxHeight) : source;
  const out = visible.map((line) => padDisplayLine(line, paintWidth));
  while (out.length < maxHeight) out.push(padDisplayLine("", paintWidth));
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
  if (/^(?:◆|\*|❯)\s+(?:Task:\s*)?/i.test(trimmed)) return leading;
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
  if (/^\s+\S/.test(stripAnsi(String(line || ""))) && stringDisplayWidth(stripAnsi(line)) <= Math.max(0, Number(width) || 0)) {
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
    this.lastActivityAt = 0;
    this.lastActivityLabel = "";
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
    this.progressRefreshTimer = null;
    this.animateThinking = String(process.env.PIECODE_TUI_ANIMATION || "").trim() !== "0";
    this.thinkingAnimationMs = Math.max(80, Number(process.env.PIECODE_TUI_ANIMATION_MS) || 120);
    this.progressRefreshMs = Math.max(1000, Number(process.env.PIECODE_TUI_PROGRESS_REFRESH_MS) || 5000);
    this.modelSuggestionsVisible = false;
    this.modelSuggestions = [];
    this.modelSuggestionIndex = 0;
    this.modelSuggestionWindowStart = 0;
    this.modelSuggestionMaxVisible = 8;
    this.modelSuggestionMeta = new Map();
    this.commandSuggestionsVisible = false;
    this.commandSuggestions = [];
    this.commandSuggestionIndex = 0;
    this.commandSuggestionLabel = "commands";
    this.scrollOffset = 0;
    this.lastScrollMax = 0;
    this.lastScrollSourceLength = 0;
    this.wrappedTimelineCache = { source: null, length: -1, width: -1, lines: [] };
    this.wrappedLogsCache = { source: null, length: -1, width: -1, lines: [] };
    this.thoughtStreamText = "";
    this.thoughtStreamVisible = false;
    this.planModeEnabled = false;
    this.goalStatus = {
      active: false,
      label: "",
      iteration: 0,
      maxIterations: 0,
      status: "",
    };
    this.lastGoalStatusKey = "";
    this.lastGoalCompletionKey = "";
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
    this.overlaySectionOffsets = [];
    this.overlayActiveSection = "";
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
    if (this.layout && typeof this.layout.destroy === "function") {
      this.layout.destroy();
      return;
    }
    // Disable mouse reporting on exit (only if it was enabled).
    if (!this.layout) {
      if (this.mouseCaptureEnabled) this.out.write("\x1b[?1000l\x1b[?1006l");
      this.out.write("\x1b[2J\x1b[H\x1b[?25h");
    }
  }

  event(line) {
    const rawLine = String(line || "");
    if (rawLine.startsWith("[task] ")) {
      this.currentTaskText = rawLine.slice(7).trim();
      this.taskStartedAt = Date.now();
      this.taskCompletedAt = 0;
      this.scrollOffset = 0;
    }
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${rawLine}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(this.logs.length - this.maxLogs);
    }
    this.activity.push(entry);
    if (this.activity.length > this.maxActivity) {
      this.activity = this.activity.slice(this.activity.length - this.maxActivity);
    }
    const timelineLines = this.formatTimelineLines(rawLine);
    const spacedTimelineLines = this.withTimelineSpacing(timelineLines);
    if (rawLine.startsWith("[result] ")) {
      const previous = this.timeline.slice().reverse().find((item) => String(item || "").trim());
      const next = spacedTimelineLines.find((item) => String(item || "").trim());
      if (previous && next && stripAnsi(previous).trim() === stripAnsi(next).trim()) {
        return;
      }
    }
    for (const item of spacedTimelineLines) {
      this.timeline.push(item);
    }
    if (timelineLines.length > 0) this.markActivity(timelineLines[0]);
    if (this.timeline.length > this.maxTimeline) {
      this.timeline = this.timeline.slice(this.timeline.length - this.maxTimeline);
    }
    this.timeline = dedupeAdjacentResultRows(this.timeline);
  }

  markActivity(label = "") {
    this.lastActivityAt = Date.now();
    this.lastActivityLabel = stripAnsi(String(label || "")).replace(/\s+/g, " ").trim();
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
    this.markActivity("model request");
    this.startThinkingAnimation();
    this.render();
  }

  onToolUse(toolName) {
    this.lastTool = toolName || this.lastTool;
    this.lastStatus = `Using tool: ${toolName}`;
    this.markActivity(toolName ? `tool ${toolName}` : "tool");
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
    this.markActivity("task started");
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

  formatElapsedSinceLastActivity() {
    if (!this.lastActivityAt) return "";
    const ms = Math.max(0, Date.now() - this.lastActivityAt);
    if (ms < 10000) return "";
    const label = this.lastActivityLabel ? `: ${truncateLine(this.lastActivityLabel, 24)}` : "";
    return ` · last update ${(ms / 1000).toFixed(1)}s ago${label}`;
  }

  formatContextBannerLine({ label, status = "", body, suffix = "", width, marker = this.symbols.task, showLabel = true }) {
    const normalizedBody = String(body || "").replace(/\s+/g, " ").trim();
    if (!normalizedBody) return "";
    const elapsed = this.formatElapsedSinceTurnStart();
    const labelPart = showLabel && label ? `${label}: ` : "";
    const statusPart = status ? `${status} · ` : "";
    const prefix = `${marker} ${labelPart}${statusPart}`;
    const trailing = `${suffix || ""} · ${elapsed}`;
    const fixedBudget = stringDisplayWidth(prefix) + stringDisplayWidth(trailing) + 4;
    const text = truncateLine(normalizedBody, Math.max(16, width - fixedBudget));
    return colorFullLine(` ${prefix}${text}${trailing} `, "1;37;48;5;236", width);
  }

  formatTaskContextLine(width) {
    const status = this.taskCompletedAt ? (this.modelState === "error" ? "Failed" : "Done") : "";
    return this.formatContextBannerLine({
      label: "Task",
      status,
      body: this.currentTaskText,
      width,
      marker: this.symbols.prompt,
      showLabel: false,
    });
  }

  formatGoalContextLine(width) {
    const goal = this.goalStatus && typeof this.goalStatus === "object" ? this.goalStatus : {};
    if (!goal.active || !goal.label || this.isTerminalGoalStatus(goal.status)) return "";
    return this.formatContextBannerLine({
      label: "Goal",
      status: this.formatGoalDisplayStatus(goal.status),
      body: goal.label,
      suffix: this.formatGoalIterationSuffix(goal),
      width,
    });
  }

  isTerminalGoalStatus(status = "") {
    const value = String(status || "").trim().toLowerCase();
    return value === "complete" || value === "blocked" || value === "maxed";
  }

  formatGoalDisplayStatus(status = "") {
    const value = String(status || "active").trim().toLowerCase();
    if (value === "complete") return "Done";
    if (value === "blocked") return "Blocked";
    if (value === "maxed") return "Maxed";
    return "Running";
  }

  formatGoalIterationSuffix(goal = {}) {
    const iteration = Math.max(0, Number(goal.iteration) || 0);
    const maxIterations = Math.max(0, Number(goal.maxIterations) || 0);
    if (maxIterations > 0 && iteration > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((iteration / maxIterations) * 100)));
      return ` · ${iteration}/${maxIterations} · ${pct}%`;
    }
    if (iteration > 0) return ` · ${iteration}`;
    return "";
  }

  formatGoalTimelineLine(goal = {}) {
    const label = String(goal.label || goal.goal || "").replace(/\s+/g, " ").trim();
    if (!label) return "";
    return `Goal: ${this.formatGoalDisplayStatus(goal.status)} · ${label}${this.formatGoalIterationSuffix(goal)}`;
  }

  visibleTimelineHasCurrentTask(lines = []) {
    const task = String(this.currentTaskText || "").replace(/\s+/g, " ").trim();
    if (!task || this.showRawLogs) return false;
    const matchesTask = (value) => {
      const plain = String(value || "")
        .replace(/^(?:◆|\*|❯|>)\s+(?:Task:\s*)?/i, "")
        .replace(/\.\.\./g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!plain) return false;
      if (plain.includes(task) || task.includes(plain)) return true;
      return plain.length >= 24 && task.startsWith(plain);
    };
    let taskBlock = "";
    const flush = () => {
      const visible = matchesTask(taskBlock);
      taskBlock = "";
      return visible;
    };
    for (const line of Array.isArray(lines) ? lines : []) {
      const plain = stripAnsi(String(line || "")).replace(/\s+/g, " ").trim();
      if (!plain) {
        if (flush()) return true;
        continue;
      }
      if (/^(?:◆|\*|❯|>)\s+(?:Task:\s*)?/i.test(plain)) {
        if (flush()) return true;
        taskBlock = plain;
        if (matchesTask(taskBlock)) return true;
        continue;
      }
      if (!taskBlock) continue;
      if (/^(?:↳|->|›|>|•|✓|×|\[ok\]|\[x\]|\[i\])\s+/i.test(plain)) {
        if (flush()) return true;
        continue;
      }
      taskBlock = `${taskBlock} ${plain}`;
      if (matchesTask(taskBlock)) return true;
    }
    return flush();
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
    const previous = this.thoughtStreamText.replace(/^Thinking:\s*/i, "");
    this.thoughtStreamVisible = false;
    this.thoughtStreamText = text ? `Thinking: ${text}` : "";
    if (text && text !== previous) this.markActivity("model update");
    if (text) this.lastStatus = "thinking...";
    // ponytail: streaming deltas can arrive hundreds of times per second;
    // paint immediately when idle, coalesce bursts to ~20fps.
    const now = Date.now();
    if (now - (this.liveThoughtRenderAt || 0) >= 50) {
      this.liveThoughtRenderAt = now;
      this.render();
    } else if (!this.liveThoughtRenderTimer) {
      this.liveThoughtRenderTimer = setTimeout(() => {
        this.liveThoughtRenderTimer = null;
        this.liveThoughtRenderAt = Date.now();
        this.render();
      }, 50);
      this.liveThoughtRenderTimer.unref?.();
    }
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
    if (!this.animateThinking) {
      this.startProgressRefresh();
      return;
    }
    if (this.thinkingTimer) return;
    this.thinkingTimer = setInterval(() => {
      if (!this.active || !this.thinking) return;
      this.thinkingTick = (this.thinkingTick + 1) % 1000;
      this.render();
    }, this.thinkingAnimationMs);
    this.thinkingTimer.unref?.();
  }

  stopThinkingAnimation() {
    if (this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    if (this.progressRefreshTimer) {
      clearInterval(this.progressRefreshTimer);
      this.progressRefreshTimer = null;
    }
  }

  startProgressRefresh() {
    if (this.progressRefreshTimer || !this.progressRefreshMs) return;
    this.progressRefreshTimer = setInterval(() => {
      if (!this.active || !this.thinking) return;
      this.render();
    }, this.progressRefreshMs);
    this.progressRefreshTimer.unref?.();
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
            risk: String(meta.risk || meta.level || "").trim(),
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

  setGoalStatus(status = null) {
    const next = status && typeof status === "object" ? status : {};
    const normalized = {
      active: Boolean(next.active),
      label: String(next.label || next.goal || "").trim(),
      iteration: Math.max(0, Number(next.iteration) || 0),
      maxIterations: Math.max(0, Number(next.maxIterations) || 0),
      status: String(next.status || "").trim().toLowerCase(),
    };
    const statusKey = [normalized.active, normalized.label, normalized.iteration, normalized.maxIterations, normalized.status].join("\u0000");
    if (statusKey === this.lastGoalStatusKey) return;
    this.lastGoalStatusKey = statusKey;
    if (normalized.active && this.isTerminalGoalStatus(normalized.status)) {
      const completionKey = [normalized.status, normalized.label, normalized.iteration, normalized.maxIterations].join("\u0000");
      if (completionKey !== this.lastGoalCompletionKey) {
        const line = this.formatGoalTimelineLine(normalized);
        if (line) this.event(`[result] ${line}`);
        this.lastGoalCompletionKey = completionKey;
      }
      this.goalStatus = { ...normalized, active: false };
    } else {
      if (normalized.active) this.lastGoalCompletionKey = "";
      if (!normalized.active) this.lastGoalStatusKey = "";
      this.goalStatus = normalized;
    }
    this.render();
  }

  openOverlay(title, text, options = {}) {
    const maxOverlayChars = Math.max(2000, Number(process.env.PIECODE_TUI_OVERLAY_MAX_CHARS) || 120000);
    const clipped = trimWorkspaceText(text, maxOverlayChars);
    this.overlayVisible = true;
    this.overlayTitle = String(title || "Details");
    this.overlayText = clipped.trimmed > 0
      ? `${clipped.text}\n\n[overlay clipped ${clipped.trimmed} chars; set PIECODE_TUI_OVERLAY_MAX_CHARS to adjust]`
      : clipped.text;
    this.overlayScroll = 0;
    this.overlayMode = String(options?.mode || "");
    this.overlayHint = String(options?.hint || "");
    this.overlaySearchActive = false;
    this.overlaySearchQuery = "";
    this.overlaySectionOffsets = [];
    this.overlayActiveSection = "";
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
    this.overlaySectionOffsets = [];
    this.overlayActiveSection = "";
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
    const sectionPatterns = [
      { key: "request", label: "Request", pattern: /^request:/i },
      { key: "overview", label: "Overview", pattern: /^overview:/i },
      { key: "thinking", label: "Thinking", pattern: /^thinking output:/i },
      { key: "response", label: "Response", pattern: /^response:/i },
      { key: "key", label: "Key", pattern: /^response key content:/i },
      { key: "raw", label: "Raw", pattern: /^response raw:/i },
    ];
    const sectionOffsets = [];
    let requestOffset = 0;
    let responseOffset = Math.max(0, wrapped.length - 1);
    for (let i = 0; i < renderedLines.length; i += 1) {
      const line = stripAnsi(String(renderedLines[i] || "")).trimStart();
      const lower = line.toLowerCase();
      const offset = rawStartOffsets[i] || 0;
      for (const section of sectionPatterns) {
        if (section.pattern.test(line)) {
          if (!sectionOffsets.some((item) => item.key === section.key)) {
            sectionOffsets.push({ key: section.key, label: section.label, offset });
          }
          break;
        }
      }
      if (lower.startsWith("request:")) requestOffset = offset;
      if (lower.startsWith("response:")) responseOffset = offset;
    }
    sectionOffsets.sort((a, b) => a.offset - b.offset);
    return { wrapped, requestOffset, responseOffset, sectionOffsets };
  }

  jumpOverlaySection(which = "request") {
    if (!this.overlayVisible) return 0;
    const width = Math.max(20, Math.max(40, this.out.columns || 100) - 1);
    const layout = this.buildOverlayLayout(width);
    const targetKey = String(which || "request").toLowerCase();
    const direct = layout.sectionOffsets.find((section) => section.key === targetKey);
    if (direct) this.overlayScroll = direct.offset;
    else this.overlayScroll = targetKey === "response" ? layout.responseOffset : layout.requestOffset;
    this.render();
    return this.overlayScroll;
  }

  jumpOverlaySectionRelative(delta = 1) {
    if (!this.overlayVisible) return 0;
    const width = Math.max(20, Math.max(40, this.out.columns || 100) - 1);
    const layout = this.buildOverlayLayout(width);
    const sections = Array.isArray(layout.sectionOffsets) ? layout.sectionOffsets : [];
    if (sections.length === 0) return this.overlayScroll;
    const direction = Number(delta) < 0 ? -1 : 1;
    let index = direction > 0
      ? sections.findIndex((section) => section.offset > this.overlayScroll)
      : -1;
    if (direction < 0) {
      for (let i = sections.length - 1; i >= 0; i -= 1) {
        if (sections[i].offset < this.overlayScroll) {
          index = i;
          break;
        }
      }
    }
    if (index < 0) index = direction > 0 ? 0 : sections.length - 1;
    const targetOffset = sections[index].offset;
    this.overlayScroll = direction > 0 && targetOffset > 0 ? targetOffset - 1 : targetOffset;
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

  /**
   * Per-model annotations shown dimmed after each picker row, keyed by the
   * model id, e.g. `{ "deepseek:deepseek-chat": "128k ctx · coding" }`.
   */
  setModelSuggestionMeta(meta) {
    if (meta instanceof Map) {
      this.modelSuggestionMeta = meta;
    } else if (meta && typeof meta === "object") {
      this.modelSuggestionMeta = new Map(Object.entries(meta));
    } else {
      this.modelSuggestionMeta = new Map();
    }
  }

  getModelSuggestionMeta(modelId) {
    if (!(this.modelSuggestionMeta instanceof Map)) return "";
    return String(this.modelSuggestionMeta.get(String(modelId || "")) || "");
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
    const viewportRows = Math.max(1, (this.out?.rows || 30) - 6);
    const limit = Math.max(1, Math.min(8, viewportRows));
    const requestedIndex = Math.max(0, Number(selectedIndex) || 0);
    const start = Math.max(0, Math.min(requestedIndex, Math.max(0, list.length - limit)));
    this.commandSuggestions = list.slice(start, start + limit);
    this.commandSuggestionLabel = String(label || "commands");
    this.commandSuggestionsVisible = this.commandSuggestions.length > 0;
    if (!this.commandSuggestionsVisible) {
      this.commandSuggestionIndex = 0;
    } else {
      const localIndex = Math.max(0, Math.min(this.commandSuggestions.length - 1, requestedIndex - start));
      this.commandSuggestionIndex = localIndex;
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
    let riskText = String(meta?.risk || "").trim();

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
      question = "Approve command?";
    }

    if (!question && command) {
      question = "Approve command?";
    }

    const risk = riskText ? riskText.toLowerCase() : "";
    const title = ` ? Approval needed${risk ? ` · ${risk}` : ""}`;
    lines.push(color(title, risk === "dangerous" ? "1;31" : "1;33"));
    if (command) {
      lines.push(truncateLine(`   ${color("$", "2;37")} ${color(command, "37")}`, width));
    } else if (question) {
      lines.push(truncateLine(`   ${question}`, width));
    }
    if (!detailsText && prompt && normalize(prompt) !== normalize(question) && normalize(prompt) !== normalize(command)) {
      detailsText = prompt;
    }
    if (detailsText && normalize(detailsText) !== normalize(question)) {
      lines.push(truncateLine(`   ${color("Reason:", "2;37")} ${detailsText}`, width));
    }
    const enterDecision = this.approvalDefaultYes ? "allow once" : "deny";
    lines.push(truncateLine(`   ${color("y", "1;32")} allow once   ${color("n", "1;31")} deny   ${color("enter", "1;33")} ${enterDecision}`, width));
    lines.push(truncateLine(`   ${color("r", "1;36")} remember command   ${color("a", "1;33")} allow all`, width));
    return lines;
  }

  withTimelineSpacing(lines) {
    const items = Array.isArray(lines) ? lines : [];
    if (items.length === 0) return [];
    const previous = this.timeline.length > 0 ? this.timeline[this.timeline.length - 1] : "";
    return normalizeTimelineSpacing(previous ? [previous, ...items] : items).slice(previous ? 1 : 0);
  }

  getWrappedSourceLines(source, width, cache, wrapLine) {
    const lines = Array.isArray(source) ? source : [];
    const targetWidth = Math.max(1, Number(width) || 1);
    if (
      cache &&
      cache.source === lines &&
      cache.length === lines.length &&
      cache.width === targetWidth &&
      Array.isArray(cache.lines)
    ) {
      return cache.lines;
    }
    // ponytail: per-line memo keyed by content — appending one timeline line
    // used to re-measure ANSI/emoji widths for the whole history every render.
    let memo = cache?.memo;
    if (!memo || cache.memoWidth !== targetWidth) memo = new Map();
    if (memo.size > lines.length * 4 + 500) memo.clear();
    const wrapped = [];
    for (const line of lines) {
      let chunks = memo.get(line);
      if (!chunks) {
        chunks = wrapLine(line, targetWidth);
        memo.set(line, Array.isArray(chunks) ? chunks : []);
        chunks = memo.get(line);
      }
      if (chunks.length > 0) wrapped.push(...chunks);
    }
    if (cache) {
      cache.memo = memo;
      cache.memoWidth = targetWidth;
      cache.source = lines;
      cache.length = lines.length;
      cache.width = targetWidth;
      cache.lines = wrapped;
    }
    return wrapped;
  }

  getWrappedTimelineLines(width) {
    return this.getWrappedSourceLines(this.timeline, width, this.wrappedTimelineCache, wrapTimelineLine);
  }

  getWrappedLogLines(width) {
    return this.getWrappedSourceLines(this.logs, width, this.wrappedLogsCache, wrapText);
  }

  setTimelineLines(lines = []) {
    const next = Array.isArray(lines) ? lines.map((line) => String(line || "")) : [];
    this.timeline = next.slice(Math.max(0, next.length - this.maxTimeline));
    this.scrollOffset = 0;
    this.render();
  }

  restoreSessionTimeline(items = [], { maxItems = this.maxTimeline } = {}) {
    const source = Array.isArray(items) ? items : [];
    const cap = Math.max(1, Number(maxItems) || this.maxTimeline || 2000);
    const restored = [];
    const pushLines = (lines) => {
      const items = Array.isArray(lines) ? lines : [];
      if (items.length === 0) return;
      const previous = restored.length > 0 ? restored[restored.length - 1] : "";
      const formatted = normalizeTimelineSpacing(previous ? [previous, ...items] : items).slice(previous ? 1 : 0);
      for (const line of formatted) restored.push(line);
      if (restored.length > cap) restored.splice(0, restored.length - cap);
    };

    for (const item of source.slice(Math.max(0, source.length - cap))) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.line === "string") {
        pushLines(this.formatTimelineLines(item.line));
        continue;
      }
      const type = String(item.type || "message");
      if (type === "message") {
        const role = String(item.role || "assistant").toLowerCase();
        const content = String(item.content || "").trim();
        if (!content) continue;
        if (role === "user") pushLines(this.formatTimelineLines(`[task] ${content}`));
        else if (role === "assistant") pushLines(this.formatTimelineLines(`[response] ${content}`));
        else pushLines(this.formatTimelineLines(`[result] ${content}`));
        continue;
      }
      if (type === "tool") {
        const title = String(item.title || item.tool || "tool").trim();
        const input = item.input && typeof item.input === "object"
          ? (item.input.path || item.input.query || item.input.pattern || item.input.command || "")
          : "";
        pushLines(this.formatTimelineLines(`[tool] ${title}${input ? ` (${input})` : ""}`));
        if (item.output || item.error) pushLines(this.formatTimelineLines(`[tool-result] ${String(item.error || item.output || "")}`));
        continue;
      }
      if (type === "progress") {
        pushLines(this.formatTimelineLines(`[progress] ${item.content || item.title || ""}`));
        continue;
      }
      const content = String(item.content || item.title || "").trim();
      if (content) pushLines(this.formatTimelineLines(content));
    }

    this.timeline = restored.slice(Math.max(0, restored.length - this.maxTimeline));
    this.scrollOffset = 0;
    this.render();
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
      return items.map((item, index) => (index === 0 ? `${prefix}${item}` : `    ${item}`));
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
    const compactToolDetail = (tool, details = "", maxLen = 96) => {
      const name = String(tool || "");
      const raw = String(details || "").trim().replace(/^\((.*)\)$/, "$1").trim();
      if (!raw) return "";
      if (this.showRawLogs || /^\[trace\]/i.test(raw)) return trimWorkspaceText(raw, maxLen).text.replace(/\n/g, " ");
      const fromJson = (source) => {
        try {
          const parsed = JSON.parse(source);
          if (!parsed || typeof parsed !== "object") return "";
          if (name === "read_files" && Array.isArray(parsed.paths)) {
            const shown = parsed.paths.slice(0, 3).map((item) => String(item || "").trim()).filter(Boolean).join(", ");
            return shown ? `${shown}${parsed.paths.length > 3 ? ` +${parsed.paths.length - 3}` : ""}` : "";
          }
          if (name === "rg" || name === "grep" || name === "search_files") {
            const pattern = parsed.pattern || parsed.regex || parsed.query || "";
            const scope = parsed.path || parsed.glob || parsed.file_pattern || "";
            return `${pattern}${scope ? ` in ${scope}` : ""}`.trim();
          }
          return parsed.path || parsed.query || parsed.pattern || parsed.command || "";
        } catch {
          return "";
        }
      };
      const jsonDetail = raw.startsWith("{") ? fromJson(raw) : "";
      if (jsonDetail) return trimWorkspaceText(jsonDetail, maxLen).text.replace(/\n/g, " ");
      const pairs = {};
      for (const match of raw.matchAll(/([a-zA-Z0-9_.-]+)=("[^"]*"|'[^']*'|\[[^\]]*\]|\{[^}]*\}|\S+)/g)) {
        let value = match[2];
        try {
          value = JSON.parse(value);
        } catch {
          value = String(value).replace(/^['"]|['"]$/g, "");
        }
        pairs[match[1]] = value;
      }
      if (Object.keys(pairs).length > 0) {
        if (Array.isArray(pairs.paths)) {
          const shown = pairs.paths.slice(0, 3).map((item) => String(item || "").trim()).filter(Boolean).join(", ");
          return trimWorkspaceText(shown ? `${shown}${pairs.paths.length > 3 ? ` +${pairs.paths.length - 3}` : ""}` : "", maxLen).text;
        }
        if (name === "rg" || name === "grep" || name === "search_files") {
          const pattern = pairs.pattern || pairs.regex || pairs.query || "";
          const scope = pairs.path || pairs.glob || pairs.file_pattern || "";
          return trimWorkspaceText(`${pattern}${scope ? ` in ${scope}` : ""}`.trim(), maxLen).text;
        }
        return trimWorkspaceText(String(pairs.path || pairs.query || pairs.pattern || pairs.command || ""), maxLen).text;
      }
      return trimWorkspaceText(raw.replace(/\s+/g, " "), maxLen).text;
    };
    const toolDisplayName = (tool) => {
      const name = String(tool || "tool");
      switch (name) {
        case "read_file":
          return "Read";
        case "read_files":
          return "Read files";
        case "list_files":
          return "List";
        case "glob_files":
          return "Glob";
        case "find_files":
          return "Find";
        case "rg":
        case "grep":
        case "search_files":
          return "Search";
        case "web_search":
        case "search_web":
          return "Web search";
        case "subagent":
          return "Subagent";
        case "collaborate":
          return "Agents";
        case "git_status":
          return "Git status";
        case "git_diff":
          return "Git diff";
        case "run_tests":
          return "Test";
        case "edit_file":
          return "Edit";
        case "write_file":
          return "Write";
        case "apply_patch":
          return "Patch";
        case "replace_in_files":
          return "Replace";
        default:
          return name;
      }
    };
    const toolLabel = (tool, details = "") => {
      const name = String(tool || "tool");
      const detail = compactToolDetail(name, details);
      const suffix = detail ? ` ${detail}` : "";
      return `${color(toolDisplayName(name), "36")}${suffix}`;
    };
    const summarizeToolBatch = (text) => {
      const body = String(text || "").trim();
      if (!body) return [];
      if (this.showRawLogs) return [trimWorkspaceText(body, 420).text.replace(/\n/g, " ")];
      const match = body.match(/^([a-zA-Z0-9_.-]+)\s+x(\d+)\b/i);
      if (match) {
        const detailSource = body.split(/\s+-\s+/).slice(1).join(" - ").trim();
        const names = [];
        for (const item of detailSource.split(";")) {
          const value = item.trim().match(/^[a-zA-Z0-9_.-]+\((.*)\)$/)?.[1]?.trim();
          if (value) names.push(value);
        }
        const header = `${toolDisplayName(match[1])} x${match[2]}`;
        if (names.length === 0) return [header];
        const shown = names.slice(0, 6);
        const more = names.length > shown.length ? [`... ${names.length - shown.length} more`] : [];
        return [header, ...shown, ...more];
      }
      const first = body.split(/\s+-\s+/, 1)[0]?.trim();
      return [trimWorkspaceText(first || body, 120).text.replace(/\n/g, " ")];
    };
    const summarizeToolResult = (text) => {
      const body = String(text || "").replace(/\r/g, "").trim();
      if (!body) return [];
      const compactOutputLines = (source, { maxLines = 12 } = {}) => {
        const lines = String(source || "")
          .replace(/\r/g, "")
          .split("\n")
          .map((part) => part.trimEnd())
          .filter((part) => part.trim());
        if (lines.length <= maxLines) return lines;
        return [
          ...lines.slice(0, maxLines),
          `... ${lines.length - maxLines} more output lines`,
        ];
      };
      if (this.showRawLogs) {
        return compactOutputLines(body, { maxLines: 8 });
      }
      const savedMatch = body.match(/Result too long \(chars:\s*([0-9]+)\), saved to\s+(\S+)/i);
      if (savedMatch) return [`Output saved (${savedMatch[1]} chars) · ${savedMatch[2]}`];
      const exitMatch = body.match(/\bexit_code:\s*(-?\d+)/i);
      if (exitMatch && Number(exitMatch[1]) !== 0) {
        const lines = body.split("\n").map((part) => part.trim()).filter(Boolean);
        const detail = lines.find((part) => !/^command:|^exit_code:|^stdout:|^stderr:/i.test(part));
        return [`Command failed (exit ${exitMatch[1]})${detail ? ` · ${trimWorkspaceText(detail, 140).text}` : ""}`];
      }
      const diffStat = body.match(/\b\d+\s+files?\s+changed\b[^\n]*/i)?.[0]
        || body.match(/\b\d+\s+insertions?\(\+\).*?\d+\s+deletions?\(-\)/i)?.[0];
      if (/^diff --git\b|^# (?:Staged|Unstaged|Untracked) changes\b/im.test(body)) {
        return renderDiffLines(body, { maxLines: 80 });
      }
      if (diffStat) return [diffStat];
      const lines = body.split("\n").map((part) => part.trim()).filter(Boolean);
      if (lines.length === 1 && lines[0].length <= 120 && !/^command:|^exit_code:|^stdout:|^stderr:/i.test(lines[0])) {
        return [lines[0]];
      }
      return compactOutputLines(body);
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
      const textWidth = Math.max(8, width - stringDisplayWidth(` ${this.symbols.prompt}  `));
      const taskLines = wrapText(line.slice(7).trim(), textWidth);
      const renderedTaskLines = taskLines.map((taskLine, index) => {
        const prefix = index === 0 ? `${this.symbols.prompt} ` : "  ";
        return colorFullLine(` ${prefix}${taskLine} `, "1;37;48;5;236", width);
      });
      return ["", ...renderedTaskLines, ""];
    }
    if (line.startsWith("[model] ")) {
      return [];
    }
    if (line.startsWith("[plan]")) {
      return [];
    }
    if (line.startsWith("[thinking] ")) {
      // Raw request/response payload traces are noisy; the visible thinking row
      // is driven by [progress] entries and the transient spinner/status line.
      return [];
    }
    if (line.startsWith("[thought] ")) {
      const body = trimWorkspaceText(line.slice(10).trim(), 800).text;
      if (!body) return [];
      return timelineItem(this.symbols.response, body, "1;35");
    }
    if (line.startsWith("[progress] ")) {
      const body = trimWorkspaceText(line.slice(11).trim(), 800).text;
      if (!body) return [];
      return timelineItem(this.symbols.response, body, "1;35");
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
      const body = `${color(run.label || "Tool", "36")}${safeDisplay ? ` ${safeDisplay}` : ""}${tag ? ` ${tag}` : ""}`;
      return timelineItem(this.symbols.tool, body, "2;37");
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
      return timelineItem(this.symbols.tool, toolLabel(match?.[1] || body, match?.[2] || ""), "2;37");
    }
    if (line.startsWith("[tools] ")) {
      const body = line.slice(8).trim();
      const summary = summarizeToolBatch(body);
      if (summary.length === 0) return [];
      return timelineBlock(
        this.symbols.tool,
        summary.map((item, index) =>
          index === 0
            ? color(item, "36")
            : item
        ),
        "2;37"
      );
    }
    if (line.startsWith("[agent] ")) {
      return timelineItem(this.symbols.agent, `${color("Agent", "1;35")} ${trimWorkspaceText(line.slice(8).trim(), 600).text}`, "1;35");
    }
    if (line.startsWith("[goal] ")) {
      const body = line.slice(7).trim();
      const statusMatch = body.match(/^status=([a-z]+)\s+turn=(\d+\/\d+)/i);
      if (statusMatch) {
        if (this.isTerminalGoalStatus(statusMatch[1])) return [];
        return timelineItem(
          this.symbols.task,
          `${color("Goal", "1;36")} ${this.formatGoalDisplayStatus(statusMatch[1])} ${color(statusMatch[2], "2;37")}`,
          "1;36"
        );
      }
      const started = body.match(/^loop started\s+\(max\s+(\d+)\s+turns?\)/i);
      if (started) {
        return timelineItem(this.symbols.task, `${color("Goal loop started", "1;36")} ${color(`max ${started[1]} turns`, "2;37")}`, "1;36");
      }
      return timelineItem(this.symbols.task, `${color("Goal", "1;36")} ${color(trimWorkspaceText(body, 600).text, "2;37")}`, "1;36");
    }
    if (line.startsWith("[response] ")) {
      const text = trimWorkspaceText(line.slice(11).trim(), 8000).text;
      if (!text) return responseBlock(this.symbols.response, "<empty>");
      const markdownWidth = Math.max(20, (this.out?.columns || 100) - 8);
      const chunks = renderMarkdownLines(text, { maxTableWidth: markdownWidth }).filter((chunk) => chunk !== undefined);
      if (chunks.length === 0) return responseBlock(this.symbols.response, "<empty>");
      return responseBlock(this.symbols.response, chunks, "1;32");
    }
    if (line.startsWith("[result] ")) {
      const body = line.slice(9).trim();
      const lower = body.toLowerCase();
      const failed = /\b(fail(?:ed|ure)?|error|aborted|denied|timeout|timed out)\b/.test(lower);
      const ok = !failed && /\b(done|ok|success|succeeded|completed)\b/.test(lower);
      const iconColor = failed ? "1;31" : ok ? "1;32" : "2;37";
      return timelineItem(failed ? this.symbols.fail : ok ? this.symbols.ok : this.symbols.response, color(body, "2;37"), iconColor);
    }
    if (line.startsWith("[tool-result] ")) {
      const rendered = summarizeToolResult(line.slice(14).trimEnd());
      if (rendered.length === 0) return [];
      return timelineBlock(
        this.symbols.result,
        rendered.map((part) => (ANSI_PATTERN.test(String(part || "")) ? String(part || "") : color(String(part || ""), "2;37"))),
        "2;37"
      );
    }
    if (line.startsWith("[help] ")) {
      const body = line.slice(7).trim();
      if (!body) return [];
      if (body.startsWith("title:")) {
        const title = body.slice(6).trim();
        return timelineItem(this.symbols.subheading, color(title, "1;37"), "1;37");
      }
      if (body.startsWith("section:")) {
        const section = body.slice(8).trim();
        return section ? [`  ${color(section, "1;36")}`] : [];
      }
      if (body.startsWith("item:")) {
        const item = body.slice(5).trim();
        const [command, ...descriptionParts] = item.split(/\s+-\s+/);
        const description = descriptionParts.join(" - ").trim();
        return [
          `  ${color(command.trim(), "1;32")}${description ? ` ${color(`- ${description}`, "2;37")}` : ""}`,
        ];
      }
      if (body.startsWith("tip:")) {
        const tip = body.slice(4).trim();
        return tip ? [`  ${color(`tip: ${tip}`, "2;36")}`] : [];
      }
      return [`  ${color(body, "2;37")}`];
    }
    if (line.startsWith("[banner-1] ")) {
      let text = line.slice(11);
      if (text.includes(" Pie Code")) {
        text = text.replace(" Pie Code", color(" Pie Code", "1;30;42") + "\x1b[1;82m");
      }
      return [color(text, "1;82")];
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

  getModelStatusParts() {
    const raw = String(this.modelName || this.providerLabel?.() || "").trim();
    if (!raw) return { model: "unknown", thinkingEffort: "default" };
    const model = raw.match(/^([^()]+)\s*(?:\(|$)/)?.[1]?.trim() || raw;
    const thinkingEffort = raw.match(/(?:^|[,\s])think:([^,)\s]+)/i)?.[1]?.trim() || "default";
    return { model, thinkingEffort };
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
    const todoDoneCount = this.todos.filter((t) => String(t?.status || "").toLowerCase() === "completed").length;
    const todoSummary =
      this.todos.length > 0 && todoDoneCount < this.todos.length
        ? ` | TODO(${todoDoneCount}/${this.todos.length})`
        : "";
    const modelStatus = this.getModelStatusParts();
    const text = ` model: ${modelStatus.model} | think: ${modelStatus.thinkingEffort} | state: ${state} | last: ${time} | tool: ${tool}${ctx}${todoSummary}${phase}`;
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

  formatOverlayModeLabel() {
    const mode = String(this.overlayMode || "").trim();
    if (!mode) return "";
    if (mode === "llm-debug") return "LLM debug";
    if (mode === "help") return "Help";
    return mode.replace(/[-_]+/g, " ");
  }

  render(input = this.currentInput, status = "", cursorIndex = null) {
    if (!this.active) return;
    this.currentInput = String(input || "");
    const statusText = String(status || "").trim();
    if (statusText) this.lastStatus = statusText;

    const termWidth = Math.max(40, this.out.columns || 100);
    const width = Math.max(20, termWidth - 1);
    const height = Math.max(8, this.out.rows || 30);

    if (this.overlayVisible) {
      const sep = separatorLine(width, this.unicodeSymbols);
      const title = truncateLine(` ${this.overlayTitle}`, width);
      const fallbackHint = this.overlayMode === "llm-debug"
        ? " /:search  ctrl-n/p: section  j/k: scroll  J/K: req/resp  g: section end  ctrl-f/b: page  q: close "
        : " /:search  j/k: scroll  J/K: req/resp  g: section end  ctrl-f/b: page  q: close ";
      const hintText = this.overlaySearchActive
        ? ` /${this.overlaySearchQuery}  (enter: jump, esc: cancel, backspace: edit)`
        : this.overlayHint || fallbackHint;
      const hint = truncateLine(hintText, width);
      const { wrapped, sectionOffsets } = this.buildOverlayLayout(width);
      const viewport = Math.max(4, height - 4);
      const maxStart = Math.max(0, wrapped.length - viewport);
      this.overlayScroll = Math.max(0, Math.min(this.overlayScroll, maxStart));
      const visible = wrapped
        .slice(this.overlayScroll, this.overlayScroll + viewport)
        .map((line) => highlightOverlaySectionLine(line));
      const sections = Array.isArray(sectionOffsets) ? sectionOffsets : [];
      const visibleEndOffset = this.overlayScroll + Math.max(0, visible.length - 1);
      const activeSection = [...sections].reverse().find((section) => section.offset >= this.overlayScroll && section.offset <= visibleEndOffset) || [...sections].reverse().find((section) => section.offset <= this.overlayScroll) || sections[0] || null;
      this.overlaySectionOffsets = sections;
      this.overlayActiveSection = activeSection?.label || "";
      const sectionLabel = activeSection ? `section:${activeSection.label}` : "";
      const sectionNav = sections.length > 0 ? `sections:${sections.map((section) => section.label).join(",")}` : "";
      const modeLabel = this.formatOverlayModeLabel();
      const aboveBelow = joinStatusParts([
        this.overlayScroll > 0 ? "above" : "",
        this.overlayScroll < maxStart ? "below" : "",
      ]);
      const scrollLabel = joinStatusParts([
        modeLabel,
        sectionLabel,
        `lines ${Math.min(wrapped.length, this.overlayScroll + 1)}-${Math.min(wrapped.length, this.overlayScroll + visible.length)}/${wrapped.length}`,
        aboveBelow ? `more:${aboveBelow}` : "",
        sectionNav,
      ]);
      const statusLine = truncateLine(scrollLabel, width);
      const frameLines = [sep, `\x1b[1m${title}\x1b[0m`, sep, ...visible, sep, `\x1b[2m${statusLine}\x1b[0m`, `\x1b[2m${hint}\x1b[0m`];
      const frame = renderFrameLines(frameLines, width, height);
      this.lastFrameLineCount = frameLines.length;
      this.lastInputRow = 1;
      this.lastInputLine = "";
      if (this.layout) {
        this.layout.render({
          mode: "rawFrame",
          frameLines,
          cursorRow: 1,
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
    const suppressBottomHints = this.commandSuggestionsVisible;
    const startupHintLines = !suppressBottomHints && this.startupShortcutHint ? 1 : 0;
    const hintLines = !suppressBottomHints && this.inputHint ? 1 : 0;
    const rawGoalContextLine = this.formatGoalContextLine(width);
    const rawTaskContextLine = rawGoalContextLine ? "" : this.formatTaskContextLine(width);
    const runningLines = this.thinking ? 1 : 0;
    const inputState = this.buildInputState(this.currentInput, bottomWidth, cursorIndex);
    const inputLineCount = Math.max(1, inputState.lines.length);
    const bottomLines = inputLineCount + 2 + commandSuggestionLines + modelSuggestionLines + startupHintLines + hintLines; // input + separator + status/hints
    const baseReservedLines =
      headerLines +
      todoBlockLines +
      approvalLines +
      clarificationLines +
      runningLines +
      bottomLines;
    const sourceLines = this.showRawLogs ? this.getWrappedLogLines(width) : this.getWrappedTimelineLines(width);
    const goalContextLine = rawGoalContextLine;
    const selectLogWindow = (extraReservedLines = 0) => {
      // Keep layout in natural flow (not sticky), but adapt visible workspace
      // lines to the actual terminal space left after input/status blocks.
      const viewportLogBudget = Math.max(1, height - baseReservedLines - extraReservedLines);
      const maxLogLines = Math.max(1, Math.min(Math.max(1, sourceLines.length || 1), viewportLogBudget));
      const maxScroll = Math.max(0, sourceLines.length - maxLogLines);
      const scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);
      const start = Math.max(0, sourceLines.length - maxLogLines - scrollOffset);
      const visibleLogs = sourceLines.slice(start, start + maxLogLines);
      return {
        maxLogLines,
        maxScroll,
        scrollOffset,
        visibleLogs,
        visibleStart: sourceLines.length === 0 ? 0 : start + 1,
        visibleEnd: Math.min(sourceLines.length, start + visibleLogs.length),
      };
    };
    let taskContextLine = "";
    let logWindow = selectLogWindow(goalContextLine ? 2 : 0);
    if (!goalContextLine && rawTaskContextLine && !this.visibleTimelineHasCurrentTask(logWindow.visibleLogs)) {
      taskContextLine = rawTaskContextLine;
      logWindow = selectLogWindow(2);
    }
    this.lastScrollMax = logWindow.maxScroll;
    this.lastScrollSourceLength = sourceLines.length;
    this.scrollOffset = logWindow.scrollOffset;
    const { visibleLogs, visibleStart, visibleEnd, maxLogLines } = logWindow;
    const viewName = this.showRawLogs ? "raw" : "timeline";
    const scrollLabel = this.scrollOffset > 0
      ? ` | ${viewName}:${visibleStart}-${visibleEnd}/${sourceLines.length}`
      : sourceLines.length > maxLogLines
        ? ` | ${viewName}:bottom ${visibleEnd}/${sourceLines.length}`
        : "";
    const ctxStatus =
      this.contextLimit > 0
        ? `ctx:${formatCompactNumber(this.contextUsed)}/${formatCompactNumber(this.contextLimit)}(${Math.min(999, Math.round((this.contextUsed / this.contextLimit) * 100))}%)`
        : "";
    const modelStatus = this.getModelStatusParts();
    const modelLabel = `model:${modelStatus.model}`;
    const thinkingEffortStatus = `think:${modelStatus.thinkingEffort}`;
    const todoDone = this.todos.filter((t) => String(t?.status || "").toLowerCase() === "completed").length;
    const todoStatus = this.todos.length > 0 && todoDone < this.todos.length ? `TODO(${todoDone}/${this.todos.length})` : "";
    const planStatus = this.planModeEnabled ? "plan:on" : "";
    const bashMode = /^\s*!/.test(this.currentInput) ? "mode:bash" : "";
    const approvalLabel = typeof this.getApprovalLabel === "function" ? String(this.getApprovalLabel() || "").trim() : "";
    const approvalStatus = approvalLabel ? `approve:${approvalLabel}` : "";
    const verboseStatus = joinStatusParts([
      ctxStatus,
      scrollLabel ? scrollLabel.replace(/^\s*\|\s*/, "") : "",
      modelLabel,
      thinkingEffortStatus,
      planStatus,
      approvalStatus,
      todoStatus,
      bashMode,
    ]);
    const compactStatus = joinStatusParts([
      ctxStatus,
      modelStatus.model,
      thinkingEffortStatus,
      todoStatus,
      this.planModeEnabled ? "plan" : "",
      approvalLabel === "on" ? "approve:on" : "",
      /^\s*!/.test(this.currentInput) ? "bash" : "",
      this.scrollOffset > 0 ? scrollLabel.replace(/^\s*\|\s*/, "") : "",
    ]);
    const promptStatusRaw = termWidth <= 72 ? compactStatus : verboseStatus;
    const leftStatusLabel = this.formatTransientStatusLabel() || this.formatProjectInstructionsLabel();
    let promptStatus = "";
    if (leftStatusLabel) {
      const left = truncateLine(` ${leftStatusLabel}`, width);
      const fixedLeft = stringDisplayWidth(left);
      const rightBudget = Math.max(0, bottomWidth - fixedLeft - 1);
      const right = truncateLine(promptStatusRaw, rightBudget);
      const pad = Math.max(1, bottomWidth - fixedLeft - stringDisplayWidth(right));
      promptStatus = `${left}${" ".repeat(pad)}${right}`;
    } else {
      const raw = promptStatusRaw;
      const rawWithPinnedPrefix = raw;
      promptStatus =
        stringDisplayWidth(rawWithPinnedPrefix) >= bottomWidth
          ? truncateLine(raw, bottomWidth)
          : `${" ".repeat(Math.max(0, bottomWidth - stringDisplayWidth(rawWithPinnedPrefix)))}${rawWithPinnedPrefix}`;
    }
    const attentionSep = colorFullLine(" ! action needed ", "1;30;43", width);
    const approvalBlock = this.approvalPrompt ? [attentionSep, ...approvalContentLines] : [];
    const clarificationBlock = this.clarificationPrompt ? [attentionSep, ...clarificationContentLines] : [];
    const contextLine = goalContextLine || taskContextLine;
    const contextBlock = contextLine ? ["", contextLine] : [];
    const thinkingColors = ["82", "118", "154", "190", "201"];
    const thinkingColor = thinkingColors[this.thinkingTick % thinkingColors.length];
    const spinFrames = this.unicodeSymbols ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
    const spin = spinFrames[this.thinkingTick % spinFrames.length];
    const thought = String(this.thoughtStreamText || "").trim();
    const liveThought = thought.replace(/^Thinking:\s*/i, "").replace(/^Working\.{0,3}$/i, "");
    const thoughtSuffix = liveThought ? ` · ${truncateLine(liveThought, Math.max(20, width - 46))}` : "";
    const activitySuffix = this.formatElapsedSinceLastActivity();
    const runningLine = ` ${spin} Working · ${this.formatElapsedSinceTurnStart()}${activitySuffix}${thoughtSuffix}`;
    const runningBlock = this.thinking ? [color(truncateLine(runningLine, bottomWidth), `1;${thinkingColor}`)] : [];
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
    const hasWorkspaceContentBeforeRunning =
      Boolean(errorLine) ||
      visibleLogs.length > 0 ||
      todoLinesBlock.length > 0 ||
      approvalBlock.length > 0 ||
      clarificationBlock.length > 0 ||
      contextBlock.length > 0 ||
      thoughtStreamBlock.length > 0;
    const hasWorkspaceContent = hasWorkspaceContentBeforeRunning || runningBlock.length > 0;

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
          truncateLine(` ${color("Enter switch | Tab/Up/Down select | Esc cancel", "2;37")}`, bottomWidth),
          ...(modelSuggestionViewport && modelSuggestionViewport.hiddenAbove > 0
            ? [truncateLine(` ${color(`... ${modelSuggestionViewport.hiddenAbove} above`, "2;37")}`, bottomWidth)]
            : []),
          ...(() => {
            const items = modelSuggestionViewport?.items || [];
            // Align the dimmed metadata column across the visible rows.
            const idColumn = items.reduce((max, id) => Math.max(max, String(id).length), 0);
            return items.map((modelId, offset) => {
              const absoluteIndex = (modelSuggestionViewport?.start || 0) + offset;
              const selected = absoluteIndex === this.modelSuggestionIndex;
              const meta = this.getModelSuggestionMeta(modelId);
              const padded = meta ? String(modelId).padEnd(idColumn) : String(modelId);
              const label = selected ? color(`> ${padded}`, "1;32") : color(`  ${padded}`, "2;37");
              const suffix = meta ? color(`  ${meta}`, "2;90") : "";
              return truncateLine(` ${label}${suffix}`, bottomWidth);
            });
          })(),
          ...(modelSuggestionViewport && modelSuggestionViewport.hiddenBelow > 0
            ? [truncateLine(` ${color(`... ${modelSuggestionViewport.hiddenBelow} below`, "2;37")}`, bottomWidth)]
            : []),
        ]
      : [];

    const nonAttentionWorkspaceHasContent =
      Boolean(errorLine) ||
      visibleLogs.length > 0 ||
      todoLinesBlock.length > 0 ||
      contextBlock.length > 0 ||
      thoughtStreamBlock.length > 0;
    const workspaceLinesWithoutAttention = [
      ...(errorLine ? [`\x1b[31m${errorLine}\x1b[0m`] : []),
      ...visibleLogs,
      ...todoLinesBlock,
      ...contextBlock,
      ...thoughtStreamBlock,
      ...(runningBlock.length > 0 && nonAttentionWorkspaceHasContent ? [""] : []),
      ...runningBlock,
      ...(runningBlock.length === 0 && nonAttentionWorkspaceHasContent ? [""] : []),
    ];
    const beforeInputLines = [
      ...(errorLine ? [`\x1b[31m${errorLine}\x1b[0m`] : []),
      ...visibleLogs,
      ...todoLinesBlock,
      ...approvalBlock,
      ...clarificationBlock,
      ...contextBlock,
      ...thoughtStreamBlock,
      ...(runningBlock.length > 0 && hasWorkspaceContentBeforeRunning ? [""] : []),
      ...runningBlock,
      ...(runningBlock.length === 0 && hasWorkspaceContent ? [""] : []),
      sep,
    ];
    const frameLines = [
      ...beforeInputLines,
      ...inputState.lines.map((line) => `\x1b[1m${line}\x1b[0m`),
      ...commandSuggestionBlock,
      ...modelSuggestionBlock,
      sep,
      `\x1b[2m${promptStatus}\x1b[0m`,
      ...(!suppressBottomHints && this.startupShortcutHint ? [`\x1b[2m${truncateLine(` ${this.startupShortcutHint}`, bottomWidth)}\x1b[0m`] : []),
      ...(!suppressBottomHints && this.inputHint ? [`\x1b[2m${truncateLine(` ${this.inputHint}`, bottomWidth)}\x1b[0m`] : []),
    ];

    const frame = renderFrameLines(frameLines, width, height);
    this.lastFrameLineCount = frameLines.length;
    this.lastInputRow = Math.max(1, beforeInputLines.length + 1);
    this.lastInputLine = inputState.lines.join("\n");
    const cursorRow = Math.max(1, Math.min(height, this.lastInputRow + Math.max(0, inputState.cursorRowOffset)));
    if (this.layout) {
      const attentionLines = [
        ...approvalBlock,
        ...clarificationBlock,
      ].filter((line) => String(line || "").trim());
      const inputComposite = [
        ...inputState.lines.map((line) => line),
        ...commandSuggestionBlock,
        ...modelSuggestionBlock,
      ];
      this.layout.render({
        frameLines,
        cursorRow,
        workspaceLines: workspaceLinesWithoutAttention,
        attentionLines,
        inputLines: inputComposite,
        statusLine: promptStatus,
        separatorGlyph: this.unicodeSymbols ? "─" : "-",
        hintLine: [
          !suppressBottomHints && this.startupShortcutHint ? truncateLine(` ${this.startupShortcutHint}`, bottomWidth) : "",
          !suppressBottomHints && this.inputHint ? truncateLine(` ${this.inputHint}`, bottomWidth) : "",
        ].filter(Boolean).join("\n"),
        cursorRowOffset: Math.max(0, inputState.cursorRowOffset),
        cursorCol: inputState.cursorCol,
      });
      return;
    }
    this.out.write(TERMINAL_PAINT_PREFIX + terminalFrame(frame) + `\x1b[${cursorRow};${inputState.cursorCol}H\x1b[?25h`);
  }
}

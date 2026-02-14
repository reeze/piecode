const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strikethrough: "\x1b[9m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgGray: "\x1b[48;5;236m",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateLine(line, maxLen = 120) {
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 3)}...`;
}

class Spinner {
  constructor() {
    this.index = 0;
    this.timer = null;
    this.message = "";
    this.active = false;
    this.isTTY = Boolean(process.stdout.isTTY);
  }

  start(message) {
    this.stop("");
    this.message = message;
    this.active = true;
    this.index = 0;
    if (this.isTTY) {
      this._render();
      this.timer = setInterval(() => this._render(), 80);
    }
  }

  _render() {
    if (!this.active) return;
    const frame = SPINNER_FRAMES[this.index % SPINNER_FRAMES.length];
    this.index += 1;
    process.stdout.write(
      `\r\x1b[2K  ${COLORS.yellow}${frame}${COLORS.reset} ${this.message}`
    );
  }

  stop(finalMessage) {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      process.stdout.write(`\r\x1b[2K`);
    }
    if (finalMessage) {
      process.stdout.write(`${finalMessage}\n`);
    }
  }
}

function c(color, text) {
  if (!process.stdout.isTTY) return text;
  return `${color}${text}${COLORS.reset}`;
}

// ── Markdown rendering ──────────────────────────────────────────────

const KEYWORD_SETS = {
  js: new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "new", "this", "class",
    "extends", "import", "export", "from", "default", "try", "catch",
    "finally", "throw", "async", "await", "yield", "typeof", "instanceof",
    "in", "of", "delete", "void", "true", "false", "null", "undefined",
  ]),
  py: new Set([
    "def", "class", "return", "if", "elif", "else", "for", "while", "try",
    "except", "finally", "raise", "import", "from", "as", "with", "yield",
    "lambda", "pass", "break", "continue", "and", "or", "not", "is", "in",
    "True", "False", "None", "self", "async", "await",
  ]),
  sh: new Set([
    "if", "then", "else", "elif", "fi", "for", "do", "done", "while",
    "until", "case", "esac", "function", "return", "exit", "echo", "export",
    "local", "readonly", "set", "unset", "true", "false",
  ]),
  go: new Set([
    "func", "return", "if", "else", "for", "range", "switch", "case",
    "break", "continue", "go", "defer", "select", "chan", "map", "struct",
    "interface", "package", "import", "const", "var", "type", "true", "false",
    "nil",
  ]),
  rs: new Set([
    "fn", "let", "mut", "const", "if", "else", "for", "while", "loop",
    "match", "return", "break", "continue", "struct", "enum", "impl",
    "trait", "pub", "use", "mod", "self", "super", "crate", "async",
    "await", "true", "false", "Some", "None", "Ok", "Err",
  ]),
};

// Map common lang identifiers to keyword sets
const LANG_ALIAS = {
  javascript: "js", js: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js",
  python: "py", py: "py",
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh",
  go: "go", golang: "go",
  rust: "rs", rs: "rs",
};

function highlightCode(code, lang) {
  if (!process.stdout.isTTY) return code;
  const key = LANG_ALIAS[String(lang || "").toLowerCase()];
  const keywords = key ? KEYWORD_SETS[key] : null;

  return code.split("\n").map((line) => {
    // Comments: // or # (single-line)
    const commentSingle = line.match(/^(\s*)(\/\/.*|#.*)$/);
    if (commentSingle) {
      return `${commentSingle[1]}${COLORS.gray}${commentSingle[2]}${COLORS.reset}`;
    }

    let result = line;

    // Strings: "..." or '...' or `...` (simple, non-greedy)
    result = result.replace(
      /(["'`])(?:(?!\1|\\).|\\.)*?\1/g,
      (m) => `${COLORS.green}${m}${COLORS.reset}`
    );

    // Numbers
    result = result.replace(
      /\b(\d+(?:\.\d+)?)\b/g,
      (m) => `${COLORS.yellow}${m}${COLORS.reset}`
    );

    // Keywords
    if (keywords) {
      result = result.replace(
        /\b([A-Za-z_]\w*)\b/g,
        (m) => keywords.has(m) ? `${COLORS.magenta}${m}${COLORS.reset}` : m
      );
    }

    return result;
  }).join("\n");
}

function renderMarkdown(text) {
  if (!process.stdout.isTTY) return text;

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang ... ```
    const fenceMatch = line.match(/^(\s*)```(\w*)\s*$/);
    if (fenceMatch) {
      const indent = fenceMatch[1];
      const lang = fenceMatch[2];
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].match(/^\s*```\s*$/)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```

      const langLabel = lang ? ` ${lang} ` : "";
      const termWidth = process.stdout.columns || 80;
      const barWidth = Math.max(20, Math.min(termWidth - 4, 76));
      const topBar = `${indent}  ${COLORS.dim}${langLabel}${"─".repeat(Math.max(0, barWidth - langLabel.length))}${COLORS.reset}`;
      const botBar = `${indent}  ${COLORS.dim}${"─".repeat(barWidth)}${COLORS.reset}`;

      out.push(topBar);
      const highlighted = highlightCode(codeLines.join("\n"), lang);
      for (const cl of highlighted.split("\n")) {
        out.push(`${indent}  ${COLORS.bgGray} ${cl} ${COLORS.reset}`);
      }
      out.push(botBar);
      continue;
    }

    // Headers: # ## ### etc.
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = renderInlineMarkdown(headerMatch[2]);
      if (level <= 2) {
        out.push(`${COLORS.bold}${COLORS.cyan}${content}${COLORS.reset}`);
      } else {
        out.push(`${COLORS.bold}${content}${COLORS.reset}`);
      }
      i += 1;
      continue;
    }

    // Horizontal rule: --- or ***
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      const termWidth = process.stdout.columns || 80;
      out.push(c(COLORS.dim, "─".repeat(Math.min(termWidth - 2, 60))));
      i += 1;
      continue;
    }

    // Unordered list: - or * or + items
    const ulMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const content = renderInlineMarkdown(ulMatch[3]);
      out.push(`${indent}${c(COLORS.dim, "•")} ${content}`);
      i += 1;
      continue;
    }

    // Ordered list: 1. 2. etc.
    const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (olMatch) {
      const indent = olMatch[1];
      const num = olMatch[2];
      const content = renderInlineMarkdown(olMatch[3]);
      out.push(`${indent}${c(COLORS.dim, `${num}.`)} ${content}`);
      i += 1;
      continue;
    }

    // Blockquote: > text
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      const content = renderInlineMarkdown(bqMatch[1]);
      out.push(`${c(COLORS.dim, "│")} ${c(COLORS.italic, content)}`);
      i += 1;
      continue;
    }

    // Regular line with inline formatting
    out.push(renderInlineMarkdown(line));
    i += 1;
  }

  return out.join("\n");
}

function renderInlineMarkdown(line) {
  if (!process.stdout.isTTY) return line;

  let result = line;

  // Bold + italic: ***text*** or ___text___
  result = result.replace(
    /(\*\*\*|___)(?!\s)(.+?)(?<!\s)\1/g,
    (_m, _d, content) => `${COLORS.bold}${COLORS.italic}${content}${COLORS.reset}`
  );

  // Bold: **text** or __text__
  result = result.replace(
    /(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g,
    (_m, _d, content) => `${COLORS.bold}${content}${COLORS.reset}`
  );

  // Italic: *text* or _text_ (but not mid-word underscores)
  result = result.replace(
    /(?<![\\*\w])(\*|_)(?!\s)(.+?)(?<!\s)\1(?![*\w])/g,
    (_m, _d, content) => `${COLORS.italic}${content}${COLORS.reset}`
  );

  // Strikethrough: ~~text~~
  result = result.replace(
    /~~(?!\s)(.+?)(?<!\s)~~/g,
    (_m, content) => `${COLORS.strikethrough}${COLORS.dim}${content}${COLORS.reset}`
  );

  // Inline code: `code`
  result = result.replace(
    /`([^`]+)`/g,
    (_m, content) => `${COLORS.bgGray}${COLORS.cyan} ${content} ${COLORS.reset}`
  );

  // Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => `${COLORS.underline}${COLORS.blue}${text}${COLORS.reset}${COLORS.dim} (${url})${COLORS.reset}`
  );

  return result;
}

export class Display {
  constructor() {
    this.spinner = new Spinner();
    this.currentToolStart = null;
    this.lastSuggestionLine = "";
  }

  showSuggestions(suggestions) {
    if (!process.stdout.isTTY || suggestions.length === 0) return;
    const line = suggestions.map((s) => c(COLORS.dim, s)).join("  ");
    // Overwrite previous suggestion line if it exists
    if (this.lastSuggestionLine) {
      process.stdout.write(`\r\x1b[2K`);
    }
    this.lastSuggestionLine = line;
    process.stdout.write(`\r\x1b[2K${c(COLORS.dim, "  ")}${line}`);
  }

  clearSuggestions() {
    if (this.lastSuggestionLine) {
      process.stdout.write(`\r\x1b[2K`);
      this.lastSuggestionLine = "";
    }
  }

  onThinking(stage) {
    const label =
      stage === "planning"
        ? "Planning..."
        : stage === "replanning"
          ? "Replanning..."
          : "Thinking...";
    this.spinner.start(c(COLORS.dim, label));
  }

  onThinkingDone() {
    if (this.spinner.active) {
      this.spinner.stop("");
    }
  }

  onToolUse(tool, input, reason) {
    this.onThinkingDone();
    const header = this._formatToolHeader(tool, input);
    process.stdout.write(`\n  ${c(COLORS.cyan, header)}\n`);
    if (reason) {
      process.stdout.write(`  ${c(COLORS.dim, reason)}\n`);
    }
  }

  onToolStart(tool, input) {
    this.currentToolStart = Date.now();
    const label = this._formatRunLabel(tool, input);
    this.spinner.start(c(COLORS.dim, label));
  }

  onToolEnd(tool, result, error) {
    const elapsed = this.currentToolStart ? Date.now() - this.currentToolStart : 0;
    this.currentToolStart = null;
    const dur = c(COLORS.dim, `(${formatDuration(elapsed)})`);

    if (error) {
      this.spinner.stop(`  ${c(COLORS.red, "✗")} Error ${dur}`);
      const lines = String(error).split("\n").slice(0, 3);
      for (const line of lines) {
        process.stdout.write(`    ${c(COLORS.red, truncateLine(line))}\n`);
      }
    } else {
      this.spinner.stop(`  ${c(COLORS.green, "✓")} Done ${dur}`);
      const preview = this._formatResult(tool, result);
      if (preview) {
        process.stdout.write(`${preview}\n`);
      }
    }
  }

  onPlan(plan) {
    this.onThinkingDone();
    if (plan.summary) {
      process.stdout.write(`\n  ${c(COLORS.magenta, "Plan:")} ${plan.summary}\n`);
    }
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    for (const step of steps) {
      process.stdout.write(`  ${c(COLORS.dim, `- ${step}`)}\n`);
    }
  }

  onThought(content) {
    this.onThinkingDone();
    process.stdout.write(`  ${c(COLORS.dim, content)}\n`);
  }

  onResponse(text) {
    this.onThinkingDone();
    process.stdout.write(`\n${renderMarkdown(text)}\n`);
  }

  onError(message) {
    this.onThinkingDone();
    process.stdout.write(`\n${c(COLORS.red, `Error: ${message}`)}\n`);
  }

  _formatToolHeader(tool, input) {
    switch (tool) {
      case "shell":
        return `> Bash: ${truncateLine(String(input?.command || "command"), 100)}`;
      case "read_file":
        return `> Read ${input?.path || "file"}`;
      case "read_files":
        return `> Read ${Array.isArray(input?.paths) ? input.paths.length : 0} files`;
      case "write_file":
        return `> Write ${input?.path || "file"}`;
      case "edit_file":
        return `> Edit ${input?.path || "file"}`;
      case "apply_patch":
        return `> Patch ${input?.path || "file"}`;
      case "replace_in_files":
        return `> Replace in files (${input?.file_pattern || "**/*"})`;
      case "list_files":
        return `> List ${input?.path || "."}`;
      case "glob_files":
        return `> Glob ${input?.pattern || "**/*"}`;
      case "find_files":
        return `> Find "${input?.query || ""}"`;
      case "git_status":
        return "> Git status";
      case "git_diff":
        return `> Git diff ${input?.path || ""}`.trim();
      case "run_tests":
        return `> Test ${input?.command || "npm test"}`;
      case "todo_write":
      case "todowrite":
        return "> Update Todos";
      default:
        return `> ${tool}`;
    }
  }

  _formatRunLabel(tool, input) {
    switch (tool) {
      case "shell":
        return "Running...";
      case "read_file":
        return `Reading ${input?.path || ""}...`;
      case "read_files":
        return "Reading files...";
      case "write_file":
        return `Writing ${input?.path || ""}...`;
      case "edit_file":
        return `Editing ${input?.path || ""}...`;
      case "apply_patch":
        return `Patching ${input?.path || ""}...`;
      case "replace_in_files":
        return "Replacing in files...";
      case "list_files":
        return `Listing ${input?.path || "."}...`;
      case "glob_files":
      case "find_files":
        return "Scanning files...";
      case "git_status":
      case "git_diff":
        return "Inspecting git state...";
      case "run_tests":
        return "Running tests...";
      case "todo_write":
      case "todowrite":
        return "Updating todos...";
      default:
        return `Executing ${tool}...`;
    }
  }

  _formatResult(tool, result) {
    const text = String(result || "");
    if (!text || text === "<empty>") return "";

    const dim = (s) => c(COLORS.dim, s);

    switch (tool) {
      case "shell": {
        const lines = text.split("\n").filter(Boolean);
        const preview = lines.slice(0, 5).map((l) => `    ${dim(truncateLine(l))}`);
        if (lines.length > 5) {
          preview.push(`    ${dim(`... (${lines.length - 5} more lines)`)}`);
        }
        return preview.join("\n");
      }
      case "read_file": {
        const lineCount = text.split("\n").length;
        return `    ${dim(`${lineCount} lines`)}`;
      }
      case "edit_file": {
        try {
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object") return `    ${dim(text)}`;
          const out = [];
          const message = String(parsed.message || "").trim();
          if (message) out.push(`    ${dim(message)}`);
          const diffStat = String(parsed?.details?.diffStat || "").trim();
          if (diffStat) out.push(`    ${dim(diffStat)}`);
          if (parsed?.details?.diffTruncated) {
            out.push(`    ${dim("Diff truncated for display.")}`);
          }
          const diffText = String(parsed?.details?.diff || "").trim();
          if (diffText) {
            const lines = diffText.split("\n");
            const preview = lines.slice(0, 40).map((line) => `    ${dim(truncateLine(line, 160))}`);
            out.push(...preview);
            if (lines.length > 40) {
              out.push(`    ${dim(`... (${lines.length - 40} more lines)`)}`);
            }
          }
          return out.join("\n");
        } catch {
          return `    ${dim(text)}`;
        }
      }
      case "read_files":
      case "apply_patch":
      case "replace_in_files":
      case "write_file":
      case "git_status":
      case "git_diff":
      case "run_tests":
        return `    ${dim(text)}`;
      case "list_files": {
        const entries = text.split("\n").filter(Boolean);
        const preview = entries.slice(0, 8).map((l) => `    ${dim(l)}`);
        if (entries.length > 8) {
          preview.push(`    ${dim(`... (${entries.length - 8} more)`)}`);
        }
        return preview.join("\n");
      }
      case "glob_files":
      case "find_files": {
        const entries = text.split("\n").filter(Boolean);
        const preview = entries.slice(0, 12).map((l) => `    ${dim(l)}`);
        if (entries.length > 12) {
          preview.push(`    ${dim(`... (${entries.length - 12} more)`)}`);
        }
        return preview.join("\n");
      }
      default:
        return "";
    }
  }
}

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
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

export class Display {
  constructor() {
    this.spinner = new Spinner();
    this.currentToolStart = null;
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
    process.stdout.write(`\n${text}\n`);
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
      case "write_file":
        return `> Write ${input?.path || "file"}`;
      case "list_files":
        return `> List ${input?.path || "."}`;
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
      case "write_file":
        return `Writing ${input?.path || ""}...`;
      case "list_files":
        return `Listing ${input?.path || "."}...`;
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
      case "write_file":
        return `    ${dim(text)}`;
      case "list_files": {
        const entries = text.split("\n").filter(Boolean);
        const preview = entries.slice(0, 8).map((l) => `    ${dim(l)}`);
        if (entries.length > 8) {
          preview.push(`    ${dim(`... (${entries.length - 8} more)`)}`);
        }
        return preview.join("\n");
      }
      default:
        return "";
    }
  }
}

import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);
const SHELL_INLINE_MAX_CHARS = 12000;
const SHELL_PREVIEW_CHARS = 1800;

const SAFE_COMMANDS = new Set([
  "ls",
  "pwd",
  "cat",
  "echo",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "rg",
  "grep",
  "find",
  "git",
  "node",
  "npm",
  "pnpm",
  "bun",
  "sed",
  "awk",
  "tr",
  "xargs",
  "basename",
  "dirname",
  "realpath",
  "stat",
  "du",
  "df",
  "ps",
  "which",
  "type",
  "env",
  "printenv",
  "date",
  "uname",
  "id",
  "whoami",
  "jq",
  "nl",
  "file",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
  "diff",
  "comm",
  "paste",
  "column",
  "strings",
]);

const DANGEROUS_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "chmod",
  "chown",
  "sudo",
  "kill",
  "killall",
  "dd",
  "mkfs",
  "fdisk",
  "shutdown",
  "reboot",
  "launchctl",
]);

function tokenizeCommandSegments(command) {
  return String(command || "")
    .split(/&&|\|\||\||;|\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractCommandName(segment) {
  const cleaned = segment
    .replace(/^[({\[]+/, "")
    .replace(/^time\s+/, "")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[idx])) {
    idx += 1;
  }

  if (idx < tokens.length && (tokens[idx] === "command" || tokens[idx] === "builtin" || tokens[idx] === "nohup")) {
    idx += 1;
  }

  if (idx < tokens.length && tokens[idx] === "env") {
    idx += 1;
    while (idx < tokens.length && (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[idx]))) {
      idx += 1;
    }
  }

  const first = tokens[idx] || "";
  return first.replace(/^["']|["']$/g, "").toLowerCase();
}

function classifyShellCommand(command) {
  const raw = String(command || "");
  if (!raw.trim()) {
    return { level: "dangerous", reason: "empty command is invalid" };
  }

  // Allow benign null-device redirection like `2>/dev/null` or `>/dev/null`.
  const withoutNullRedirects = raw.replace(/\s*\d?>\s*\/dev\/null\b/g, "");
  if (
    /[`]/.test(withoutNullRedirects) ||
    /\$\(/.test(withoutNullRedirects) ||
    /(^|[^<])>(?!>)/.test(withoutNullRedirects) ||
    />>|<</.test(withoutNullRedirects)
  ) {
    return { level: "dangerous", reason: "contains shell substitution or redirection" };
  }

  const segments = tokenizeCommandSegments(raw);
  const names = segments.map(extractCommandName).filter(Boolean);
  if (names.length === 0) {
    return { level: "dangerous", reason: "unable to parse command name" };
  }

  if (names.some((name) => DANGEROUS_COMMANDS.has(name))) {
    return { level: "dangerous", reason: "contains potentially destructive command" };
  }

  if (names.every((name) => SAFE_COMMANDS.has(name))) {
    return { level: "safe", reason: "all command segments are in safe allowlist" };
  }

  return { level: "unclassified", reason: "command is neither known safe nor explicitly dangerous" };
}

function resolveInsideRoot(root, candidatePath) {
  const resolved = path.resolve(root, candidatePath || ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${candidatePath}`);
  }
  return resolved;
}

function normalizeTodoItems(items) {
  const allowed = new Set(["pending", "in_progress", "completed"]);
  if (!Array.isArray(items)) return [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw || typeof raw !== "object") continue;
    const content = String(raw.content || "").trim();
    if (!content) continue;
    const statusRaw = String(raw.status || "pending").toLowerCase();
    const status = allowed.has(statusRaw) ? statusRaw : "pending";
    const id = String(raw.id || `todo-${i + 1}`);
    out.push({ id, content, status });
  }
  return out;
}

function truncatePreview(text, maxChars) {
  const source = String(text || "");
  if (source.length <= maxChars) return source;
  return `${source.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function formatShellResult({
  workspaceDir,
  command,
  stdout,
  stderr,
  maxInlineChars = SHELL_INLINE_MAX_CHARS,
  previewChars = SHELL_PREVIEW_CHARS,
}) {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const limited = combined.slice(0, maxInlineChars);
  const truncated = combined.length > maxInlineChars;
  const hint = truncated
    ? `\n\n[Output truncated: ${combined.length} chars total; use head/tail/wc to explore]`
    : "";

  const preview = truncatePreview(limited, previewChars);
  return `Command: ${command}\nOutput:\n${preview}${hint}`;
}

async function hasCommand(cmd) {
  try {
    await exec(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

export function createToolset({
  workspaceDir,
  autoApproveRef,
  askApproval,
  onToolStart,
  onTodoWrite,
}) {
  let lastTodoSignature = "";

  const runShell = async ({ command } = {}) => {
    onToolStart?.("shell", { command });
    const cmd = String(command || "").trim();
    if (!cmd) {
      throw new Error("Empty command");
    }
    const classification = classifyShellCommand(cmd);

    if (classification.level === "dangerous") {
      throw new Error(
        `Dangerous command blocked (${classification.reason}): ${cmd}`
      );
    }

    let approved = autoApproveRef?.value ?? false;
    if (!approved && askApproval) {
      approved = await askApproval("shell", { command: cmd, classification });
    }
    if (!approved) {
      throw new Error("User did not approve command");
    }

    const { stdout, stderr } = await exec(cmd, {
      cwd: workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return formatShellResult({ workspaceDir, command: cmd, stdout, stderr });
  };

  const readFile = async ({ path: relPath } = {}) => {
    onToolStart?.("read_file", { path: relPath });
    const abs = resolveInsideRoot(workspaceDir, relPath);
    const content = await fs.readFile(abs, "utf8");
    return content;
  };

  const writeFile = async ({ path: relPath, content } = {}) => {
    onToolStart?.("write_file", { path: relPath });
    const abs = resolveInsideRoot(workspaceDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `Wrote ${content.length} bytes to ${relPath}`;
  };

  const listFiles = async ({ path: relPath = ".", max_entries: maxEntries = 200 } = {}) => {
    onToolStart?.("list_files", { path: relPath, max_entries: maxEntries });
    const abs = resolveInsideRoot(workspaceDir, relPath);
    const cap = Math.min(Math.max(Number(maxEntries) || 200, 1), 2000);
    const out = [];

    async function walk(dir) {
      if (out.length >= cap) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= cap) return;
        const full = path.join(dir, entry.name);
        const rel = path.relative(workspaceDir, full) || ".";
        out.push(entry.isDirectory() ? `${rel}/` : rel);
        if (entry.isDirectory()) {
          await walk(full);
        }
      }
    }

    await walk(abs);
    return out.join("\n");
  };

  const todoWrite = async ({ todos } = {}) => {
    onToolStart?.("todo_write", { todos });
    const normalized = normalizeTodoItems(todos);
    if (normalized.length === 0) {
      return "No valid todos were provided. Expected: { todos: [{ id?, content, status: pending|in_progress|completed }] }";
    }
    const signature = JSON.stringify(normalized);
    if (signature === lastTodoSignature) {
      return "No-op: todo list unchanged.";
    }
    lastTodoSignature = signature;
    onTodoWrite?.(normalized);
    const summary = normalized.map((t) => `- [${t.status}] ${t.content}`).join("\n");
    return `Updated ${normalized.length} todos:\n${summary}`;
  };

  // Search files using ripgrep, grep, or native implementation
  const searchFiles = async ({
    path: searchPath = ".",
    regex,
    file_pattern: filePattern,
    max_results: maxResults = 50,
    case_sensitive: caseSensitive = false,
  } = {}) => {
    onToolStart?.("search_files", {
      path: searchPath,
      regex,
      file_pattern: filePattern,
      max_results: maxResults,
      case_sensitive: caseSensitive,
    });

    if (!regex || typeof regex !== "string") {
      throw new Error("Missing required parameter: regex (search pattern)");
    }

    const absPath = resolveInsideRoot(workspaceDir, searchPath);
    const limit = Math.min(Math.max(Number(maxResults) || 50, 1), 200);

    // Try ripgrep first (fastest)
    if (await hasCommand("rg")) {
      return searchWithRipgrep({
        workspaceDir,
        absPath,
        regex,
        filePattern,
        limit,
        caseSensitive,
      });
    }

    // Fall back to grep
    if (await hasCommand("grep")) {
      return searchWithGrep({
        workspaceDir,
        absPath,
        regex,
        filePattern,
        limit,
        caseSensitive,
      });
    }

    // Last resort: native JavaScript implementation
    return searchNative({
      workspaceDir,
      absPath,
      regex,
      filePattern,
      limit,
      caseSensitive,
    });
  };

  return {
    shell: runShell,
    read_file: readFile,
    write_file: writeFile,
    list_files: listFiles,
    todo_write: todoWrite,
    todowrite: todoWrite,
    search_files: searchFiles,
  };
}

async function searchWithRipgrep({
  workspaceDir,
  absPath,
  regex,
  filePattern,
  limit,
  caseSensitive,
}) {
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--with-filename",
    "--max-count", String(Math.min(limit, 1000)),
    "--max-depth", "20",
    "-C", "2", // 2 lines of context
  ];

  if (!caseSensitive) {
    args.push("-i");
  }

  if (filePattern) {
    args.push("-g", filePattern);
  }

  // Exclude common non-source directories
  args.push(
    "-g", "!node_modules",
    "-g", "!.git",
    "-g", "!dist",
    "-g", "!build",
    "-g", "!.next",
    "-g", "!coverage",
    "-g", "!.cache"
  );

  args.push(regex);
  args.push(absPath);

  try {
    const { stdout, stderr } = await exec(`rg ${args.map(a => `"${a}"`).join(" ")}`, {
      cwd: workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
    });

    const results = parseSearchResults(stdout, workspaceDir);
    return formatSearchResults(results, limit, regex);
  } catch (error) {
    if (error.code === 1 && !error.stdout) {
      // ripgrep returns 1 when no matches found
      return `No matches found for pattern: ${regex}`;
    }
    throw new Error(`Search failed: ${error.message}`);
  }
}

async function searchWithGrep({
  workspaceDir,
  absPath,
  regex,
  filePattern,
  limit,
  caseSensitive,
}) {
  const grepArgs = [
    "-r",
    "-n",
    "-H",
    "-C", "2", // 2 lines of context
  ];

  if (!caseSensitive) {
    grepArgs.push("-i");
  }

  if (filePattern) {
    grepArgs.push("--include", filePattern);
  }

  // Exclude common non-source directories
  grepArgs.push(
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.next",
    "--exclude-dir=coverage"
  );

  // Escape regex for grep
  const escapedRegex = regex.replace(/"/g, '\\"');
  grepArgs.push(escapedRegex);
  grepArgs.push(absPath);

  try {
    const { stdout, stderr } = await exec(`grep ${grepArgs.map(a => `"${a}"`).join(" ")}`, {
      cwd: workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
    });

    const results = parseSearchResults(stdout, workspaceDir);
    return formatSearchResults(results, limit, regex);
  } catch (error) {
    if (error.code === 1 && !error.stdout) {
      // grep returns 1 when no matches found
      return `No matches found for pattern: ${regex}`;
    }
    throw new Error(`Search failed: ${error.message}`);
  }
}

async function searchNative({
  workspaceDir,
  absPath,
  regex,
  filePattern,
  limit,
  caseSensitive,
}) {
  const results = [];
  const flags = caseSensitive ? "" : "i";
  const pattern = new RegExp(regex, flags);

  const globPattern = filePattern || "*";
  const isMatch = (filename) => {
    if (!filePattern) return true;
    // Simple glob matching
    const regexPattern = filePattern
      .replace(/\./g, "\\.")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(regexPattern).test(filename);
  };

  async function walk(dir) {
    if (results.length >= limit) return;

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= limit) return;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(workspaceDir, fullPath);

      // Skip common non-source directories
      if (entry.isDirectory()) {
        const skipDirs = ["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"];
        if (skipDirs.includes(entry.name)) continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!isMatch(entry.name)) continue;

      try {
        const content = await fs.readFile(fullPath, "utf8");
        const lines = content.split("\n");

        lines.forEach((line, index) => {
          if (results.length >= limit) return;

          if (pattern.test(line)) {
            const contextBefore = lines.slice(Math.max(0, index - 2), index);
            const contextAfter = lines.slice(index + 1, Math.min(lines.length, index + 3));

            results.push({
              file: relPath,
              line: index + 1,
              column: line.search(pattern) + 1,
              match: line.trim(),
              contextBefore,
              contextAfter,
            });
          }
        });
      } catch (error) {
        // Skip files that can't be read as text (binary files)
      }
    }
  }

  await walk(absPath);
  return formatSearchResults(results, limit, regex);
}

function parseSearchResults(stdout, workspaceDir) {
  const results = [];
  const lines = stdout.split("\n").filter(Boolean);

  let currentResult = null;

  for (const line of lines) {
    // Parse ripgrep/grep output format: file:line:column:content
    // or with context: file-line-content
    const match = line.match(/^([^:]+):(\d+):(?:(\d+):)?(.*)$/);

    if (match) {
      const [, file, lineNum, col, content] = match;
      const isContextLine = line.startsWith("--");

      if (!isContextLine && content) {
        if (currentResult) {
          results.push(currentResult);
        }
        currentResult = {
          file: file.replace(workspaceDir + "/", "").replace(workspaceDir, "."),
          line: parseInt(lineNum, 10),
          column: col ? parseInt(col, 10) : 1,
          match: content,
          contextBefore: [],
          contextAfter: [],
        };
      } else if (currentResult) {
        // Context line
        if (parseInt(lineNum, 10) < currentResult.line) {
          currentResult.contextBefore.push(content);
        } else {
          currentResult.contextAfter.push(content);
        }
      }
    }
  }

  if (currentResult) {
    results.push(currentResult);
  }

  return results;
}

function formatSearchResults(results, limit, regex) {
  if (results.length === 0) {
    return `No matches found for pattern: ${regex}`;
  }

  let output = `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${regex}"`;
  if (results.length >= limit) {
    output += " (showing first " + limit + ")";
  }
  output += "\n" + "=".repeat(60) + "\n";

  results.forEach((result, index) => {
    output += `\n${index + 1}. ${result.file}:${result.line}:${result.column}\n`;

    // Print context before
    result.contextBefore?.forEach((ctx) => {
      output += `   ${ctx}\n`;
    });

    // Print match with highlighting
    output += `>  ${result.match}\n`;

    // Print context after
    result.contextAfter?.forEach((ctx) => {
      output += `   ${ctx}\n`;
    });
  });

  return output;
}

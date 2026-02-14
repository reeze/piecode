import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);
const SHELL_INLINE_MAX_CHARS = 12000;
const SHELL_PREVIEW_CHARS = 1800;
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);

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

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "grep",
  "remote",
]);

const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "merge",
  "rebase",
  "reset",
  "restore",
  "checkout",
  "switch",
  "clean",
  "cherry-pick",
  "revert",
  "stash",
  "tag",
  "branch",
  "pull",
  "push",
  "fetch",
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

function stripOuterQuotes(token) {
  return String(token || "").replace(/^["']|["']$/g, "");
}

function extractCommandDescriptor(segment) {
  const cleaned = segment
    .replace(/^[({\[]+/, "")
    .replace(/^time\s+/, "")
    .trim();
  if (!cleaned) return { name: "", args: [] };
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { name: "", args: [] };

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

  const first = stripOuterQuotes(tokens[idx] || "").toLowerCase();
  if (!first) return { name: "", args: [] };
  return {
    name: first,
    args: tokens.slice(idx + 1),
  };
}

function classifyGitSubcommand(args) {
  let idx = 0;
  while (idx < args.length) {
    const token = stripOuterQuotes(args[idx]);
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "-c") {
      idx += 2;
      continue;
    }
    if (token.startsWith("-")) {
      idx += 1;
      continue;
    }
    const subcommand = token.toLowerCase();
    if (DANGEROUS_GIT_SUBCOMMANDS.has(subcommand)) {
      return { level: "dangerous", reason: `git ${subcommand} may modify repository state` };
    }
    if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      return { level: "safe", reason: `git ${subcommand} is read-only` };
    }
    return { level: "unclassified", reason: "command is neither known safe nor explicitly dangerous" };
  }
  return { level: "unclassified", reason: "command is neither known safe nor explicitly dangerous" };
}

export function classifyShellCommand(command) {
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
  const descriptors = segments.map(extractCommandDescriptor).filter((part) => part.name);
  if (descriptors.length === 0) {
    return { level: "dangerous", reason: "unable to parse command name" };
  }

  let hasUnclassified = false;

  for (const descriptor of descriptors) {
    if (DANGEROUS_COMMANDS.has(descriptor.name)) {
      return { level: "dangerous", reason: "contains potentially destructive command" };
    }
    if (descriptor.name === "git") {
      const gitClassification = classifyGitSubcommand(descriptor.args);
      if (gitClassification.level === "dangerous") return gitClassification;
      if (gitClassification.level === "unclassified") hasUnclassified = true;
      continue;
    }
    if (!SAFE_COMMANDS.has(descriptor.name)) {
      hasUnclassified = true;
    }
  }

  if (!hasUnclassified) {
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
  exitCode,
  stdout,
  stderr,
  maxInlineChars = SHELL_INLINE_MAX_CHARS,
  previewChars = SHELL_PREVIEW_CHARS,
}) {
  const rendered = [
    `command: ${command}`,
    `exit_code: ${Number.isFinite(exitCode) ? exitCode : 1}`,
    "stdout:",
    String(stdout || ""),
    "stderr:",
    String(stderr || ""),
  ].join("\n");

  if (rendered.length <= maxInlineChars) return rendered;

  const shellDir = path.join(workspaceDir, ".piecode", "shell");
  await fs.mkdir(shellDir, { recursive: true });
  const fileName = `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const absPath = path.join(shellDir, fileName);
  await fs.writeFile(absPath, rendered, "utf8");
  const relPath = path.relative(workspaceDir, absPath).split(path.sep).join("/");
  const preview = truncatePreview([stdout, stderr].filter(Boolean).join("\n"), previewChars);
  return `Result too long (chars: ${rendered.length}), saved to ${relPath}\nexit_code: ${
    Number.isFinite(exitCode) ? exitCode : 1
  }\nPreview:\n${preview}`;
}

function normalizeRelPathForMatch(relPath) {
  return String(relPath || "").split(path.sep).join("/");
}

function globToRegExp(pattern) {
  const source = normalizeRelPathForMatch(String(pattern || "**/*").trim() || "**/*");
  let out = "^";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$+?.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

async function walkWorkspaceFiles({
  workspaceDir,
  startAbsPath,
  includeHidden = false,
  maxResults = 500,
  onFile,
}) {
  let count = 0;
  async function walk(dir) {
    if (count >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= maxResults) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = normalizeRelPathForMatch(path.relative(workspaceDir, fullPath));
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      await onFile({ fullPath, relPath });
    }
  }
  await walk(startAbsPath);
}

function countStringMatches(source, needle, caseSensitive = true) {
  if (!needle) return 0;
  const haystack = caseSensitive ? source : source.toLowerCase();
  const token = caseSensitive ? needle : needle.toLowerCase();
  let idx = 0;
  let count = 0;
  while (true) {
    idx = haystack.indexOf(token, idx);
    if (idx === -1) break;
    count += 1;
    idx += Math.max(1, token.length);
  }
  return count;
}

function isStdioMaxBufferError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return (
    code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxBuffer/i.test(message) ||
    /stdout maxBuffer length exceeded/i.test(message)
  );
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
  mcpHub = null,
}) {
  let lastTodoSignature = "";
  const mcpAvailable = () => Boolean(mcpHub && typeof mcpHub.hasServers === "function" && mcpHub.hasServers());

  const ensureMcp = () => {
    if (!mcpAvailable()) {
      throw new Error("MCP is not configured. Add mcpServers in ~/.piecode/settings.json");
    }
  };

  const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

  const formatStructuredResult = (value, maxChars = 12000) => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
  };

  const formatMcpToolCallResult = ({ server, tool, result }) => {
    const payload = asObject(result);
    const content = Array.isArray(payload.content) ? payload.content : [];
    const textParts = content
      .map((item) => {
        if (item && typeof item === "object" && item.type === "text") return String(item.text || "");
        return "";
      })
      .map((part) => part.trim())
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join("\n");
    return formatStructuredResult({
      server,
      tool,
      result: payload,
    });
  };

  const approveShellCommand = async (cmd) => {
    const classification = classifyShellCommand(cmd);
    const alwaysNeedsPrompt = classification.level === "dangerous";
    let approved = classification.level === "safe";
    if (!approved) {
      if (alwaysNeedsPrompt) {
        approved = askApproval ? await askApproval("shell", { command: cmd, classification }) : false;
      } else {
        approved = Boolean(autoApproveRef?.value);
        if (!approved && askApproval) {
          approved = await askApproval("shell", { command: cmd, classification });
        }
      }
    }
    return { approved, classification };
  };

  const executeShellCommand = async ({ cmd, timeoutMs = null }) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const result = await exec(cmd, {
        cwd: workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      });
      stdout = result.stdout || "";
      stderr = result.stderr || "";
    } catch (error) {
      if (error && typeof error === "object") {
        stdout = String(error.stdout || "");
        stderr = String(error.stderr || error.message || "");
        if (typeof error.code === "number" && Number.isFinite(error.code)) {
          exitCode = error.code;
        } else {
          exitCode = 1;
        }
      } else {
        throw error;
      }
    }
    return { stdout, stderr, exitCode };
  };

  const runShell = async ({ command, timeout } = {}) => {
    onToolStart?.("shell", { command });
    const cmd = String(command || "").trim();
    if (!cmd) {
      throw new Error("Empty command");
    }
    const { approved } = await approveShellCommand(cmd);
    if (!approved) {
      return "Command was not approved by the user.";
    }

    const shellTimeout = Number(timeout);
    const { stdout, stderr, exitCode } = await executeShellCommand({
      cmd,
      timeoutMs: Number.isFinite(shellTimeout) && shellTimeout > 0 ? shellTimeout : null,
    });
    return formatShellResult({ workspaceDir, command: cmd, exitCode, stdout, stderr });
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

  const listFiles = async ({
    path: relPath = ".",
    max_entries: maxEntries = 200,
    include_hidden: includeHidden = false,
    include_ignored: includeIgnored = false,
  } = {}) => {
    onToolStart?.("list_files", {
      path: relPath,
      max_entries: maxEntries,
      include_hidden: includeHidden,
      include_ignored: includeIgnored,
    });
    const abs = resolveInsideRoot(workspaceDir, relPath);
    const cap = Math.min(Math.max(Number(maxEntries) || 200, 1), 2000);
    const out = [];

    async function walk(dir) {
      if (out.length >= cap) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= cap) return;
        if (!includeIgnored && IGNORE_DIRS.has(entry.name)) continue;
        if (!includeHidden && entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(workspaceDir, full) || ".";
        out.push(entry.isDirectory() ? `${rel}/` : rel);
        if (entry.isDirectory()) {
          await walk(full);
        }
      }
    }

    // If user explicitly points to a hidden/ignored directory, allow listing its children.
    if (relPath && relPath !== ".") {
      const baseName = path.basename(String(relPath));
      if (baseName.startsWith(".")) includeHidden = true;
      if (IGNORE_DIRS.has(baseName)) includeIgnored = true;
    }
    await walk(abs);
    return out.join("\n");
  };

  const readFiles = async ({
    paths,
    max_chars_per_file: maxCharsPerFile = 4000,
    max_total_chars: maxTotalChars = 24000,
  } = {}) => {
    onToolStart?.("read_files", {
      paths,
      max_chars_per_file: maxCharsPerFile,
      max_total_chars: maxTotalChars,
    });
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("Missing required parameter: paths (non-empty array)");
    }
    const cap = Math.min(Math.max(Number(maxCharsPerFile) || 4000, 200), 200000);
    const totalCap = Math.min(Math.max(Number(maxTotalChars) || 24000, 500), 1000000);
    const results = [];
    let totalChars = 0;
    let skipped = 0;
    for (const rawPath of paths.slice(0, 50)) {
      const relPath = String(rawPath || "").trim();
      if (!relPath) continue;
      if (totalChars >= totalCap) {
        skipped += 1;
        continue;
      }
      try {
        const abs = resolveInsideRoot(workspaceDir, relPath);
        const content = await fs.readFile(abs, "utf8");
        const remaining = Math.max(0, totalCap - totalChars);
        const effectiveCap = Math.max(200, Math.min(cap, remaining));
        const truncated = content.length > effectiveCap;
        const returned = truncated ? `${content.slice(0, effectiveCap)}\n...[truncated]` : content;
        totalChars += returned.length;
        results.push({
          path: relPath,
          chars: content.length,
          truncated,
          content: returned,
        });
      } catch (error) {
        results.push({
          path: relPath,
          error: String(error?.message || "failed to read file"),
        });
      }
    }
    return formatStructuredResult({
      files: results,
      total_chars: totalChars,
      capped: totalChars >= totalCap,
      skipped_due_to_total_cap: skipped,
    });
  };

  const globFiles = async ({
    path: relPath = ".",
    pattern = "**/*",
    max_results: maxResults = 200,
    include_hidden: includeHidden = false,
  } = {}) => {
    onToolStart?.("glob_files", {
      path: relPath,
      pattern,
      max_results: maxResults,
      include_hidden: includeHidden,
    });
    const abs = resolveInsideRoot(workspaceDir, relPath);
    const limit = Math.min(Math.max(Number(maxResults) || 200, 1), 2000);
    const matcher = globToRegExp(String(pattern || "**/*"));
    const out = [];
    await walkWorkspaceFiles({
      workspaceDir,
      startAbsPath: abs,
      includeHidden: Boolean(includeHidden),
      maxResults: Math.max(1000, limit * 5),
      onFile: async ({ fullPath, relPath: candidate }) => {
        const target = normalizeRelPathForMatch(path.relative(abs, fullPath));
        if (matcher.test(target)) out.push(candidate);
      },
    });
    out.sort((a, b) => a.localeCompare(b));
    if (out.length === 0) return `No files matched pattern: ${pattern}`;
    return out.slice(0, limit).join("\n");
  };

  const findFiles = async ({
    path: relPath = ".",
    query,
    max_results: maxResults = 200,
    include_hidden: includeHidden = false,
  } = {}) => {
    onToolStart?.("find_files", {
      path: relPath,
      query,
      max_results: maxResults,
      include_hidden: includeHidden,
    });
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) throw new Error("Missing required parameter: query");
    const abs = resolveInsideRoot(workspaceDir, relPath);
    const limit = Math.min(Math.max(Number(maxResults) || 200, 1), 2000);
    const out = [];
    await walkWorkspaceFiles({
      workspaceDir,
      startAbsPath: abs,
      includeHidden: Boolean(includeHidden),
      maxResults: Math.max(1000, limit * 5),
      onFile: async ({ relPath: candidate }) => {
        if (candidate.toLowerCase().includes(needle)) out.push(candidate);
      },
    });
    out.sort((a, b) => a.localeCompare(b));
    if (out.length === 0) return `No files matched query: ${query}`;
    return out.slice(0, limit).join("\n");
  };

  const applyPatch = async ({
    path: relPath,
    find,
    replace = "",
    all = false,
    dry_run: dryRun = false,
    edits = null,
  } = {}) => {
    onToolStart?.("apply_patch", { path: relPath, all, dry_run: dryRun, edits });
    const normalizedPath = String(relPath || "").trim();
    if (!normalizedPath) throw new Error("Missing required parameter: path");
    const abs = resolveInsideRoot(workspaceDir, normalizedPath);
    const fileContent = await fs.readFile(abs, "utf8");

    const editOps = Array.isArray(edits)
      ? edits
      : [{ find, replace, all }];
    if (!Array.isArray(editOps) || editOps.length === 0) {
      throw new Error("Missing patch edits. Provide find/replace or edits[]");
    }

    let next = fileContent;
    let totalReplacements = 0;
    for (const rawEdit of editOps.slice(0, 200)) {
      const needle = String(rawEdit?.find ?? "").trim();
      const replacement = String(rawEdit?.replace ?? "");
      const replaceAll = Boolean(rawEdit?.all);
      if (!needle) throw new Error("Invalid patch edit: find must be non-empty");

      const occurrences = countStringMatches(next, needle, true);
      if (occurrences === 0) {
        throw new Error(`Patch find text not found: ${needle.slice(0, 80)}`);
      }
      if (replaceAll) {
        next = next.split(needle).join(replacement);
        totalReplacements += occurrences;
      } else {
        next = next.replace(needle, replacement);
        totalReplacements += 1;
      }
    }

    if (Boolean(dryRun)) {
      return `Patch can be applied to ${normalizedPath}: ${totalReplacements} replacement(s)`;
    }
    await fs.writeFile(abs, next, "utf8");
    return `Patched ${normalizedPath}: ${totalReplacements} replacement(s)`;
  };

  const replaceInFiles = async ({
    path: relPath = ".",
    find,
    replace = "",
    file_pattern: filePattern = "**/*",
    max_files: maxFiles = 200,
    max_replacements: maxReplacements = 5000,
    case_sensitive: caseSensitive = true,
    use_regex: useRegex = false,
    apply = false,
  } = {}) => {
    onToolStart?.("replace_in_files", {
      path: relPath,
      find,
      file_pattern: filePattern,
      max_files: maxFiles,
      max_replacements: maxReplacements,
      case_sensitive: caseSensitive,
      use_regex: useRegex,
      apply,
    });
    const abs = resolveInsideRoot(workspaceDir, relPath);
    const needle = String(find || "");
    if (!needle) throw new Error("Missing required parameter: find");
    const limitFiles = Math.min(Math.max(Number(maxFiles) || 200, 1), 2000);
    const replacementCap = Math.min(Math.max(Number(maxReplacements) || 5000, 1), 50000);
    const matcher = globToRegExp(String(filePattern || "**/*"));
    const pendingWrites = [];
    const fileResults = [];
    let scanned = 0;
    let totalReplacements = 0;

    let compiledRegex = null;
    if (useRegex) {
      compiledRegex = new RegExp(needle, caseSensitive ? "g" : "gi");
    }

    await walkWorkspaceFiles({
      workspaceDir,
      startAbsPath: abs,
      includeHidden: false,
      maxResults: Math.max(limitFiles * 20, 2000),
      onFile: async ({ fullPath, relPath: candidate }) => {
        if (scanned >= limitFiles) return;
        const target = normalizeRelPathForMatch(path.relative(abs, fullPath));
        if (!matcher.test(target)) return;
        scanned += 1;

        let content;
        try {
          content = await fs.readFile(fullPath, "utf8");
        } catch {
          return;
        }

        let count = 0;
        let nextContent = content;
        if (compiledRegex) {
          const matches = content.match(compiledRegex);
          count = matches ? matches.length : 0;
          if (count > 0) nextContent = content.replace(compiledRegex, String(replace));
        } else {
          count = countStringMatches(content, needle, Boolean(caseSensitive));
          if (count > 0) {
            if (caseSensitive) {
              nextContent = content.split(needle).join(String(replace));
            } else {
              const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const insensitive = new RegExp(escaped, "gi");
              nextContent = content.replace(insensitive, String(replace));
            }
          }
        }

        if (count <= 0) return;
        totalReplacements += count;
        if (totalReplacements > replacementCap) {
          throw new Error(`Replacement cap exceeded (${replacementCap})`);
        }

        fileResults.push({ path: candidate, replacements: count });
        if (Boolean(apply)) {
          pendingWrites.push({ fullPath, nextContent });
        }
      },
    });

    if (Boolean(apply)) {
      for (const item of pendingWrites) {
        await fs.writeFile(item.fullPath, item.nextContent, "utf8");
      }
    }

    return formatStructuredResult({
      mode: apply ? "apply" : "preview",
      path: relPath,
      scanned_files: scanned,
      matched_files: fileResults.length,
      replacements: totalReplacements,
      files: fileResults.slice(0, 200),
    });
  };

  const runGit = async (args) => {
    try {
      const { stdout, stderr } = await execFile("git", args, {
        cwd: workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, stdout: String(stdout || ""), stderr: String(stderr || ""), exitCode: 0 };
    } catch (error) {
      return {
        ok: false,
        stdout: String(error?.stdout || ""),
        stderr: String(error?.stderr || error?.message || ""),
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
  };

  const gitStatus = async ({ porcelain = true } = {}) => {
    onToolStart?.("git_status", { porcelain });
    const args = porcelain ? ["status", "--short", "--branch"] : ["status"];
    const result = await runGit(args);
    if (!result.ok) {
      return `Git status unavailable:\n${result.stderr || result.stdout || "unknown error"}`;
    }
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return output || "Working tree clean.";
  };

  const gitDiff = async ({ path: relPath = "", staged = false, context = 3 } = {}) => {
    onToolStart?.("git_diff", { path: relPath, staged, context });
    const ctx = Math.min(Math.max(Number(context) || 3, 0), 20);
    const args = ["diff", `--unified=${ctx}`];
    if (staged) args.push("--staged");
    const targetPath = String(relPath || "").trim();
    if (targetPath) {
      const abs = resolveInsideRoot(workspaceDir, targetPath);
      args.push("--", normalizeRelPathForMatch(path.relative(workspaceDir, abs)));
    }
    const result = await runGit(args);
    if (!result.ok) {
      return `Git diff unavailable:\n${result.stderr || result.stdout || "unknown error"}`;
    }
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return output || "No differences.";
  };

  const runTests = async ({ command = "npm test", timeout_ms: timeoutMs = 120000 } = {}) => {
    onToolStart?.("run_tests", { command, timeout_ms: timeoutMs });
    const cmd = String(command || "").trim();
    if (!cmd) throw new Error("Missing required parameter: command");

    const { approved, classification } = await approveShellCommand(cmd);
    if (!approved) return "Command was not approved by the user.";

    const timeout = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 30 * 60 * 1000);
    const { stdout, stderr, exitCode } = await executeShellCommand({ cmd, timeoutMs: timeout });
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const lines = combined.split("\n");
    const failedTests = [];
    const passedTests = [];
    for (const line of lines) {
      const failMatch = line.match(/^FAIL\s+(.+)$/);
      if (failMatch) failedTests.push(failMatch[1].trim());
      const passMatch = line.match(/^PASS\s+(.+)$/);
      if (passMatch) passedTests.push(passMatch[1].trim());
    }
    const suiteSummary = lines.find((line) => line.includes("Test Suites:")) || "";
    const testSummary = lines.find((line) => line.includes("Tests:")) || "";
    const outputPreview = truncatePreview(combined, 4000);
    return formatStructuredResult({
      command: cmd,
      classification: classification.level,
      exit_code: exitCode,
      passed: exitCode === 0,
      summaries: {
        suites: suiteSummary,
        tests: testSummary,
      },
      failed_tests: failedTests,
      passed_tests: passedTests.slice(0, 50),
      output_preview: outputPreview,
    });
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

  const listMcpServers = async () => {
    onToolStart?.("list_mcp_servers", {});
    if (!mcpAvailable()) return "No MCP servers configured.";
    const names = mcpHub.getServerNames();
    if (names.length === 0) return "No MCP servers configured.";
    return `MCP servers:\n${names.map((name) => `- ${name}`).join("\n")}`;
  };

  const listMcpTools = async ({ server } = {}) => {
    onToolStart?.("list_mcp_tools", { server });
    ensureMcp();
    const rows = await mcpHub.listTools({ server: server || null });
    if (!Array.isArray(rows) || rows.length === 0) return "No MCP tools available.";
    return rows
      .map((row) => {
        const prefix = row.server ? `${row.server}.` : "";
        const desc = String(row.description || "").trim();
        return desc ? `- ${prefix}${row.name}: ${desc}` : `- ${prefix}${row.name}`;
      })
      .join("\n");
  };

  const callMcpTool = async ({ server, tool, input = {} } = {}) => {
    onToolStart?.("mcp_call_tool", { server, tool, input });
    ensureMcp();
    const serverName = String(server || "").trim();
    const toolName = String(tool || "").trim();
    if (!serverName) throw new Error("Missing required parameter: server");
    if (!toolName) throw new Error("Missing required parameter: tool");

    let approved = autoApproveRef?.value ?? false;
    if (!approved && askApproval) {
      approved = await askApproval(`mcp tool: ${serverName}.${toolName}`);
    }
    if (!approved) {
      throw new Error("User did not approve MCP tool call");
    }

    const result = await mcpHub.callTool({
      server: serverName,
      tool: toolName,
      input: asObject(input),
    });
    return formatMcpToolCallResult({
      server: serverName,
      tool: toolName,
      result,
    });
  };

  const listMcpResources = async ({ server, cursor } = {}) => {
    onToolStart?.("list_mcp_resources", { server, cursor });
    ensureMcp();
    const resources = await mcpHub.listResources({
      server: server || null,
      cursor: cursor || null,
    });
    if (!Array.isArray(resources) || resources.length === 0) return "No MCP resources available.";
    return formatStructuredResult({ resources });
  };

  const listMcpResourceTemplates = async ({ server, cursor } = {}) => {
    onToolStart?.("list_mcp_resource_templates", { server, cursor });
    ensureMcp();
    const templates = await mcpHub.listResourceTemplates({
      server: server || null,
      cursor: cursor || null,
    });
    if (!Array.isArray(templates) || templates.length === 0) return "No MCP resource templates available.";
    return formatStructuredResult({ templates });
  };

  const readMcpResource = async ({ server, uri } = {}) => {
    onToolStart?.("read_mcp_resource", { server, uri });
    ensureMcp();
    const serverName = String(server || "").trim();
    const resourceUri = String(uri || "").trim();
    if (!serverName) throw new Error("Missing required parameter: server");
    if (!resourceUri) throw new Error("Missing required parameter: uri");
    const result = await mcpHub.readResource({
      server: serverName,
      uri: resourceUri,
    });
    return formatStructuredResult({
      server: serverName,
      uri: resourceUri,
      result,
    });
  };

  return {
    shell: runShell,
    read_file: readFile,
    read_files: readFiles,
    write_file: writeFile,
    apply_patch: applyPatch,
    replace_in_files: replaceInFiles,
    list_files: listFiles,
    glob_files: globFiles,
    find_files: findFiles,
    git_status: gitStatus,
    git_diff: gitDiff,
    run_tests: runTests,
    todo_write: todoWrite,
    todowrite: todoWrite,
    search_files: searchFiles,
    list_mcp_servers: listMcpServers,
    list_mcp_tools: listMcpTools,
    mcp_call_tool: callMcpTool,
    list_mcp_resources: listMcpResources,
    list_mcp_resource_templates: listMcpResourceTemplates,
    read_mcp_resource: readMcpResource,
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
  const baseArgs = [];
  if (!caseSensitive) baseArgs.push("-i");
  if (filePattern) baseArgs.push("-g", filePattern);
  baseArgs.push(
    "-g", "!node_modules",
    "-g", "!.git",
    "-g", "!dist",
    "-g", "!build",
    "-g", "!.next",
    "-g", "!coverage",
    "-g", "!.cache"
  );

  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--with-filename",
    "--max-count",
    String(Math.min(limit, 1000)),
    "--max-depth",
    "20",
    "-C",
    "2",
    ...baseArgs,
    regex,
    absPath,
  ];

  try {
    const { stdout } = await exec(`rg ${args.map((a) => `"${a}"`).join(" ")}`, {
      cwd: workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
    });

    const results = parseSearchResults(stdout, workspaceDir);
    return formatSearchResults(results, limit, regex);
  } catch (error) {
    if (isStdioMaxBufferError(error)) {
      const compactArgs = [
        "--files-with-matches",
        "--max-count",
        "1",
        "--max-depth",
        "20",
        ...baseArgs,
        regex,
        absPath,
      ];
      try {
        const { stdout } = await exec(`rg ${compactArgs.map((a) => `"${a}"`).join(" ")}`, {
          cwd: workspaceDir,
          maxBuffer: 10 * 1024 * 1024,
        });
        const files = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((file) => file.replace(workspaceDir + "/", "").replace(workspaceDir, "."));
        if (files.length === 0) return `No matches found for pattern: ${regex}`;
        const shown = files.slice(0, limit);
        const suffix = files.length > shown.length ? `\n... (${files.length - shown.length} more files)` : "";
        return `Found matches in ${files.length} files for "${regex}" (condensed due large output):\n${shown
          .map((file, idx) => `${idx + 1}. ${file}`)
          .join("\n")}${suffix}`;
      } catch (compactError) {
        if (compactError.code === 1 && !compactError.stdout) {
          return `No matches found for pattern: ${regex}`;
        }
        throw new Error(`Search failed: ${compactError.message}`);
      }
    }
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
        if (IGNORE_DIRS.has(entry.name)) continue;
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

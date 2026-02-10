import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

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
  const first = cleaned.split(/\s+/)[0] || "";
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

export function createToolset({ workspaceDir, autoApproveRef, askApproval, onToolStart, onTodoWrite }) {
  const runShell = async ({ command, timeout = 300000, maxBuffer = 10 * 1024 * 1024 }) => {
    if (!command || typeof command !== "string") {
      throw new Error("shell tool requires { command: string }");
    }
    const safety = classifyShellCommand(command);
    const needsApproval =
      safety.level === "dangerous" ||
      (safety.level !== "safe" && !autoApproveRef.value);
    const approved = needsApproval
      ? await askApproval(
          `Run ${safety.level} shell command? (${safety.reason})\n$ ${command}\nApprove [y/N]: `
        )
      : true;

    if (!approved) {
      return "Command was not approved by the user.";
    }

    onToolStart?.("shell", { command, safety: safety.level });
    try {
      const { stdout, stderr } = await exec(command, {
        cwd: workspaceDir,
        timeout,
        maxBuffer,
      });
      return [
        "exit_code: 0",
        `stdout:\n${stdout || "<empty>"}`,
        `stderr:\n${stderr || "<empty>"}`,
      ].join("\n\n");
    } catch (err) {
      return [
        "exit_code: non-zero",
        `error: ${err.message}`,
        `stdout:\n${err.stdout || "<empty>"}`,
        `stderr:\n${err.stderr || "<empty>"}`,
      ].join("\n\n");
    }
  };

  const readFile = async ({ path: filePath }) => {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("read_file tool requires { path: string }");
    }
    onToolStart?.("read_file", { path: filePath });
    const abs = resolveInsideRoot(workspaceDir, filePath);
    return fs.readFile(abs, "utf8");
  };

  const writeFile = async ({ path: filePath, content }) => {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("write_file tool requires { path: string, content: string }");
    }
    if (typeof content !== "string") {
      throw new Error("write_file tool requires string content");
    }
    onToolStart?.("write_file", { path: filePath });
    const abs = resolveInsideRoot(workspaceDir, filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
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
    onTodoWrite?.(normalized);
    const summary = normalized.map((t) => `- [${t.status}] ${t.content}`).join("\n");
    return `Updated ${normalized.length} todos:\n${summary}`;
  };

  return {
    shell: runShell,
    read_file: readFile,
    write_file: writeFile,
    list_files: listFiles,
    todo_write: todoWrite,
    todowrite: todoWrite,
  };
}

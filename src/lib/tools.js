import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

function resolveInsideRoot(root, candidatePath) {
  const resolved = path.resolve(root, candidatePath || ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${candidatePath}`);
  }
  return resolved;
}

export function createToolset({ workspaceDir, autoApproveRef, askApproval, onToolStart }) {
  const runShell = async ({ command }) => {
    if (!command || typeof command !== "string") {
      throw new Error("shell tool requires { command: string }");
    }

    const approved =
      autoApproveRef.value ||
      (await askApproval(`Run shell command?\n$ ${command}\nApprove [y/N]: `));

    if (!approved) {
      return "Command was not approved by the user.";
    }

    onToolStart?.("shell", { command });
    try {
      const { stdout, stderr } = await exec(command, {
        cwd: workspaceDir,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
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

  return {
    shell: runShell,
    read_file: readFile,
    write_file: writeFile,
    list_files: listFiles,
  };
}

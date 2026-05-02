import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function getGlobalMemoryPath() {
  const configured = process.env.PIECODE_GLOBAL_MEMORY_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode", "MEMORY.md");
}

export function getProjectMemoryPath(workspaceDir) {
  return path.join(workspaceDir, ".piecode", "MEMORY.md");
}

export function normalizeMemoryScope(scope) {
  const text = String(scope || "project").trim().toLowerCase();
  if (["global", "personal", "user"].includes(text)) return "global";
  return "project";
}

async function readMemoryFile(filePath, scope) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const content = String(raw || "").trim();
    return {
      scope,
      path: filePath,
      relPath: scope === "global" ? filePath : ".piecode/MEMORY.md",
      content,
      state: content ? "loaded" : "empty",
      error: "",
    };
  } catch (err) {
    const code = String(err?.code || "").toUpperCase();
    if (code === "ENOENT") {
      return {
        scope,
        path: filePath,
        relPath: scope === "global" ? filePath : ".piecode/MEMORY.md",
        content: "",
        state: "missing",
        error: "",
      };
    }
    return {
      scope,
      path: filePath,
      relPath: scope === "global" ? filePath : ".piecode/MEMORY.md",
      content: "",
      state: "error",
      error: String(err?.message || "unreadable"),
    };
  }
}

export async function loadMemory({ workspaceDir, globalPath = getGlobalMemoryPath() } = {}) {
  const root = workspaceDir || process.cwd();
  const projectPath = getProjectMemoryPath(root);
  const [globalMemory, projectMemory] = await Promise.all([
    readMemoryFile(globalPath, "global"),
    readMemoryFile(projectPath, "project"),
  ]);
  return {
    global: globalMemory,
    project: projectMemory,
    loadedAt: new Date().toISOString(),
  };
}

export function renderMemoryForPrompt(memory = null, maxCharsPerScope = 6000) {
  if (!memory || typeof memory !== "object") return "";
  const sections = [];
  for (const scope of ["global", "project"]) {
    const item = memory[scope];
    const content = String(item?.content || "").trim();
    if (!content) continue;
    const clipped = content.length > maxCharsPerScope
      ? `${content.slice(0, Math.max(0, maxCharsPerScope - 32))}\n[truncated memory content]`
      : content;
    const label = scope === "global" ? "Global/personal memory" : "Project memory";
    const source = item?.relPath || item?.path || "MEMORY.md";
    sections.push(`${label} (${source}):\n${clipped}`);
  }
  return sections.join("\n\n");
}

function normalizeMemoryContent(content) {
  const text = String(content || "").trim();
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export async function appendMemory({ workspaceDir, scope = "project", content, globalPath = getGlobalMemoryPath() } = {}) {
  const normalizedScope = normalizeMemoryScope(scope);
  const body = normalizeMemoryContent(content);
  if (!body) throw new Error("Missing required parameter: content");
  const root = workspaceDir || process.cwd();
  const filePath = normalizedScope === "global" ? globalPath : getProjectMemoryPath(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (String(err?.code || "").toUpperCase() !== "ENOENT") throw err;
  }

  const trimmedExisting = String(existing || "").trimEnd();
  const header = trimmedExisting ? "" : "# Memory\n\n";
  const entry = `- ${body.replace(/\n+/g, "\n  ")}`;
  const next = `${trimmedExisting}${trimmedExisting ? "\n" : header}${entry}\n`;
  await fs.writeFile(filePath, next, "utf8");
  return {
    scope: normalizedScope,
    path: filePath,
    relPath: normalizedScope === "global" ? filePath : ".piecode/MEMORY.md",
    bytes: Buffer.byteLength(entry, "utf8"),
  };
}

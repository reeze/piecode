import { promises as fs } from "node:fs";
import path from "node:path";

function stripQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseFrontmatterValue(key, value) {
  const raw = stripQuotes(value);
  if (key === "tools") {
    return raw
      .split(",")
      .map((item) => stripQuotes(item).trim())
      .filter(Boolean);
  }
  return raw;
}

export function parseAgentDefinitionMarkdown(content, { path: relPath = "" } = {}) {
  const source = String(content || "");
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return null;
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const raw = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    raw[key] = parseFrontmatterValue(key, value);
  }
  return normalizeAgentDefinition(raw, { path: relPath, prompt: match[2] || "" });
}

export function normalizeAgentDefinition(raw, { path: relPath = "", prompt = "" } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid agent name in ${relPath || "agent definition"}: ${name}`);
  }
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map((tool) => String(tool || "").trim()).filter(Boolean)
    : typeof raw.tools === "string"
      ? raw.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
      : [];
  return {
    name,
    description: String(raw.description || "").trim(),
    tools,
    model: String(raw.model || "inherit").trim() || "inherit",
    color: String(raw.color || "").trim(),
    prompt: String(prompt || "").trim(),
    path: String(relPath || ""),
  };
}

export async function loadAgentDefinitions({ workspaceDir } = {}) {
  const root = path.resolve(workspaceDir || process.cwd());
  const agentsDir = path.join(root, ".AGENTS");
  let entries = [];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const definitions = [];
  const seen = new Set();
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const abs = path.join(agentsDir, file);
    const relPath = [".AGENTS", file].join("/");
    const content = await fs.readFile(abs, "utf8");
    const definition = parseAgentDefinitionMarkdown(content, { path: relPath });
    if (!definition) continue;
    if (seen.has(definition.name)) continue;
    seen.add(definition.name);
    definitions.push(definition);
  }
  return definitions;
}

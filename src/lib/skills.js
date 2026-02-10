import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

export function resolveSkillRoots(settings = {}) {
  const envRoots = toArray(process.env.PIECODE_SKILLS_DIR)
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const settingsRoots = [
    ...toArray(settings?.skills?.paths),
    ...toArray(settings?.skillPaths),
  ];

  const defaults = [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
  ];

  return [...new Set([...envRoots, ...settingsRoots, ...defaults].map((p) => path.resolve(p)))];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkForSkillFiles(rootDir, maxFiles = 500) {
  const found = [];
  if (!(await pathExists(rootDir))) return found;

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift();
    if (depth > 5) continue;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".next", "dist", "build"].includes(entry.name)) continue;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(full);
        if (found.length >= maxFiles) break;
      }
    }
  }

  return found;
}

function skillNameFromPath(skillPath) {
  return path.basename(path.dirname(skillPath));
}

function extractDescription(content) {
  const lines = String(content || "").split("\n").map((line) => line.trim());
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return "";
}

export async function discoverSkills(skillRoots) {
  const index = new Map();
  for (const root of skillRoots) {
    const files = await walkForSkillFiles(root);
    for (const skillFile of files) {
      const name = skillNameFromPath(skillFile);
      if (!name || index.has(name)) continue;

      let description = "";
      try {
        const body = await fs.readFile(skillFile, "utf8");
        description = extractDescription(body);
      } catch {
        description = "";
      }

      index.set(name, {
        name,
        path: skillFile,
        description,
      });
    }
  }
  return index;
}

export function resolveRequestedSkills(argsSkills = [], settings = {}) {
  const configured = [
    ...toArray(settings?.skills?.enabled),
    ...toArray(settings?.skills),
    ...toArray(settings?.enabledSkills),
  ];
  const requested = [...configured, ...toArray(argsSkills)]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return [...new Set(requested)];
}

export async function loadActiveSkills(skillIndex, requestedNames) {
  const active = [];
  const missing = [];

  for (const name of requestedNames) {
    const meta = skillIndex.get(name);
    if (!meta) {
      missing.push(name);
      continue;
    }

    let content = "";
    try {
      content = await fs.readFile(meta.path, "utf8");
    } catch {
      missing.push(name);
      continue;
    }

    active.push({
      name: meta.name,
      path: meta.path,
      description: meta.description,
      content,
    });
  }

  return { active, missing };
}

export async function addSkillByName(activeSkills, skillIndex, name) {
  const normalized = String(name || "").trim();
  if (!normalized) return { active: activeSkills, added: false, reason: "missing-name" };
  if (activeSkills.some((skill) => skill.name === normalized)) {
    return { active: activeSkills, added: false, reason: "already-enabled" };
  }

  const meta = skillIndex.get(normalized);
  if (!meta) return { active: activeSkills, added: false, reason: "not-found" };

  try {
    const content = await fs.readFile(meta.path, "utf8");
    return {
      active: [...activeSkills, { ...meta, content }],
      added: true,
      reason: "",
    };
  } catch {
    return { active: activeSkills, added: false, reason: "unreadable" };
  }
}

export function removeSkillByName(activeSkills, name) {
  const normalized = String(name || "").trim();
  const next = activeSkills.filter((skill) => skill.name !== normalized);
  return {
    active: next,
    removed: next.length !== activeSkills.length,
  };
}

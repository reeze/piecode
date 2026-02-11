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

/**
 * Parse YAML frontmatter from content
 * Supports simple key-value pairs, arrays, and nested objects
 * @param {string} content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(content) {
  const str = String(content || "").trim();
  if (!str.startsWith("---")) {
    return { frontmatter: {}, body: str };
  }

  const endMatch = str.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!endMatch) {
    return { frontmatter: {}, body: str };
  }

  const yamlText = endMatch[1];
  const body = str.slice(endMatch[0].length).trim();
  const frontmatter = {};

  const lines = yamlText.split("\n");
  const context = []; // Stack to track nested objects

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Calculate indentation level
    const indent = line.length - line.trimStart().length;

    // Check for array item (starts with - )
    const arrayItemMatch = line.match(/^(\s*)-\s*(.+)$/);
    if (arrayItemMatch && context.length > 0) {
      const [, itemIndent, value] = arrayItemMatch;
      const parent = context[context.length - 1];
      if (parent && Array.isArray(parent.obj[parent.key])) {
        parent.obj[parent.key].push(parseYamlValue(value));
        continue;
      }
    }

    // Check for key-value pair
    const keyMatch = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, keyIndent, key, value] = keyMatch;

      // Pop context stack based on indentation
      while (context.length > 0 && context[context.length - 1].indent >= indent) {
        context.pop();
      }

      const parent = context.length > 0 ? context[context.length - 1] : null;
      const target = parent ? parent.obj[parent.key] : frontmatter;

      if (value) {
        // Parse value immediately
        target[key] = parseYamlValue(value);
      } else {
        // Check next line to determine if it's an array or object
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.trim().startsWith("- ")) {
          target[key] = [];
        } else if (nextLine && nextLine.match(/^\s+[\w-]+:/)) {
          target[key] = {};
        } else {
          target[key] = {};
        }
        // Push to context for nested properties
        context.push({ obj: target, key, indent });
      }
    }
  }

  return { frontmatter, body };
}

function parseYamlValue(value) {
  const trimmed = value.trim();
  
  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  
  // Null
  if (trimmed === "null" || trimmed === "~") return null;
  
  // Number
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  
  // Array notation [item1, item2]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch {
      // Fall through to string
    }
  }
  
  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  
  return trimmed;
}

/**
 * Extract triggers from frontmatter or content body
 * @param {object} frontmatter
 * @param {string} body
 * @returns {string[]} Array of trigger keywords/patterns
 */
export function extractTriggers(frontmatter, body) {
  const triggers = [];
  
  // Check frontmatter for triggers field
  if (frontmatter.triggers) {
    if (Array.isArray(frontmatter.triggers)) {
      triggers.push(...frontmatter.triggers);
    } else if (typeof frontmatter.triggers === "string") {
      triggers.push(...frontmatter.triggers.split(",").map(t => t.trim()).filter(Boolean));
    }
  }
  
  // Also check for "when to apply" section in body
  const whenToApplyMatch = body.match(/##?\s*(?:When to Apply|Triggers|Apply when)[\s\S]*?(?=\n##|\n###|$)/i);
  if (whenToApplyMatch) {
    const section = whenToApplyMatch[0];
    // Extract list items
    const listItems = section.match(/^\s*[-*]\s*(.+)$/gm);
    if (listItems) {
      for (const item of listItems) {
        const keyword = item.replace(/^\s*[-*]\s*/, "").trim();
        if (keyword && !triggers.includes(keyword)) {
          triggers.push(keyword);
        }
      }
    }
  }
  
  return triggers.map(t => t.toLowerCase());
}

export async function discoverSkills(skillRoots) {
  const index = new Map();
  for (const root of skillRoots) {
    const files = await walkForSkillFiles(root);
    for (const skillFile of files) {
      const name = skillNameFromPath(skillFile);
      if (!name || index.has(name)) continue;

      let description = "";
      let content = "";
      let frontmatter = {};
      let triggers = [];
      
      try {
        content = await fs.readFile(skillFile, "utf8");
        const parsed = parseFrontmatter(content);
        frontmatter = parsed.frontmatter;
        
        // Use description from frontmatter or extract from body
        description = frontmatter.description || extractDescription(parsed.body);
        
        // Extract triggers
        triggers = extractTriggers(frontmatter, parsed.body);
      } catch {
        description = "";
      }

      index.set(name, {
        name,
        path: skillFile,
        description,
        content,
        frontmatter,
        triggers,
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
      triggers: meta.triggers || [],
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

/**
 * Find skills that should be auto-enabled based on input triggers
 * @param {string} input - User input text
 * @param {Map} skillIndex - All discovered skills
 * @param {Array} activeSkills - Currently active skills (to avoid duplicates)
 * @returns {Array} Skills that match the input
 */
export function findTriggeredSkills(input, skillIndex, activeSkills = []) {
  const normalizedInput = String(input || "").toLowerCase();
  const activeNames = new Set(activeSkills.map(s => s.name));
  const triggered = [];
  
  for (const [name, meta] of skillIndex) {
    // Skip already active skills
    if (activeNames.has(name)) continue;
    
    // Check if any trigger matches
    const matches = meta.triggers.some(trigger => {
      // Support exact word matching and substring matching
      const triggerWords = trigger.split(/\s+/);
      if (triggerWords.length > 1) {
        // Multi-word trigger - check for phrase match
        return normalizedInput.includes(trigger);
      }
      // Single word trigger - check for word boundary match
      const wordRegex = new RegExp(`\\b${escapeRegex(trigger)}\\b`, "i");
      return wordRegex.test(normalizedInput);
    });
    
    if (matches) {
      triggered.push(meta);
    }
  }
  
  return triggered;
}

/**
 * Find skills mentioned by $skill-name syntax
 * @param {string} input - User input text
 * @param {Map} skillIndex - All discovered skills
 * @param {Array} activeSkills - Currently active skills
 * @returns {Array} Skills that are mentioned
 */
export function findMentionedSkills(input, skillIndex, activeSkills = []) {
  const activeNames = new Set(activeSkills.map(s => s.name));
  const mentioned = [];
  
  // Match $skill-name pattern
  const mentionRegex = /\$([a-z0-9._-]+)/gi;
  let match;
  
  while ((match = mentionRegex.exec(input)) !== null) {
    const name = match[1];
    if (!activeNames.has(name) && skillIndex.has(name)) {
      mentioned.push(skillIndex.get(name));
    }
  }
  
  return mentioned;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Auto-enable skills based on triggers and mentions
 * @param {string} input - User input
 * @param {object} activeSkillsRef - Reference to active skills array { value: [] }
 * @param {Map} skillIndex - All discovered skills
 * @returns {Promise<{enabled: string[], byTrigger: string[], byMention: string[]}>}
 */
export async function autoEnableSkills(input, activeSkillsRef, skillIndex) {
  const enabled = [];
  const byTrigger = [];
  const byMention = [];
  
  // Find triggered skills
  const triggered = findTriggeredSkills(input, skillIndex, activeSkillsRef.value);
  for (const meta of triggered) {
    const result = await addSkillByName(activeSkillsRef.value, skillIndex, meta.name);
    if (result.added) {
      activeSkillsRef.value = result.active;
      enabled.push(meta.name);
      byTrigger.push(meta.name);
    }
  }
  
  // Find mentioned skills
  const mentioned = findMentionedSkills(input, skillIndex, activeSkillsRef.value);
  for (const meta of mentioned) {
    const result = await addSkillByName(activeSkillsRef.value, skillIndex, meta.name);
    if (result.added) {
      activeSkillsRef.value = result.active;
      enabled.push(meta.name);
      byMention.push(meta.name);
    }
  }
  
  return { enabled, byTrigger, byMention };
}

export function extractSkillNamesFromInstructions(content, skillIndex = null) {
  const text = String(content || "");
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const names = [];
  const seen = new Set();
  let inAvailableSkills = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inAvailableSkills) {
      if (/^#{2,4}\s+available skills\b/i.test(trimmed)) {
        inAvailableSkills = true;
      }
      continue;
    }

    if (/^#{2,4}\s+/.test(trimmed)) break;
    const bullet = trimmed.match(/^-\s+([a-z0-9._-]+)\s*:/i);
    if (!bullet?.[1]) continue;
    const name = String(bullet[1]).trim();
    if (!name || seen.has(name)) continue;
    if (skillIndex instanceof Map && !skillIndex.has(name)) continue;
    names.push(name);
    seen.add(name);
  }

  return names;
}

export async function autoLoadSkillsFromInstructions(
  projectInstructions,
  activeSkillsRef,
  skillIndex
) {
  const content = String(projectInstructions?.content || "");
  if (!content.trim()) return { enabled: [], missing: [] };

  const names = extractSkillNamesFromInstructions(content);
  if (names.length === 0) return { enabled: [], missing: [] };

  const enabled = [];
  const missing = [];
  for (const name of names) {
    const result = await addSkillByName(activeSkillsRef.value, skillIndex, name);
    if (result.added) {
      activeSkillsRef.value = result.active;
      enabled.push(name);
    } else if (result.reason === "not-found" || result.reason === "unreadable") {
      missing.push(name);
    }
  }

  return { enabled, missing };
}

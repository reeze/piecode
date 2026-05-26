import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractTriggers, parseFrontmatter } from "./skills.js";

const PLUGIN_FILE_NAME = "PLUGIN.md";
const MAX_PLUGIN_FILES = 500;
const MAX_PLUGIN_BYTES = 64 * 1024;
const MAX_PLUGIN_SKILLS = 200;
const MAX_PLUGIN_COMMANDS = 100;
const MAX_PLUGIN_SKILL_BYTES = 96 * 1024;
const DEFAULT_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 12000;
const VALID_NAME_RE = /^[a-z0-9._:-]+$/i;
const RESERVED_COMMANDS = new Set([
  "help",
  "exit",
  "quit",
  "clear",
  "compact",
  "sessions",
  "resume",
  "status",
  "agents",
  "subagents",
  "btw",
  "plan",
  "approve",
  "trace",
  "debug",
  "model",
  "mcp",
  "skills",
  "use",
  "plugins",
  "plugin",
  "skill-creator",
  "workspace",
  "attach",
]);

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

function normalizeName(value) {
  const name = String(value || "").trim().replace(/^\/+/, "").toLowerCase();
  return VALID_NAME_RE.test(name) ? name : "";
}

function normalizeBool(value) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function uniqueNormalizedNames(values) {
  const out = [];
  const seen = new Set();
  for (const raw of toArray(values).flatMap((item) => String(item || "").split(","))) {
    const name = normalizeName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function resolveAgainstWorkspace(workspaceRoot, value) {
  return path.resolve(workspaceRoot, String(value || ""));
}

export function resolvePluginRoots(settings = {}, workspaceDir = process.cwd()) {
  const workspaceRoot = path.resolve(workspaceDir || process.cwd());
  const envRoots = toArray(process.env.PIECODE_PLUGINS_DIR)
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const settingsRoots = [
    ...toArray(settings?.plugins?.paths),
    ...toArray(settings?.pluginPaths),
  ];
  const defaults = [
    path.join(workspaceRoot, ".piecode", "plugins"),
    path.join(workspaceRoot, "plugins"),
    path.join(os.homedir(), ".piecode", "plugins"),
    path.join(os.homedir(), ".agents", "plugins"),
  ];
  return [
    ...new Set(
      [...envRoots, ...settingsRoots, ...defaults]
        .map((entry) => resolveAgainstWorkspace(workspaceRoot, entry))
        .filter(Boolean)
    ),
  ];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkForPluginFiles(rootDir, maxFiles = MAX_PLUGIN_FILES) {
  const found = [];
  if (!(await pathExists(rootDir))) return found;

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift();
    if (depth > 5) continue;

    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".next", "dist", "build"].includes(entry.name)) continue;
        queue.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name === PLUGIN_FILE_NAME) {
        found.push(fullPath);
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

async function walkForNamedFiles(rootDir, fileName, maxFiles = 200, maxDepth = 5) {
  const found = [];
  if (!(await pathExists(rootDir))) return found;
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".next", "dist", "build"].includes(entry.name)) continue;
        queue.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        found.push(fullPath);
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

async function walkForMarkdownCommands(rootDir, maxFiles = MAX_PLUGIN_COMMANDS) {
  const found = [];
  if (!(await pathExists(rootDir))) return found;
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift();
    if (depth > 2) continue;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".next", "dist", "build"].includes(entry.name)) continue;
        queue.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        found.push(fullPath);
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

function pluginNameFromPath(pluginPath) {
  return normalizeName(path.basename(path.dirname(pluginPath)));
}

function extractDescription(body) {
  const lines = String(body || "").split("\n").map((line) => line.trim());
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return "";
}

function normalizeContext(frontmatter = {}) {
  const raw = frontmatter?.context && typeof frontmatter.context === "object" ? frontmatter.context : {};
  const modeRaw = String(raw.mode || "when-enabled").trim().toLowerCase();
  const mode = ["always", "when-enabled", "on-trigger"].includes(modeRaw) ? modeRaw : "when-enabled";
  const maxRaw = Number(raw.maxChars ?? raw.max_chars ?? DEFAULT_CONTEXT_CHARS);
  const maxChars = Math.min(Math.max(Number.isFinite(maxRaw) ? Math.round(maxRaw) : DEFAULT_CONTEXT_CHARS, 0), MAX_CONTEXT_CHARS);
  return { mode, maxChars };
}

function normalizePermissions(frontmatter = {}) {
  const rawPermissions = frontmatter?.permissions && typeof frontmatter.permissions === "object" ? frontmatter.permissions : {};
  const tools = rawPermissions?.tools && typeof rawPermissions.tools === "object" ? rawPermissions.tools : {};
  const allow = uniqueNormalizedNames(tools.allow || tools.allowed || []);
  return { tools: { allow } };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function extractHooksObject(value) {
  if (!isPlainObject(value)) return null;
  if (isPlainObject(value.hooks)) return value.hooks;
  return value;
}

async function readJsonFile(filePath, maxBytes = MAX_PLUGIN_BYTES) {
  const content = await readSmallTextFile(filePath, maxBytes);
  return JSON.parse(content);
}

async function maybeReadJsonFile(filePath) {
  try {
    if (!(await pathExists(filePath))) return null;
    return await readJsonFile(filePath);
  } catch {
    return null;
  }
}

function mergeHookConfigs(configs = []) {
  const merged = {};
  for (const raw of configs) {
    const hooks = extractHooksObject(raw);
    if (!hooks) continue;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!groups) continue;
      const list = Array.isArray(groups) ? groups : [groups];
      if (!merged[event]) merged[event] = [];
      merged[event].push(...list.filter((group) => isPlainObject(group)));
    }
  }
  return merged;
}

async function loadHookConfigPath(baseDir, entry) {
  const rawPath = String(entry || "").trim();
  if (!rawPath) return null;
  const absPath = path.resolve(baseDir, rawPath);
  if (!absPath.startsWith(path.resolve(baseDir) + path.sep) && absPath !== path.resolve(baseDir)) return null;
  return await maybeReadJsonFile(absPath);
}

async function loadManifestHooks(pluginDir, manifestDirName) {
  const manifest = await maybeReadJsonFile(path.join(pluginDir, manifestDirName, "plugin.json"));
  if (!manifest || manifest.hooks == null) return [];
  if (typeof manifest.hooks === "string") {
    const loaded = await loadHookConfigPath(pluginDir, manifest.hooks);
    return loaded ? [loaded] : [];
  }
  if (Array.isArray(manifest.hooks)) {
    const loaded = [];
    for (const entry of manifest.hooks) {
      if (typeof entry === "string") {
        const config = await loadHookConfigPath(pluginDir, entry);
        if (config) loaded.push(config);
      } else if (isPlainObject(entry)) {
        loaded.push(entry);
      }
    }
    return loaded;
  }
  return isPlainObject(manifest.hooks) ? [manifest.hooks] : [];
}

async function discoverPluginHooks(frontmatter = {}, pluginFile) {
  const base = pluginBaseDir(pluginFile);
  const configs = [];
  const frontmatterHooks = frontmatter?.hooks;

  if (typeof frontmatterHooks === "string") {
    const loaded = await loadHookConfigPath(base, frontmatterHooks);
    if (loaded) configs.push(loaded);
  } else if (Array.isArray(frontmatterHooks)) {
    for (const entry of frontmatterHooks) {
      if (typeof entry === "string") {
        const loaded = await loadHookConfigPath(base, entry);
        if (loaded) configs.push(loaded);
      } else if (isPlainObject(entry)) {
        configs.push(entry);
      }
    }
  } else if (isPlainObject(frontmatterHooks)) {
    configs.push(frontmatterHooks);
  }

  const manifestConfigs = [
    ...(await loadManifestHooks(base, ".codex-plugin")),
    ...(await loadManifestHooks(base, ".claude-plugin")),
  ];
  configs.push(...manifestConfigs);

  const defaultConfig = await maybeReadJsonFile(path.join(base, "hooks", "hooks.json"));
  if (defaultConfig) configs.push(defaultConfig);

  return mergeHookConfigs(configs);
}

async function readPluginFile(pluginFile) {
  const stat = await fs.stat(pluginFile);
  if (stat.size > MAX_PLUGIN_BYTES) throw new Error(`Plugin file too large: ${pluginFile}`);
  return await fs.readFile(pluginFile, "utf8");
}

async function readSmallTextFile(filePath, maxBytes = MAX_PLUGIN_SKILL_BYTES) {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) throw new Error(`File too large: ${filePath}`);
  return await fs.readFile(filePath, "utf8");
}

function pluginBaseDir(pluginFile) {
  return path.dirname(pluginFile);
}

function getPluginSkillRoots(frontmatter = {}, pluginFile) {
  const base = pluginBaseDir(pluginFile);
  const configured = [frontmatter.skills, frontmatter.skillPath, frontmatter.skill_path]
    .flatMap((value) => toArray(value))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const roots = configured.length > 0 ? configured : ["skills"];
  return roots.map((root) => path.resolve(base, root));
}

async function discoverPluginSkills(frontmatter, pluginFile, pluginName) {
  const skills = [];
  const seen = new Set();
  for (const root of getPluginSkillRoots(frontmatter, pluginFile)) {
    const files = await walkForNamedFiles(root, "SKILL.md", MAX_PLUGIN_SKILLS, 5);
    for (const skillFile of files) {
      if (seen.has(skillFile)) continue;
      seen.add(skillFile);
      try {
        const content = await readSmallTextFile(skillFile);
        const parsed = parseFrontmatter(content);
        const skillFrontmatter = parsed.frontmatter || {};
        const rawName = skillFrontmatter.name || path.basename(path.dirname(skillFile));
        const name = normalizeName(rawName);
        if (!name) continue;
        skills.push({
          name,
          commandName: normalizeName(`${pluginName}:${name}`),
          path: skillFile,
          relPath: path.relative(pluginBaseDir(pluginFile), skillFile).split(path.sep).join("/"),
          description: String(skillFrontmatter.description || extractDescription(parsed.body) || "").trim(),
          frontmatter: skillFrontmatter,
          triggers: extractTriggers(skillFrontmatter, parsed.body),
        });
      } catch {
        // Ignore unreadable plugin skills so one bad file does not hide the plugin.
      }
    }
  }
  return skills;
}

async function discoverPluginCommandFiles(frontmatter, pluginFile, pluginName) {
  const base = pluginBaseDir(pluginFile);
  const configured = [frontmatter.commandsPath, frontmatter.commands_path]
    .flatMap((value) => toArray(value))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const roots = configured.length > 0 ? configured : ["commands"];
  const commands = [];
  const seen = new Set();
  for (const root of roots.map((entry) => path.resolve(base, entry))) {
    const files = await walkForMarkdownCommands(root, MAX_PLUGIN_COMMANDS);
    for (const commandFile of files) {
      if (seen.has(commandFile)) continue;
      seen.add(commandFile);
      try {
        const content = await readSmallTextFile(commandFile, MAX_PLUGIN_BYTES);
        const parsed = parseFrontmatter(content);
        const commandBase = path.basename(commandFile, path.extname(commandFile));
        const command = normalizeName(commandBase);
        if (!command || RESERVED_COMMANDS.has(command)) continue;
        commands.push({
          command,
          slash: `/${command}`,
          pluginName,
          pluginPath: pluginFile,
          description: String(parsed.frontmatter?.description || extractDescription(parsed.body) || "").trim(),
          prompt: parsed.body || content,
          commandFile,
        });
      } catch {
        // Ignore unreadable command files.
      }
    }
  }
  return commands;
}

export async function discoverPlugins(pluginRoots = []) {
  const index = new Map();
  const roots = Array.isArray(pluginRoots) ? pluginRoots : [];
  for (const root of roots) {
    const files = await walkForPluginFiles(root);
    for (const pluginFile of files) {
      let content = "";
      let parsed = { frontmatter: {}, body: "" };
      try {
        content = await readPluginFile(pluginFile);
        parsed = parseFrontmatter(content);
      } catch {
        continue;
      }

      const frontmatter = parsed.frontmatter || {};
      const name = normalizeName(frontmatter.name || pluginNameFromPath(pluginFile));
      if (!name || index.has(name)) continue;
      const description = String(frontmatter.description || extractDescription(parsed.body) || "").trim();
      const version = String(frontmatter.version || "").trim();
      const pluginSkills = await discoverPluginSkills(frontmatter, pluginFile, name);
      const pluginCommands = await discoverPluginCommandFiles(frontmatter, pluginFile, name);
      const pluginHooks = await discoverPluginHooks(frontmatter, pluginFile);
      const triggers = [
        ...extractTriggers(frontmatter, parsed.body),
        ...pluginSkills.flatMap((skill) => skill.triggers || []),
      ];
      index.set(name, {
        name,
        path: pluginFile,
        root,
        baseDir: pluginBaseDir(pluginFile),
        description,
        version,
        content,
        body: parsed.body,
        frontmatter,
        triggers,
        skills: pluginSkills,
        commandFiles: pluginCommands,
        enabledByDefault: normalizeBool(frontmatter.enabledByDefault ?? frontmatter.enabled_by_default),
        context: normalizeContext(frontmatter),
        permissions: normalizePermissions(frontmatter),
        hooks: pluginHooks,
      });
    }
  }
  return index;
}

export function resolveRequestedPlugins(argsPlugins = [], settings = {}) {
  const enabled = uniqueNormalizedNames([
    ...toArray(settings?.plugins?.enabled),
    ...toArray(settings?.enabledPlugins),
    ...toArray(argsPlugins),
  ]);
  const disabled = new Set(resolveDisabledPlugins(settings));
  return enabled.filter((name) => !disabled.has(name));
}

export function resolveDisabledPlugins(settings = {}) {
  return uniqueNormalizedNames([
    ...toArray(settings?.plugins?.disabled),
    ...toArray(settings?.disabledPlugins),
  ]);
}

export async function loadActivePlugins(pluginIndex, requestedNames = []) {
  const active = [];
  const missing = [];
  const names = uniqueNormalizedNames(requestedNames);
  for (const name of names) {
    const meta = pluginIndex instanceof Map ? pluginIndex.get(name) : null;
    if (!meta) {
      missing.push(name);
      continue;
    }
    try {
      const content = await readPluginFile(meta.path);
      active.push({ ...meta, content });
    } catch {
      missing.push(name);
    }
  }
  return { active, missing };
}

export function getDefaultPluginNames(pluginIndex, settings = {}) {
  const disabled = new Set(resolveDisabledPlugins(settings));
  const configured = new Set(resolveRequestedPlugins([], settings));
  const out = [];
  if (!(pluginIndex instanceof Map)) return out;
  for (const plugin of pluginIndex.values()) {
    if (!plugin.enabledByDefault) continue;
    if (disabled.has(plugin.name) || configured.has(plugin.name)) continue;
    out.push(plugin.name);
  }
  return out;
}

export async function addPluginByName(activePlugins, pluginIndex, name) {
  const normalized = normalizeName(name);
  const current = Array.isArray(activePlugins) ? activePlugins : [];
  if (!normalized) return { active: current, added: false, reason: "missing-name" };
  if (current.some((plugin) => plugin.name === normalized)) {
    return { active: current, added: false, reason: "already-enabled" };
  }
  const meta = pluginIndex instanceof Map ? pluginIndex.get(normalized) : null;
  if (!meta) return { active: current, added: false, reason: "not-found" };
  try {
    const content = await readPluginFile(meta.path);
    return { active: [...current, { ...meta, content }], added: true, reason: "" };
  } catch {
    return { active: current, added: false, reason: "unreadable" };
  }
}

export function removePluginByName(activePlugins, name) {
  const normalized = normalizeName(name);
  const current = Array.isArray(activePlugins) ? activePlugins : [];
  const next = current.filter((plugin) => plugin.name !== normalized);
  return { active: next, removed: next.length !== current.length };
}

function commandDescriptionFromValue(value, fallback = "") {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    return String(value.description || value.desc || value.summary || fallback || "").trim();
  }
  return String(fallback || "").trim();
}

function addCommandSpec(specs, name, value, fallbackDescription, extra = {}) {
  const command = normalizeName(name);
  if (!command || RESERVED_COMMANDS.has(command)) return;
  specs.push({ command, description: commandDescriptionFromValue(value, fallbackDescription), ...extra });
}

function extractPluginCommandSpecs(plugin) {
  const specs = [];
  const frontmatter = plugin?.frontmatter && typeof plugin.frontmatter === "object" ? plugin.frontmatter : {};
  const fallbackDescription = String(plugin?.description || "").trim();

  if (typeof frontmatter.command === "string") {
    addCommandSpec(specs, frontmatter.command, { description: frontmatter.commandDescription || fallbackDescription }, fallbackDescription);
  }
  if (Array.isArray(frontmatter.aliases)) {
    for (const alias of frontmatter.aliases) addCommandSpec(specs, alias, { description: fallbackDescription }, fallbackDescription);
  }

  const commands = frontmatter.commands;
  if (typeof commands === "string") {
    for (const item of commands.split(",").map((part) => part.trim()).filter(Boolean)) {
      addCommandSpec(specs, item, { description: fallbackDescription }, fallbackDescription);
    }
  } else if (Array.isArray(commands)) {
    for (const item of commands) {
      if (typeof item === "string") addCommandSpec(specs, item, { description: fallbackDescription }, fallbackDescription);
      else if (item && typeof item === "object") addCommandSpec(specs, item.name || item.command, item, fallbackDescription);
    }
  } else if (commands && typeof commands === "object") {
    for (const [name, value] of Object.entries(commands)) addCommandSpec(specs, name, value, fallbackDescription);
  }

  for (const commandFile of Array.isArray(plugin?.commandFiles) ? plugin.commandFiles : []) {
    addCommandSpec(specs, commandFile.command, { description: commandFile.description || fallbackDescription }, fallbackDescription, {
      source: "file",
      prompt: commandFile.prompt,
      commandFile: commandFile.commandFile,
    });
  }

  for (const skill of Array.isArray(plugin?.skills) ? plugin.skills : []) {
    addCommandSpec(specs, skill.commandName, { description: skill.description || fallbackDescription }, fallbackDescription, {
      source: "skill",
      skill,
    });
  }

  const seen = new Set();
  return specs.filter((spec) => {
    if (!spec.command || seen.has(spec.command)) return false;
    seen.add(spec.command);
    return true;
  });
}

export function discoverPluginCommands(pluginIndex) {
  const index = new Map();
  if (!(pluginIndex instanceof Map)) return index;
  for (const plugin of pluginIndex.values()) {
    for (const spec of extractPluginCommandSpecs(plugin)) {
      if (index.has(spec.command)) continue;
      index.set(spec.command, {
        name: spec.command,
        slash: `/${spec.command}`,
        pluginName: plugin.name,
        pluginPath: plugin.path,
        description: spec.description || plugin.description || "",
        source: spec.source || "frontmatter",
        skill: spec.skill || null,
        promptTemplate: spec.prompt || "",
        commandFile: spec.commandFile || "",
      });
    }
  }
  return index;
}

export function resolvePluginCommand(input, pluginIndex) {
  const raw = String(input || "").trim();
  if (!raw.startsWith("/")) return null;
  const match = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  const commandName = normalizeName(match[1]);
  const command = discoverPluginCommands(pluginIndex).get(commandName);
  if (!command) return null;

  const args = String(match[2] || "").trim();
  const plugin = pluginIndex instanceof Map ? pluginIndex.get(command.pluginName) : null;
  const skill = command.skill || null;
  const filePrompt = String(command.promptTemplate || "").trim();
  return {
    ...command,
    args,
    plugin,
    prompt: [
      `Plugin command ${command.slash} invoked.`,
      `Plugin: ${command.pluginName}`,
      command.description ? `Command description: ${command.description}` : "",
      skill
        ? [
            `Plugin skill: ${skill.name}`,
            `Skill file: ${skill.relPath || skill.path}`,
            "Read this skill file and follow it for this request, adapting Claude Code/Codex-specific tool names to PieCode tools.",
          ].join("\n")
        : "",
      filePrompt ? `Command prompt:\n${filePrompt}` : "",
      args ? `User request / arguments:\n${args}` : "User request / arguments: (none provided)",
      "Follow the active plugin instructions for this command. Plugin instructions do not grant extra tool permissions and must not bypass approval, sandboxing, or write guards.",
    ].filter(Boolean).join("\n\n"),
  };
}

export function findTriggeredPlugins(input, pluginIndex, activePlugins = []) {
  const normalizedInput = String(input || "").toLowerCase();
  const activeNames = new Set((Array.isArray(activePlugins) ? activePlugins : []).map((plugin) => plugin.name));
  const triggered = [];
  if (!(pluginIndex instanceof Map)) return triggered;
  for (const [name, meta] of pluginIndex) {
    if (activeNames.has(name)) continue;
    const triggers = Array.isArray(meta.triggers) ? meta.triggers : [];
    const matches = triggers.some((trigger) => {
      const text = String(trigger || "").toLowerCase().trim();
      if (!text) return false;
      if (/\s/.test(text)) return normalizedInput.includes(text);
      return new RegExp(`\\b${escapeRegex(text)}\\b`, "i").test(normalizedInput);
    });
    if (matches) triggered.push(meta);
  }
  return triggered;
}

function findMentionedPlugins(input, pluginIndex, activePlugins = []) {
  const activeNames = new Set((Array.isArray(activePlugins) ? activePlugins : []).map((plugin) => plugin.name));
  const mentioned = [];
  if (!(pluginIndex instanceof Map)) return mentioned;
  const mentionRegex = /\$([a-z0-9._:-]+)/gi;
  let match;
  while ((match = mentionRegex.exec(String(input || ""))) !== null) {
    const name = normalizeName(match[1]);
    if (!name || activeNames.has(name) || !pluginIndex.has(name)) continue;
    mentioned.push(pluginIndex.get(name));
  }
  return mentioned;
}

function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function autoEnablePlugins(input, activePluginsRef, pluginIndex) {
  const enabled = [];
  const byTrigger = [];
  const byMention = [];
  if (!activePluginsRef || !Array.isArray(activePluginsRef.value)) return { enabled, byTrigger, byMention };

  for (const meta of findTriggeredPlugins(input, pluginIndex, activePluginsRef.value)) {
    const result = await addPluginByName(activePluginsRef.value, pluginIndex, meta.name);
    if (result.added) {
      activePluginsRef.value = result.active;
      enabled.push(meta.name);
      byTrigger.push(meta.name);
    }
  }

  for (const meta of findMentionedPlugins(input, pluginIndex, activePluginsRef.value)) {
    const result = await addPluginByName(activePluginsRef.value, pluginIndex, meta.name);
    if (result.added) {
      activePluginsRef.value = result.active;
      enabled.push(meta.name);
      byMention.push(meta.name);
    }
  }

  return { enabled, byTrigger, byMention };
}

export function formatPluginContextForPrompt(plugin) {
  const body = String(plugin?.body || plugin?.content || "").trim();
  const context = plugin?.context && typeof plugin.context === "object" ? plugin.context : {};
  const maxChars = Math.min(Math.max(Number(context.maxChars) || DEFAULT_CONTEXT_CHARS, 0), MAX_CONTEXT_CHARS);
  const skills = Array.isArray(plugin?.skills) ? plugin.skills : [];
  const skillLines = skills.length > 0
    ? [
        "",
        "Discovered plugin skills:",
        ...skills.map((skill) => `- /${skill.commandName}: ${skill.description || skill.relPath || skill.name} (${skill.relPath || skill.path})`),
      ].join("\n")
    : "";
  const combined = `${body}${skillLines}`.trim();
  if (maxChars <= 0) return "";
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars)}\n[plugin context truncated]`;
}

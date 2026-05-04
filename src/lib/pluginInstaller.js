import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { discoverPlugins } from "./plugins.js";

const execFileDefault = promisify(execFileCb);
const VALID_PLUGIN_NAME_RE = /^[a-z0-9._:-]+$/i;

async function defaultPathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9._:-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function derivePluginNameFromSource(source) {
  const raw = String(source || "").trim();
  if (!raw) return "";
  const withoutQuery = raw.split(/[?#]/)[0];
  const slashParts = withoutQuery.split(/[\\/]/).filter(Boolean);
  const last = slashParts[slashParts.length - 1] || withoutQuery;
  const scpLike = last.includes(":") ? last.split(":").pop() : last;
  return sanitizeName(path.basename(scpLike));
}

export function isGitPluginSource(source) {
  const raw = String(source || "").trim();
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test(raw) || /\.git(?:[?#].*)?$/i.test(raw);
}

export function resolvePluginInstallRoot({ workspaceDir = process.cwd(), project = false, env = process.env } = {}) {
  if (project) return path.join(path.resolve(workspaceDir), ".piecode", "plugins");
  const configured = String(env.PIECODE_PLUGIN_INSTALL_DIR || "").trim();
  return configured ? path.resolve(workspaceDir, configured) : path.join(os.homedir(), ".piecode", "plugins");
}

async function copyDir(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}

export async function installPlugin({
  source,
  targetRoot,
  name = "",
  project = false,
  workspaceDir = process.cwd(),
  execFile = execFileDefault,
} = {}) {
  const rawSource = String(source || "").trim();
  if (!rawSource) throw new Error("Plugin source is required");
  const pluginName = sanitizeName(name || derivePluginNameFromSource(rawSource));
  if (!pluginName || !VALID_PLUGIN_NAME_RE.test(pluginName)) throw new Error(`Invalid plugin name: ${name || rawSource}`);
  const root = targetRoot ? path.resolve(targetRoot) : resolvePluginInstallRoot({ workspaceDir, project });
  const targetDir = path.join(root, pluginName);
  await fs.mkdir(root, { recursive: true });
  if (await defaultPathExists(targetDir)) throw new Error(`Plugin install target already exists: ${targetDir}`);

  if (isGitPluginSource(rawSource)) {
    await execFile("git", ["clone", "--depth=1", rawSource, targetDir], { maxBuffer: 10 * 1024 * 1024 });
  } else {
    const sourceDir = path.resolve(workspaceDir, rawSource);
    const stat = await fs.stat(sourceDir);
    if (!stat.isDirectory()) throw new Error(`Plugin source must be a directory or git URL: ${rawSource}`);
    await copyDir(sourceDir, targetDir);
  }

  const pluginFile = path.join(targetDir, "PLUGIN.md");
  if (!(await defaultPathExists(pluginFile))) {
    await fs.rm(targetDir, { recursive: true, force: true });
    throw new Error("Installed plugin is missing PLUGIN.md");
  }
  const index = await discoverPlugins([root]);
  const discovered = index.get(pluginName) || [...index.values()].find((plugin) => path.resolve(plugin.baseDir) === path.resolve(targetDir));
  return {
    ok: true,
    name: discovered?.name || pluginName,
    dir: targetDir,
    root,
    path: discovered?.path || pluginFile,
  };
}

export async function updatePlugin({ plugin, execFile = execFileDefault, pathExists = defaultPathExists } = {}) {
  const meta = plugin && typeof plugin === "object" ? plugin : null;
  const baseDir = String(meta?.baseDir || "").trim();
  const name = String(meta?.name || "").trim();
  if (!meta || !baseDir) throw new Error("Plugin metadata with baseDir is required");
  if (!(await pathExists(path.join(baseDir, ".git")))) {
    return { ok: false, name, dir: baseDir, reason: "not-git", message: `Plugin ${name || baseDir} is not git-backed; reinstall from source to update.` };
  }
  const { stdout = "", stderr = "" } = await execFile("git", ["-C", baseDir, "pull", "--ff-only"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { ok: true, name, dir: baseDir, stdout: String(stdout || ""), stderr: String(stderr || "") };
}

export async function updatePlugins({ pluginIndex, names = [], execFile = execFileDefault } = {}) {
  const index = pluginIndex instanceof Map ? pluginIndex : new Map();
  const requested = Array.isArray(names) ? names.map((name) => String(name || "").trim()).filter(Boolean) : [];
  const targets = requested.length === 0 || requested.includes("all")
    ? [...index.values()]
    : requested.map((name) => index.get(name)).filter(Boolean);
  const results = [];
  for (const plugin of targets) {
    results.push(await updatePlugin({ plugin, execFile }));
  }
  return results;
}

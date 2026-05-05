import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isGitRelatedPath } from "./fileMentions.js";

const execFile = promisify(execFileCb);

const DEFAULT_INLINE_MAX = 12000;
const DEFAULT_PREVIEW_MAX = 4000;
const DEFAULT_TOTAL_MAX = 50000;
const DEFAULT_LINE_CONTEXT = 0;
const DEFAULT_MAX_RANGE_LINES = 300;
const DEFAULT_DIR_MAX_ENTRIES = 80;
const DEFAULT_GLOB_MAX_MATCHES = 80;
const DEFAULT_GIT_MAX_CHARS = 12000;
const DEFAULT_MEMORY_MAX_CHARS = 4000;
const DEFAULT_LAST_RUN_MAX_CHARS = 12000;

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "config",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".sqlite",
  ".sqlite3",
  ".db",
]);

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function normalizeMentionPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^@+/, "")
    .replace(/^\.\//, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function normalizeTargetPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^@+/, "")
    .replace(/^\.\//, "")
    .trim();
}

function isBoundaryChar(ch) {
  return !ch || /[\s([{"'`]/.test(ch);
}

function isTerminatorChar(ch) {
  return /[\s@<>]/.test(ch);
}

function parseLineRangeToken(token) {
  const source = String(token || "");
  const match = source.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: normalizeMentionPath(source), range: null };
  const start = Math.max(1, Number.parseInt(match[2], 10));
  const end = Math.max(start, Number.parseInt(match[3] || match[2], 10));
  return {
    path: normalizeMentionPath(match[1]),
    range: { start, end },
  };
}

function classifyMentionToken(rawToken) {
  const token = String(rawToken || "").trim();
  const lower = token.toLowerCase();
  if (lower === "diff") return { kind: "diff", target: "unstaged" };
  if (lower === "diff:staged" || lower === "git:diff:staged") return { kind: "diff", target: "staged" };
  if (lower === "git:status") return { kind: "gitStatus", target: "status" };
  if (lower === "memory") return { kind: "memory", target: "all" };
  if (lower === "memory:project") return { kind: "memory", target: "project" };
  if (lower === "memory:global" || lower === "memory:personal") return { kind: "memory", target: "global" };
  if (lower === "last-run" || lower === "lastrun") return { kind: "lastRun", target: "last-run" };
  if (lower === "workspace") return { kind: "workspace", target: "workspace" };
  if (lower.startsWith("glob:")) return { kind: "glob", target: normalizeTargetPath(token.slice("glob:".length)) };
  if (lower.startsWith("dir:")) return { kind: "dir", target: normalizeMentionPath(token.slice("dir:".length)) };

  const parsed = parseLineRangeToken(token);
  return {
    kind: parsed.range ? "fileRange" : "file",
    target: parsed.path,
    path: parsed.path,
    range: parsed.range,
  };
}

export function parseContextMentions(message) {
  const source = String(message || "");
  const mentions = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "@") continue;
    if (source[i + 1] === "@") continue;
    if (!isBoundaryChar(source[i - 1] || "")) continue;

    let end = i + 1;
    while (end < source.length && !isTerminatorChar(source[end])) end += 1;
    const rawToken = source.slice(i + 1, end);
    const token = rawToken.trim();
    if (!token) continue;
    const classified = classifyMentionToken(token);
    const mentionPath = classified.path || classified.target || "";
    if (!mentionPath && !["diff", "gitStatus", "memory", "lastRun", "workspace"].includes(classified.kind)) continue;
    mentions.push({
      raw: source.slice(i, end),
      token,
      path: classified.path || classified.target || token,
      start: i,
      end,
      ...classified,
    });
  }
  return mentions;
}

export function parseFileMentions(message) {
  return parseContextMentions(message)
    .filter((item) => item.kind === "file" || item.kind === "fileRange")
    .map((item) => ({ raw: item.raw, path: item.path, start: item.start, end: item.end, range: item.range || null }));
}

export function isSensitiveMentionPath(filePath) {
  const normalized = normalizeMentionPath(filePath).toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split("/").filter(Boolean);
  const base = segments[segments.length - 1] || "";
  const ext = path.extname(base);

  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SENSITIVE_BASENAMES.has(base)) {
    // `config` is only considered sensitive in common credential directories.
    if (base !== "config") return true;
    if (segments.some((segment) => [".kube", "kube", ".ssh", "ssh"].includes(segment))) return true;
  }
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  if (/^(secret|secrets|credential|credentials)(\.|-|_|$)/i.test(base)) return true;
  return false;
}

function isInsideWorkspace(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function containsNul(buffer) {
  return buffer.includes(0);
}

function languageForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  const aliases = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
  };
  return aliases[ext] || ext || "text";
}

function codeFenceFor(content) {
  const matches = String(content || "").match(/`+/g) || [];
  const longest = matches.reduce((max, item) => Math.max(max, item.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

async function readPreview(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(1, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function truncateText(text, maxChars) {
  const source = String(text || "");
  const cap = Math.max(1, Number(maxChars) || 1);
  if (source.length <= cap) return { text: source, truncated: false };
  return { text: source.slice(0, Math.max(0, cap - 32)), truncated: true };
}

function renderContentSection({ filePath, mode, size, content, truncated = false }) {
  const fence = codeFenceFor(content);
  const lang = languageForPath(filePath);
  const label = mode === "inline" ? "inlined" : "preview only";
  const lines = [`- ${filePath}: ${label}, ${size} bytes`, `${fence}${lang}`, content, fence];
  if (mode === "preview" || truncated) {
    lines.push("Full file not included because it exceeds the inline/context limit. Use read_file if full content is needed.");
  }
  return lines.join("\n");
}

function renderSkippedSection(filePath, reason) {
  return `- ${filePath}: skipped (${reason})`;
}

function renderTextSection({ label, content, language = "text", truncated = false }) {
  const body = String(content || "").trimEnd() || "(empty)";
  const fence = codeFenceFor(body);
  return [`- ${label}${truncated ? " (truncated)" : ""}`, `${fence}${language}`, body, fence].join("\n");
}

async function resolveMentionPath({ cwd, realCwd, relPath }) {
  const normalized = normalizeMentionPath(relPath);
  if (!normalized) throw new Error("empty path");
  const absPath = path.resolve(cwd, normalized);
  if (!isInsideWorkspace(cwd, absPath)) throw new Error("outside workspace");
  let stat;
  try {
    stat = await fs.lstat(absPath);
  } catch (err) {
    if (String(err?.code || "").toUpperCase() === "ENOENT") throw new Error("not found");
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error("symlink");
  let realPath = absPath;
  try {
    realPath = await fs.realpath(absPath);
  } catch {
    // Fall back to lexical path; read/stat errors are handled by callers.
  }
  if (!isInsideWorkspace(realCwd, realPath)) throw new Error("outside workspace");
  return { normalized, absPath, stat };
}

function shouldSkipFsPath(relPath) {
  const normalized = normalizeMentionPath(relPath);
  if (!normalized) return "empty path";
  if (isGitRelatedPath(normalized)) return "git-related path";
  if (isSensitiveMentionPath(normalized)) return "path looks sensitive";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => IGNORE_DIRS.has(segment))) return "ignored path";
  return "";
}

function renderLineRange({ relPath, content, range, maxRangeLines }) {
  const lines = String(content || "").split("\n");
  const start = Math.max(1, Math.min(lines.length || 1, range?.start || 1));
  const requestedEnd = Math.max(start, range?.end || start);
  const cappedEnd = Math.min(lines.length || start, start + Math.max(1, maxRangeLines) - 1, requestedEnd);
  const selected = lines.slice(start - 1, cappedEnd).map((line, idx) => `${start + idx}: ${line}`).join("\n");
  const truncated = cappedEnd < requestedEnd;
  const label = `${relPath}:${start}${cappedEnd !== start ? `-${cappedEnd}` : ""}: line range${truncated ? ` (requested through ${requestedEnd})` : ""}`;
  return renderTextSection({ label, content: selected, language: languageForPath(relPath), truncated });
}

function globToRegExp(pattern) {
  const source = normalizeTargetPath(pattern || "**/*");
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
    if ("\\^$+?.()|{}[]".includes(ch)) out += `\\${ch}`;
    else out += ch;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

async function walkFiles({ cwd, startAbs, maxScanned = 3000, onFile }) {
  let scanned = 0;
  async function walk(dir) {
    if (scanned >= maxScanned) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scanned >= maxScanned) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      await onFile({ abs, rel });
    }
  }
  await walk(startAbs);
  return scanned;
}

async function renderDirSummary({ cwd, realCwd, target, maxEntries }) {
  const skipReason = shouldSkipFsPath(target);
  if (skipReason) return { section: renderSkippedSection(target, skipReason), status: "skipped", reason: skipReason };
  let resolved;
  try {
    resolved = await resolveMentionPath({ cwd, realCwd, relPath: target });
  } catch (err) {
    const reason = String(err?.message || "unreadable");
    return { section: renderSkippedSection(target, reason), status: "skipped", reason };
  }
  if (!resolved.stat.isDirectory()) {
    return { section: renderSkippedSection(resolved.normalized, "not a directory"), status: "skipped", reason: "not a directory" };
  }
  const rows = [];
  let total = 0;
  try {
    const entries = await fs.readdir(resolved.absPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const childRel = `${resolved.normalized.replace(/\/$/, "")}/${entry.name}`.replace(/^\//, "");
      if (isGitRelatedPath(childRel) || isSensitiveMentionPath(childRel)) continue;
      total += 1;
      if (rows.length >= maxEntries) continue;
      const suffix = entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " -> symlink" : "";
      rows.push(`- ${childRel}${suffix}`);
    }
  } catch (err) {
    return { section: renderSkippedSection(resolved.normalized, `unreadable: ${String(err?.message || err)}`), status: "skipped", reason: "unreadable" };
  }
  const omitted = Math.max(0, total - rows.length);
  const content = [`Directory: ${resolved.normalized}/`, `Entries shown: ${rows.length}${omitted ? ` (${omitted} omitted)` : ""}`, ...rows].join("\n");
  return { section: renderTextSection({ label: `${resolved.normalized}/: directory summary`, content, truncated: omitted > 0 }), status: "summary", reason: omitted > 0 ? "truncated" : "" };
}

async function renderGlobSummary({ cwd, pattern, maxMatches }) {
  const rawPattern = normalizeTargetPath(pattern);
  if (!rawPattern) return { section: renderSkippedSection("glob", "empty pattern"), status: "skipped", reason: "empty pattern" };
  if (path.isAbsolute(rawPattern) || rawPattern.split("/").includes("..")) {
    return { section: renderSkippedSection(`glob:${rawPattern}`, "outside workspace"), status: "skipped", reason: "outside workspace" };
  }
  const matcher = globToRegExp(rawPattern);
  const matches = [];
  const scanned = await walkFiles({
    cwd,
    startAbs: cwd,
    maxScanned: Math.max(1000, maxMatches * 50),
    onFile: async ({ rel }) => {
      if (matches.length >= maxMatches) return;
      if (shouldSkipFsPath(rel)) return;
      if (matcher.test(rel)) matches.push(rel);
    },
  });
  const content = matches.length > 0
    ? [`Pattern: ${rawPattern}`, `Matches shown: ${matches.length}`, `Files scanned: ${scanned}`, ...matches.map((item) => `- ${item}`)].join("\n")
    : `Pattern: ${rawPattern}\nNo matches found.\nFiles scanned: ${scanned}`;
  return { section: renderTextSection({ label: `glob:${rawPattern}: matched paths`, content, truncated: matches.length >= maxMatches }), status: "summary", reason: matches.length >= maxMatches ? "truncated" : "" };
}

async function runGit(cwd, args, maxChars) {
  try {
    const { stdout, stderr } = await execFile("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 * 5 });
    const output = `${stdout || ""}${stderr ? `\nstderr:\n${stderr}` : ""}`.trim() || "(empty)";
    return truncateText(output, maxChars);
  } catch (err) {
    const output = [err?.stdout, err?.stderr || err?.message].filter(Boolean).join("\n").trim();
    return truncateText(output || "git command unavailable", maxChars);
  }
}

async function renderGitMention({ cwd, kind, target, maxChars }) {
  if (kind === "gitStatus") {
    const result = await runGit(cwd, ["status", "--short", "--branch"], maxChars);
    return { section: renderTextSection({ label: "git status", content: result.text, language: "text", truncated: result.truncated }), status: "summary", reason: result.truncated ? "truncated" : "" };
  }
  const staged = target === "staged";
  const args = staged ? ["diff", "--staged", "--"] : ["diff", "--"];
  const result = await runGit(cwd, args, maxChars);
  return { section: renderTextSection({ label: staged ? "git diff staged" : "git diff unstaged", content: result.text, language: "diff", truncated: result.truncated }), status: "summary", reason: result.truncated ? "truncated" : "" };
}

function unwrapMemory(memoryRef) {
  if (!memoryRef) return null;
  if (memoryRef.value && typeof memoryRef.value === "object") return memoryRef.value;
  if (memoryRef.global || memoryRef.project) return memoryRef;
  return null;
}

function renderMemoryMention({ memoryRef, scope, maxChars }) {
  const memory = unwrapMemory(memoryRef);
  if (!memory) {
    return { section: renderSkippedSection(`memory${scope !== "all" ? `:${scope}` : ""}`, "memory not available"), status: "skipped", reason: "memory not available" };
  }
  const scopes = scope === "project" || scope === "global" ? [scope] : ["global", "project"];
  const lines = [];
  for (const itemScope of scopes) {
    const item = memory[itemScope];
    const content = String(item?.content || "").trim();
    if (!content) {
      lines.push(`${itemScope}: (empty)`);
      continue;
    }
    const clipped = truncateText(content, Math.max(200, Math.floor(maxChars / scopes.length)));
    const source = itemScope === "global" ? "~/.piecode/MEMORY.md" : ".piecode/MEMORY.md";
    lines.push(`${itemScope} memory (${source})${clipped.truncated ? " [truncated]" : ""}:\n${clipped.text}`);
  }
  return { section: renderTextSection({ label: `memory${scope !== "all" ? `:${scope}` : ""}`, content: lines.join("\n\n"), language: "markdown" }), status: "summary", reason: "" };
}

async function renderLastRun({ cwd, maxChars }) {
  const shellDir = path.join(cwd, ".piecode", "shell");
  try {
    const entries = await fs.readdir(shellDir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isFile() || !/^result-.*\.txt$/.test(entry.name)) continue;
      const abs = path.join(shellDir, entry.name);
      const stat = await fs.stat(abs);
      candidates.push({ abs, name: entry.name, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    if (!latest) throw new Error("no saved shell result");
    const raw = await fs.readFile(latest.abs, "utf8");
    const clipped = truncateText(raw, maxChars);
    return { section: renderTextSection({ label: `last-run ${latest.name}`, content: clipped.text, language: "text", truncated: clipped.truncated }), status: "summary", reason: clipped.truncated ? "truncated" : "" };
  } catch (err) {
    return { section: renderSkippedSection("last-run", String(err?.message || "not available")), status: "skipped", reason: String(err?.message || "not available") };
  }
}

async function renderWorkspace({ cwd, maxEntries, maxChars }) {
  const rows = [];
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (rows.length >= maxEntries) break;
      rows.push(`- ${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
  } catch {
    // Keep partial workspace summary.
  }
  let packageSummary = "";
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
    const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts).sort() : [];
    const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies).length : 0;
    const devDeps = pkg?.devDependencies && typeof pkg.devDependencies === "object" ? Object.keys(pkg.devDependencies).length : 0;
    packageSummary = [`package: ${pkg.name || "(unnamed)"}`, scripts.length ? `scripts: ${scripts.join(", ")}` : "scripts: none", `dependencies: ${deps}, devDependencies: ${devDeps}`].join("\n");
  } catch {
    packageSummary = "package: unavailable";
  }
  const git = await runGit(cwd, ["status", "--short", "--branch"], 2000);
  const content = [`Workspace: ${path.basename(cwd)} (${cwd})`, packageSummary, "Top-level entries:", ...rows, "", "Git status:", git.text].join("\n");
  const clipped = truncateText(content, maxChars);
  return { section: renderTextSection({ label: "workspace summary", content: clipped.text, language: "text", truncated: clipped.truncated }), status: "summary", reason: clipped.truncated ? "truncated" : "" };
}

export async function buildFileMentionContext(userMessage, options = {}) {
  const originalMessage = String(userMessage || "");
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  let realCwd = cwd;
  try {
    realCwd = await fs.realpath(cwd);
  } catch {
    // Keep the resolved cwd if realpath is unavailable.
  }
  const inlineMax = toPositiveInt(options.inlineMax ?? process.env.PIECODE_MENTION_INLINE_MAX, DEFAULT_INLINE_MAX);
  const previewMax = toPositiveInt(options.previewMax ?? process.env.PIECODE_MENTION_PREVIEW_MAX, DEFAULT_PREVIEW_MAX);
  const totalMax = toPositiveInt(options.totalMax ?? process.env.PIECODE_MENTION_TOTAL_MAX, DEFAULT_TOTAL_MAX);
  const lineContext = Math.max(0, toPositiveInt(options.lineContext ?? process.env.PIECODE_MENTION_LINE_CONTEXT, DEFAULT_LINE_CONTEXT));
  const maxRangeLines = toPositiveInt(options.maxRangeLines ?? process.env.PIECODE_MENTION_MAX_RANGE_LINES, DEFAULT_MAX_RANGE_LINES);
  const dirMaxEntries = toPositiveInt(options.dirMaxEntries ?? process.env.PIECODE_MENTION_DIR_MAX_ENTRIES, DEFAULT_DIR_MAX_ENTRIES);
  const globMaxMatches = toPositiveInt(options.globMaxMatches ?? process.env.PIECODE_MENTION_GLOB_MAX_MATCHES, DEFAULT_GLOB_MAX_MATCHES);
  const gitMaxChars = toPositiveInt(options.gitMaxChars ?? process.env.PIECODE_MENTION_GIT_MAX_CHARS, DEFAULT_GIT_MAX_CHARS);
  const memoryMaxChars = toPositiveInt(options.memoryMaxChars ?? process.env.PIECODE_MENTION_MEMORY_MAX_CHARS, DEFAULT_MEMORY_MAX_CHARS);
  const lastRunMaxChars = toPositiveInt(options.lastRunMaxChars ?? process.env.PIECODE_MENTION_LAST_RUN_MAX_CHARS, DEFAULT_LAST_RUN_MAX_CHARS);
  const parsedMentions = parseContextMentions(originalMessage);
  if (parsedMentions.length === 0) {
    return { prompt: originalMessage, originalMessage, mentions: [] };
  }

  const seen = new Set();
  const sections = [];
  const mentions = [];
  let injectedChars = 0;

  const addSection = (section) => {
    const remaining = Math.max(0, totalMax - injectedChars);
    if (remaining <= 0) return false;
    const clipped = truncateText(section, remaining);
    sections.push(clipped.truncated ? `${clipped.text}\n[truncated: mention context budget exhausted]` : clipped.text);
    injectedChars += Math.min(section.length, remaining);
    return true;
  };

  for (const parsed of parsedMentions) {
    const dedupeKey = `${parsed.kind}:${parsed.target || parsed.path}:${parsed.range ? `${parsed.range.start}-${parsed.range.end}` : ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const mention = { path: parsed.path || parsed.target || parsed.token, kind: parsed.kind, status: "", reason: "", size: 0 };
    if (parsed.range) mention.range = parsed.range;
    mentions.push(mention);

    const addSkipped = (reason) => {
      mention.status = "skipped";
      mention.reason = reason;
      addSection(renderSkippedSection(mention.path, reason));
    };

    if (injectedChars >= totalMax) {
      addSkipped("context limit reached");
      continue;
    }

    if (parsed.kind === "dir") {
      const rendered = await renderDirSummary({ cwd, realCwd, target: parsed.target, maxEntries: dirMaxEntries });
      mention.status = rendered.status;
      mention.reason = rendered.reason;
      addSection(rendered.section);
      continue;
    }

    if (parsed.kind === "glob") {
      const rendered = await renderGlobSummary({ cwd, pattern: parsed.target, maxMatches: globMaxMatches });
      mention.status = rendered.status;
      mention.reason = rendered.reason;
      addSection(rendered.section);
      continue;
    }

    if (parsed.kind === "diff" || parsed.kind === "gitStatus") {
      const rendered = await renderGitMention({ cwd, kind: parsed.kind, target: parsed.target, maxChars: gitMaxChars });
      mention.status = rendered.status;
      mention.reason = rendered.reason;
      addSection(rendered.section);
      continue;
    }

    if (parsed.kind === "memory") {
      const rendered = renderMemoryMention({ memoryRef: options.memoryRef || options.memory, scope: parsed.target || "all", maxChars: memoryMaxChars });
      mention.status = rendered.status;
      mention.reason = rendered.reason;
      addSection(rendered.section);
      continue;
    }

    if (parsed.kind === "lastRun") {
      const rendered = await renderLastRun({ cwd, maxChars: lastRunMaxChars });
      mention.status = rendered.status;
      mention.reason = rendered.reason;
      addSection(rendered.section);
      continue;
    }

    if (parsed.kind === "workspace") {
      const rendered = await renderWorkspace({ cwd, maxEntries: dirMaxEntries, maxChars: Math.min(totalMax, 16000) });
      mention.status = rendered.status;
      mention.reason = rendered.reason;
      addSection(rendered.section);
      continue;
    }

    const relPath = normalizeMentionPath(parsed.path);
    mention.path = relPath;
    if (!relPath) {
      addSkipped("empty path");
      continue;
    }
    const skipReason = shouldSkipFsPath(relPath);
    if (skipReason) {
      addSkipped(skipReason);
      continue;
    }

    let resolved;
    try {
      resolved = await resolveMentionPath({ cwd, realCwd, relPath });
    } catch (err) {
      addSkipped(String(err?.message || "not found"));
      continue;
    }
    const { absPath, stat } = resolved;
    if (!stat.isFile()) {
      addSkipped(stat.isDirectory() ? "directory" : "not a regular file");
      continue;
    }

    mention.size = stat.size;
    const remaining = Math.max(0, totalMax - injectedChars);
    if (remaining <= 0) {
      addSkipped("context limit reached");
      continue;
    }

    try {
      if (parsed.range) {
        const buffer = await fs.readFile(absPath);
        if (containsNul(buffer)) {
          addSkipped("binary file");
          continue;
        }
        const content = buffer.toString("utf8");
        const range = {
          start: Math.max(1, parsed.range.start - lineContext),
          end: parsed.range.end + lineContext,
        };
        mention.status = "inline";
        addSection(renderLineRange({ relPath, content, range, maxRangeLines }));
      } else if (stat.size <= inlineMax && stat.size <= remaining) {
        const buffer = await fs.readFile(absPath);
        if (containsNul(buffer)) {
          addSkipped("binary file");
          continue;
        }
        const content = buffer.toString("utf8");
        mention.status = "inline";
        injectedChars += content.length;
        sections.push(renderContentSection({ filePath: relPath, mode: "inline", size: stat.size, content }));
      } else {
        const maxBytes = Math.max(1, Math.min(previewMax, remaining));
        const buffer = await readPreview(absPath, maxBytes);
        if (containsNul(buffer)) {
          addSkipped("binary file");
          continue;
        }
        let content = buffer.toString("utf8");
        if (content.length > remaining) content = content.slice(0, remaining);
        mention.status = "preview";
        mention.reason = stat.size > inlineMax ? "file exceeds inline limit" : "context limit reached";
        injectedChars += content.length;
        sections.push(renderContentSection({ filePath: relPath, mode: "preview", size: stat.size, content, truncated: true }));
      }
    } catch (err) {
      addSkipped(`unreadable: ${String(err?.message || err)}`);
    }
  }

  if (sections.length === 0) {
    return { prompt: originalMessage, originalMessage, mentions };
  }

  const prompt = [
    "Referenced file context:",
    sections.join("\n\n"),
    "",
    "Original user message:",
    originalMessage,
  ].join("\n");

  return { prompt, originalMessage, mentions };
}

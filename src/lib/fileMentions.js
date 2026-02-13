import path from "node:path";

const GIT_RELATED_BASENAMES = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitkeep",
]);

function clampCursor(text, cursor) {
  const value = Number.isFinite(cursor) ? Math.floor(cursor) : text.length;
  return Math.max(0, Math.min(text.length, value));
}

function countPathDepth(filePath) {
  return String(filePath || "")
    .split("/")
    .filter(Boolean).length;
}

function subsequenceScore(candidate, query) {
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let i = 0; i < candidate.length && qi < query.length; i += 1) {
    if (candidate[i] !== query[qi]) continue;
    if (firstMatch < 0) firstMatch = i;
    lastMatch = i;
    qi += 1;
  }
  if (qi !== query.length) return -1;
  const span = lastMatch - firstMatch + 1;
  return 450 - span - Math.max(0, firstMatch);
}

export function isGitRelatedPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return false;
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) => GIT_RELATED_BASENAMES.has(segment.toLowerCase()));
}

export function parseActiveFileMention(line, cursor = null) {
  const source = String(line || "");
  const safeCursor = clampCursor(source, cursor);
  const left = source.slice(0, safeCursor);
  const match = left.match(/(?:^|[\s([{"'`])@([^\s@]*)$/);
  if (!match) return null;
  const query = String(match[1] || "");
  const start = left.length - query.length - 1;
  const right = source.slice(safeCursor);
  const rightMatch = right.match(/^[^\s@]*/);
  const end = safeCursor + (rightMatch?.[0]?.length || 0);
  if (start < 0 || source[start] !== "@") return null;
  return { query, start, end, cursor: safeCursor };
}

export function scoreFilePath(candidatePath, query) {
  const normalizedPath = String(candidatePath || "").replace(/\\/g, "/");
  const q = String(query || "").toLowerCase().trim();
  if (!normalizedPath || isGitRelatedPath(normalizedPath)) return -1;
  if (!q) {
    return 240 - countPathDepth(normalizedPath) * 4 - Math.min(120, normalizedPath.length);
  }

  const pathLower = normalizedPath.toLowerCase();
  const baseLower = path.basename(pathLower);
  if (pathLower === q) return 1000;
  if (baseLower === q) return 980;

  if (baseLower.startsWith(q)) {
    return 930 - (baseLower.length - q.length);
  }

  const baseContains = baseLower.indexOf(q);
  if (baseContains >= 0) return 860 - baseContains - (baseLower.length - q.length);

  const pathContains = pathLower.indexOf(q);
  if (pathContains >= 0) return 790 - Math.min(120, pathContains) - Math.max(0, normalizedPath.length - q.length);

  return subsequenceScore(pathLower, q);
}

export function getFileMentionSuggestions(line, cursor, filePaths, max = 8) {
  const mention = parseActiveFileMention(line, cursor);
  if (!mention) return { mention: null, suggestions: [] };
  const candidates = Array.isArray(filePaths) ? filePaths : [];
  const scored = candidates
    .map((filePath) => {
      const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
      const score = scoreFilePath(normalized, mention.query);
      return { filePath: normalized, score };
    })
    .filter((item) => item.filePath && item.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.filePath.length !== b.filePath.length) return a.filePath.length - b.filePath.length;
      return a.filePath.localeCompare(b.filePath);
    });

  const limit = Math.max(1, Math.min(50, Number(max) || 8));
  return {
    mention,
    suggestions: scored.slice(0, limit).map((item) => item.filePath),
  };
}

export function applyFileMentionSelection(line, cursor, selectedPath) {
  const mention = parseActiveFileMention(line, cursor);
  const chosen = String(selectedPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!mention || !chosen) return null;
  const source = String(line || "");
  const before = source.slice(0, mention.start);
  const after = source.slice(mention.end);
  const nextMention = `@${chosen}`;
  return {
    line: `${before}${nextMention}${after}`,
    cursor: before.length + nextMention.length,
    mention: { start: mention.start, end: mention.end },
  };
}

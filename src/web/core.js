import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

export const DIFF_MAX_CHARS = 1_200_000;

const execFileAsync = promisify(execFileCb);

export function clipText(value, max = 20000) {
  const text = String(value || "");
  const limit = Math.max(500, Number(max) || 20000);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[clipped ${text.length - limit} chars]`;
}

export function clipDiffText(value, max = DIFF_MAX_CHARS) {
  const text = String(value || "");
  const limit = Math.max(10000, Number(max) || DIFF_MAX_CHARS);
  if (text.length <= limit) return { text, truncated: false, omittedChars: 0 };
  return {
    text: `${text.slice(0, limit)}\n\n[diff truncated: ${text.length - limit} chars omitted]`,
    truncated: true,
    omittedChars: text.length - limit,
  };
}

async function runGit(workspaceDir, args, execFile = execFileAsync) {
  const { stdout } = await execFile("git", args, {
    cwd: workspaceDir,
    encoding: "utf8",
    maxBuffer: DIFF_MAX_CHARS + 512000,
  });
  return String(stdout || "");
}

export async function getSessionDiff(workspaceDir, options = {}) {
  const execFile = options.execFile || execFileAsync;
  try {
    await runGit(workspaceDir, ["rev-parse", "--is-inside-work-tree"], execFile);
  } catch {
    return {
      ok: false,
      error: "Workspace is not a git repository.",
      diff: "",
      stagedDiff: "",
      unstagedDiff: "",
      untrackedFiles: [],
      truncated: false,
      generatedAt: new Date().toISOString(),
    };
  }

  try {
    const [stagedDiffRaw, unstagedDiffRaw, untrackedRaw] = await Promise.all([
      runGit(workspaceDir, ["diff", "--cached", "--no-ext-diff", "--"], execFile),
      runGit(workspaceDir, ["diff", "--no-ext-diff", "--"], execFile),
      runGit(workspaceDir, ["ls-files", "--others", "--exclude-standard"], execFile),
    ]);
    const untrackedFiles = untrackedRaw.split("\n").map((item) => item.trim()).filter(Boolean);
    const sections = [];
    if (stagedDiffRaw.trim()) sections.push("# Staged changes\n", stagedDiffRaw.trimEnd());
    if (unstagedDiffRaw.trim()) sections.push("# Unstaged changes\n", unstagedDiffRaw.trimEnd());
    if (untrackedFiles.length > 0) {
      sections.push("# Untracked files\n", untrackedFiles.map((file) => `?? ${file}`).join("\n"));
    }
    const clipped = clipDiffText(sections.join("\n\n"));
    return {
      ok: true,
      diff: clipped.text,
      stagedDiff: clipDiffText(stagedDiffRaw, Math.floor(DIFF_MAX_CHARS / 2)).text,
      unstagedDiff: clipDiffText(unstagedDiffRaw, Math.floor(DIFF_MAX_CHARS / 2)).text,
      untrackedFiles,
      truncated: clipped.truncated,
      omittedChars: clipped.omittedChars,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || "Unable to load git diff."),
      diff: "",
      stagedDiff: "",
      unstagedDiff: "",
      untrackedFiles: [],
      truncated: false,
      generatedAt: new Date().toISOString(),
    };
  }
}

export function parseToolResultDetails(tool, result) {
  const raw = String(result || "");
  const details = {
    kind: "text",
    preview: clipText(raw, 4000),
    expandable: false,
  };

  if (tool === "edit_file") {
    try {
      const parsed = JSON.parse(raw);
      const diff = String(parsed?.details?.diff || "");
      return {
        kind: "file_edit",
        path: String(parsed?.path || ""),
        changed: Boolean(parsed?.changed),
        message: String(parsed?.message || ""),
        diffStat: String(parsed?.details?.diffStat || ""),
        diff: clipText(diff, 30000),
        expandable: Boolean(diff),
        preview: String(parsed?.message || parsed?.details?.diffStat || raw).trim(),
      };
    } catch {
      return details;
    }
  }

  if (tool === "replace_in_files") {
    try {
      const parsed = JSON.parse(raw);
      return {
        kind: "bulk_replace",
        mode: String(parsed?.mode || ""),
        path: String(parsed?.path || ""),
        scannedFiles: Number(parsed?.scanned_files || 0),
        matchedFiles: Number(parsed?.matched_files || 0),
        replacements: Number(parsed?.replacements || 0),
        files: Array.isArray(parsed?.files) ? parsed.files.slice(0, 200) : [],
        expandable: Array.isArray(parsed?.files) && parsed.files.length > 0,
        preview: `${parsed?.mode || "replace"}: ${parsed?.matched_files || 0} file(s), ${parsed?.replacements || 0} replacement(s)`,
      };
    } catch {
      return details;
    }
  }

  if (tool === "write_file" || tool === "apply_patch") {
    return {
      ...details,
      kind: "file_write",
      expandable: raw.length > 0,
    };
  }

  return details;
}

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_HOOK_TIMEOUT_MS = 600000;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

const TOOL_ALIASES = {
  shell: ["shell", "Bash"],
  run_tests: ["run_tests", "Bash"],
  git_status: ["git_status", "Bash"],
  git_diff: ["git_diff", "Bash"],
  read_file: ["read_file", "Read"],
  read_files: ["read_files", "Read"],
  write_file: ["write_file", "Write"],
  edit_file: ["edit_file", "Edit"],
  apply_patch: ["apply_patch", "Edit", "Write"],
  replace_in_files: ["replace_in_files", "Edit", "Write"],
  list_files: ["list_files", "Glob"],
  glob_files: ["glob_files", "Glob"],
  find_files: ["find_files", "Glob"],
  rg: ["rg", "Grep"],
  grep: ["grep", "Grep"],
  search_files: ["search_files", "Grep"],
  web_search: ["web_search", "WebSearch"],
  search_web: ["search_web", "WebSearch"],
  subagent: ["subagent", "Agent"],
  collaborate: ["collaborate", "Agent"],
  clarify_user: ["clarify_user", "AskUserQuestion"],
  todo_write: ["todo_write", "TodoWrite"],
  todowrite: ["todowrite", "TodoWrite"],
  memory_write: ["memory_write", "Write"],
  remember: ["remember", "Write"],
};

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function getHookToolNames(tool) {
  const raw = String(tool || "").trim();
  return unique([...(TOOL_ALIASES[raw] || []), raw]);
}

function canonicalHookToolName(tool) {
  return getHookToolNames(tool).find((name) => /^[A-Z]/.test(name)) || String(tool || "");
}

function matcherMatchesTool(matcher, tool) {
  const text = String(matcher ?? "").trim();
  if (!text || text === "*") return true;
  const names = getHookToolNames(tool);
  try {
    const regex = new RegExp(text);
    return names.some((name) => regex.test(name));
  } catch {
    const allowed = text.split("|").map((item) => item.trim()).filter(Boolean);
    return names.some((name) => allowed.includes(name));
  }
}

function eventGroups(plugin, event) {
  const hooks = plugin?.hooks && typeof plugin.hooks === "object" ? plugin.hooks : {};
  const value = hooks[event] || hooks[event.toLowerCase()] || hooks[event.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, "")];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function matchingHandlers(plugin, event, tool) {
  const out = [];
  for (const group of eventGroups(plugin, event)) {
    if (!group || typeof group !== "object") continue;
    if (!matcherMatchesTool(group.matcher, tool)) continue;
    const handlers = Array.isArray(group.hooks) ? group.hooks : group.command ? [group] : [];
    for (const handler of handlers) {
      if (!handler || typeof handler !== "object") continue;
      out.push({ group, handler });
    }
  }
  return out;
}

function parsePositiveTimeoutMs(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  // Claude/Codex hook configs express timeout in seconds.
  return Math.max(1, Math.round(raw * 1000));
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function coerceUpdatedToolOutput(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if ("stdout" in value || "stderr" in value) {
      const lines = [];
      if (value.stdout != null) lines.push(String(value.stdout));
      if (value.stderr != null && String(value.stderr)) lines.push(String(value.stderr));
      return lines.join("\n");
    }
    return safeStringify(value);
  }
  return String(value);
}

function appendHookContext(result, pluginName, contexts = []) {
  const clean = contexts.map((item) => String(item || "").trim()).filter(Boolean);
  if (clean.length === 0) return result;
  return `${String(result ?? "")}\n\n[HOOK CONTEXT from ${pluginName}]\n${clean.join("\n")}`;
}

function parseJsonStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function runCommand(command, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_HOOK_OUTPUT_BYTES) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_HOOK_OUTPUT_BYTES) stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || error.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : timedOut ? 124 : 1, stdout, stderr, timedOut });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function ensurePluginDataDir(workspaceDir, plugin) {
  const dir = path.join(path.resolve(workspaceDir || process.cwd()), ".piecode", "plugin-data", String(plugin?.name || "plugin"));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function runCommandHook({ plugin, handler, hookInput, workspaceDir }) {
  const command = String(handler.command || "").trim();
  if (!command) return { status: "skipped", output: {}, message: "missing command" };
  const pluginRoot = path.resolve(plugin?.baseDir || path.dirname(plugin?.path || workspaceDir || process.cwd()));
  const pluginData = await ensurePluginDataDir(workspaceDir, plugin);
  const env = {
    ...process.env,
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: pluginData,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  const timeoutMs = parsePositiveTimeoutMs(handler.timeout);
  const run = await runCommand(command, { cwd: workspaceDir, env, input: hookInput, timeoutMs });
  if (run.timedOut) return { status: "error", output: {}, message: `hook timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (run.code === 2) {
    return {
      status: "ok",
      output: { decision: "block", reason: String(run.stderr || "Blocked by hook.").trim() || "Blocked by hook." },
      message: "blocked by exit code 2",
    };
  }
  if (run.code !== 0) return { status: "error", output: {}, message: String(run.stderr || `exit ${run.code}`).trim() };
  try {
    return { status: "ok", output: parseJsonStdout(run.stdout), message: "" };
  } catch (error) {
    return { status: "error", output: {}, message: `invalid JSON hook output: ${error.message}` };
  }
}

function getSpecificOutput(output, event) {
  const specific = output?.hookSpecificOutput && typeof output.hookSpecificOutput === "object" ? output.hookSpecificOutput : {};
  const hookEventName = String(specific.hookEventName || "").trim();
  if (hookEventName && hookEventName !== event) return {};
  return specific;
}

function collectAdditionalContext(output, specific) {
  return [output?.additionalContext, specific?.additionalContext].map((item) => String(item || "").trim()).filter(Boolean);
}

function applyPreOutput(state, output, pluginName) {
  const specific = getSpecificOutput(output, "PreToolUse");
  const decision = String(specific.permissionDecision || output?.decision || "").trim().toLowerCase();
  const reason = String(specific.permissionDecisionReason || output?.reason || "").trim();
  const contexts = collectAdditionalContext(output, specific);
  state.additionalContext.push(...contexts);
  state.additionalContextDetails.push(...contexts.map((text) => ({ plugin: pluginName, text })));

  if (decision === "deny" || decision === "block") {
    state.blocked = true;
    state.reason = reason || "Tool call blocked by plugin hook.";
    return state;
  }

  const updatedInput = specific.updatedInput;
  if ((decision === "allow" || decision === "ask" || !decision) && updatedInput && typeof updatedInput === "object" && !Array.isArray(updatedInput)) {
    state.input = updatedInput;
    state.modifiedInput = true;
  }
  return state;
}

function applyPostOutput(state, output, pluginName) {
  const specific = getSpecificOutput(output, "PostToolUse");
  const contexts = collectAdditionalContext(output, specific);
  const replacement = specific.updatedToolOutput ?? specific.updatedResult ?? output?.updatedToolOutput ?? output?.updatedResult;
  const coerced = coerceUpdatedToolOutput(replacement);
  if (coerced != null) {
    state.result = coerced;
    state.modifiedResult = true;
  }

  const decision = String(output?.decision || specific?.decision || "").trim().toLowerCase();
  if (decision === "block" && output?.reason) {
    state.result = String(output.reason);
    state.modifiedResult = true;
  }
  if (output?.continue === false) {
    state.result = String(output.stopReason || output.reason || "Stopped by plugin hook.");
    state.modifiedResult = true;
  }
  if (contexts.length > 0) {
    state.result = appendHookContext(state.result, pluginName, contexts);
    state.modifiedResult = true;
  }
  return state;
}

export async function runPluginToolHooks({
  event,
  plugins = [],
  tool,
  input = {},
  result = null,
  error = null,
  workspaceDir = process.cwd(),
  callId = "",
  turnId = "",
  model = "",
  onEvent = null,
} = {}) {
  const active = Array.isArray(plugins) ? plugins : [];
  const hookInputBase = {
    session_id: "piecode",
    transcript_path: null,
    cwd: path.resolve(workspaceDir || process.cwd()),
    hook_event_name: event,
    model: String(model || ""),
    turn_id: String(turnId || ""),
    tool_name: canonicalHookToolName(tool),
    piecode_tool_name: String(tool || ""),
    tool_use_id: String(callId || ""),
    tool_input: input && typeof input === "object" ? input : {},
  };

  const state = event === "PreToolUse"
    ? { input: hookInputBase.tool_input, blocked: false, reason: "", additionalContext: [], additionalContextDetails: [], modifiedInput: false }
    : { result, error, modifiedResult: false };

  for (const plugin of active) {
    for (const { handler } of matchingHandlers(plugin, event, tool)) {
      if (handler.type && String(handler.type).toLowerCase() !== "command") {
        onEvent?.({ type: "plugin_tool_hook", event, plugin: plugin.name, status: "skipped", message: `unsupported hook type: ${handler.type}` });
        continue;
      }
      const hookInput = {
        ...hookInputBase,
        tool_input: event === "PreToolUse" ? state.input : hookInputBase.tool_input,
        ...(event === "PostToolUse" ? { tool_response: state.result, tool_error: error } : {}),
      };
      let run;
      try {
        run = await runCommandHook({ plugin, handler, hookInput, workspaceDir });
      } catch (error) {
        run = { status: "error", output: {}, message: String(error?.message || "hook execution failed") };
      }
      onEvent?.({
        type: "plugin_tool_hook",
        event,
        plugin: plugin.name,
        status: run.status,
        message: run.message || "",
      });
      if (run.status !== "ok") continue;
      if (event === "PreToolUse") applyPreOutput(state, run.output, plugin.name);
      else if (event === "PostToolUse") applyPostOutput(state, run.output, plugin.name);
    }
  }

  return state;
}

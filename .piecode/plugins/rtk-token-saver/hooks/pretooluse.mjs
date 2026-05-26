#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isShellTool(payload) {
  const toolName = String(payload?.tool_name || payload?.piecode_tool_name || "");
  return toolName === "Bash" || toolName === "shell";
}

async function rewriteCommand(command) {
  try {
    const { stdout } = await execFileAsync("rtk", ["rewrite", command], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 3000,
    });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

async function main() {
  let payload = {};
  try {
    const input = (await readStdin()).trim();
    if (!input) return;
    payload = JSON.parse(input);
  } catch {
    return;
  }

  if (String(payload?.hook_event_name || "") !== "PreToolUse") return;
  if (!isShellTool(payload)) return;

  const toolInput = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const command = String(toolInput.command || "").trim();
  if (!command || /^rtk\b/.test(command) || /(^|\s)RTK_DISABLED=1\b/.test(command)) return;

  const rewritten = await rewriteCommand(command);
  if (!rewritten || rewritten === command) return;

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecisionReason: `RTK rewrite: ${command} -> ${rewritten}`,
      updatedInput: {
        ...toolInput,
        command: rewritten,
      },
      additionalContext: `RTK rewrote the shell command to reduce token usage: ${command} -> ${rewritten}`,
    },
  });
}

main().catch(() => {
  // Fail open: hooks must never break tool execution.
});

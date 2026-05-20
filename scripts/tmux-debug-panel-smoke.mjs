#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 15000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  }
}

const tmuxVersion = run("tmux", ["-V"]);
requireOk(tmuxVersion, "tmux -V");

const session = `piecode-debug-smoke-${process.pid}`;
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "piecode-debug-panel-"));
const scriptPath = path.join(tmpDir, "debug-panel-fixture.mjs");

const fixture = `
import { SimpleTui } from ${JSON.stringify(path.resolve("src/lib/tui.js"))};
const out = process.stdout;
out.columns = Number(process.env.COLUMNS || 100);
out.rows = Number(process.env.LINES || 28);
const tui = new SimpleTui({
  out,
  workspaceDir: process.cwd(),
  providerLabel: () => "tmux-smoke:model",
  getSkillsLabel: () => "none",
  getApprovalLabel: () => "off",
});
tui.start();
tui.openOverlay("LLM Debug 1/1", [
  "## LLM Debug Dump",
  "",
  "Entry: 1/1 · stage=turn · provider=smoke · model=debug-model",
  "Overview: request 128 chars · thinking 14 chars · response 256 chars · usage: in=10 out=20 total=30",
  "Sections: Request · Thinking Output · Response Key Content · Response Raw",
  "",
  "Request: stage=turn provider=smoke model=debug-model endpoint=local",
  "~~~text",
  "{\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"debug panel smoke\\\"}]}",
  "~~~",
  "",
  "Thinking Output:",
  "~~~text",
  "checking panel",
  "~~~",
  "",
  "Response: stage=turn provider=smoke model=debug-model endpoint=local",
  "",
  "Response Key Content:",
  "- usage: in=10 out=20 total=30",
  "- content:",
  "~~~text",
  "smoke response body",
  "~~~",
  "",
  "Response Raw:",
  "~~~text",
  "{\\\"ok\\\":true,\\\"content\\\":\\\"smoke response body\\\"}",
  "~~~",
].join("\\n"), { mode: "llm-debug" });
setTimeout(() => {}, 30000);
`;
writeFileSync(scriptPath, fixture, "utf8");

try {
  requireOk(run("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "28", "node", scriptPath]), "tmux new-session");
  run("tmux", ["send-keys", "-t", session, "C-n"]);
  run("tmux", ["send-keys", "-t", session, "C-n"]);
  run("tmux", ["send-keys", "-t", session, "C-f"]);
  const capture = run("tmux", ["capture-pane", "-p", "-e", "-t", session]);
  requireOk(capture, "tmux capture-pane");
  const plain = String(capture.stdout || "").replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/g, "");
  const required = [
    "LLM Debug 1/1",
    "Overview:",
    "section:",
    "sections:",
    "Request",
    "Thinking",
    "Response",
    "ctrl-n/p: section",
    "LLM debug",
  ];
  const missing = required.filter((needle) => !plain.includes(needle));
  if (missing.length > 0) {
    throw new Error(`tmux debug panel smoke missing: ${missing.join(", ")}\n--- capture ---\n${plain}`);
  }
  console.log("tmux debug panel smoke passed");
} finally {
  run("tmux", ["kill-session", "-t", session], { timeout: 5000 });
  rmSync(tmpDir, { recursive: true, force: true });
}

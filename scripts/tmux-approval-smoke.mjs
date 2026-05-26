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

const session = `piecode-approval-smoke-${process.pid}`;
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "piecode-approval-"));
const scriptPath = path.join(tmpDir, "approval-fixture.mjs");

const fixture = `
import { SimpleTui } from ${JSON.stringify(path.resolve("src/lib/tui.js"))};
const out = process.stdout;
out.columns = Number(process.env.COLUMNS || 80);
out.rows = Number(process.env.LINES || 16);
const tui = new SimpleTui({
  out,
  workspaceDir: process.cwd(),
  providerLabel: () => "tmux-smoke:model",
  getSkillsLabel: () => "none",
  getApprovalLabel: () => "off",
});
tui.start();
tui.setApprovalPrompt("shell: python3 -c \\\"print('approval smoke')\\\" (command is neither known safe nor explicitly dangerous)", false, {
  question: "Approve shell command?",
  command: "python3 -c \\\"print('approval smoke')\\\"",
  reason: "command is neither known safe nor explicitly dangerous",
  risk: "unclassified",
});
setTimeout(() => {}, 30000);
`;
writeFileSync(scriptPath, fixture, "utf8");

try {
  requireOk(run("tmux", ["new-session", "-d", "-s", session, "-x", "80", "-y", "16", "node", scriptPath]), "tmux new-session");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const capture = run("tmux", ["capture-pane", "-p", "-e", "-t", session]);
  requireOk(capture, "tmux capture-pane");
  const plain = String(capture.stdout || "").replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[%()][ -~])/g, "");
  const required = [
    "approval required UNCLASSIFIED",
    "action: Approve shell command?",
    "command: python3 -c",
    "why: command is neither known safe nor explicitly dangerous",
    "choose: y=allow once",
    "r=remember exact command",
    "a=allow all this session",
    "n=deny",
    "enter=deny",
    "Awaiting approval",
  ];
  const missing = required.filter((needle) => !plain.includes(needle));
  if (missing.length > 0) {
    throw new Error(`tmux approval smoke missing: ${missing.join(", ")}\n--- capture ---\n${plain}`);
  }
  console.log("tmux approval smoke passed");
} finally {
  run("tmux", ["kill-session", "-t", session], { timeout: 5000 });
  rmSync(tmpDir, { recursive: true, force: true });
}

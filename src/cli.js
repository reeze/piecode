#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "./lib/agent.js";
import { getProvider } from "./lib/providers.js";

const HISTORY_MAX = 500;

function getSettingsFilePath() {
  const configured = process.env.PIECODE_SETTINGS_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode", "settings.json");
}

async function loadSettings(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function resolveProviderOptions(args, settings) {
  const provider = args.provider || settings.provider || null;
  const providerSettings =
    provider && settings.providers && typeof settings.providers === "object"
      ? settings.providers[provider] || {}
      : {};

  const model =
    args.model ||
    settings.model ||
    providerSettings.model ||
    null;

  const endpoint =
    args.baseUrl ||
    settings.endpoint ||
    settings.baseUrl ||
    providerSettings.endpoint ||
    providerSettings.baseUrl ||
    null;

  const apiKey =
    args.apiKey ||
    settings.apiKey ||
    providerSettings.apiKey ||
    null;

  return {
    provider,
    apiKey,
    model,
    baseUrl: endpoint,
    endpoint,
  };
}

function getHistoryFilePath() {
  const configured = process.env.PIECODE_HISTORY_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".piecode_history");
}

async function loadHistory(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const deduped = [];
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const item = lines[i];
      if (!seen.has(item)) {
        seen.add(item);
        deduped.push(item);
      }
      if (deduped.length >= HISTORY_MAX) break;
    }
    return deduped;
  } catch {
    return [];
  }
}

async function saveHistory(filePath, history) {
  const normalized = Array.isArray(history)
    ? history.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const oldestToNewest = [...normalized].reverse().slice(-HISTORY_MAX);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${oldestToNewest.join("\n")}\n`, "utf8");
}

function printHelp() {
  console.log(`piecode - CLI coding agent

Usage:
  piecode
  piecode --prompt "fix failing test"
  piecode --provider anthropic --api-key "sk-ant-..." --model "claude-3-5-sonnet-latest"
  piecode --help

Options:
  --prompt, -p         One-shot prompt to run
  --help, -h           Show this help
  --provider, -P       Model provider: anthropic, openai, codex, seed
  --api-key, -K        API key for the provider
  --model, -M          Model name to use
  --base-url, -B       Base URL for OpenAI-compatible endpoints (default: https://api.openai.com/v1)
  --disable-codex      Disable Codex CLI and auth file fallback (equivalent to PIECODE_DISABLE_CODEX_CLI=1)

Environment:
  ANTHROPIC_API_KEY    Preferred provider
  ANTHROPIC_MODEL      Optional (default claude-3-5-sonnet-latest)

  OPENAI_API_KEY       OpenAI-compatible fallback
  OPENAI_BASE_URL      Optional (default https://api.openai.com/v1)
  OPENAI_MODEL         Optional (default gpt-4.1-mini)

  SEED_API_KEY         Seed/Volcengine provider API key
  ARK_API_KEY          Alias for SEED_API_KEY
  SEED_BASE_URL        Optional (default https://ark.cn-beijing.volces.com/api/coding)
  SEED_MODEL           Optional (default doubao-seed-code-preview-latest)

  CODEX_HOME           Optional (default ~/.codex)
  CODEX_MODEL          Optional for codex token mode (default gpt-5-codex)
  PIECODE_DISABLE_CODEX_CLI Optional (set 1 to disable codex CLI session backend)
  PIECODE_SETTINGS_FILE Optional (default ~/.piecode/settings.json)
  PIECODE_HISTORY_FILE Optional (default ~/.piecode_history)

Auth fallback order:
  1) Command line arguments --provider/--api-key/--model
  2) ~/.piecode/settings.json
  3) Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY)
  4) Codex CLI session (codex login)
  5) Codex auth file (~/.codex/auth.json)
  Note: Codex OAuth tokens can be scope-limited.

Slash commands in interactive mode:
  /help                Show commands
  /exit                Quit
  /clear               Clear conversation history
  /approve on|off      Toggle shell auto-approval
  /model               Show active provider/model
`);
}

function parseArgs(argv) {
  const args = {
    prompt: null,
    help: false,
    provider: null,
    apiKey: null,
    model: null,
    baseUrl: null,
    disableCodex: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--prompt" || a === "-p") {
      args.prompt = argv[i + 1] || "";
      i += 1;
    } else if (a === "--provider" || a === "-P") {
      args.provider = argv[i + 1] || "";
      i += 1;
    } else if (a === "--api-key" || a === "-K") {
      args.apiKey = argv[i + 1] || "";
      i += 1;
    } else if (a === "--model" || a === "-M") {
      args.model = argv[i + 1] || "";
      i += 1;
    } else if (a === "--base-url" || a === "-B") {
      args.baseUrl = argv[i + 1] || "";
      i += 1;
    } else if (a === "--disable-codex") {
      args.disableCodex = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Handle --disable-codex option
  if (args.disableCodex) {
    process.env.PIECODE_DISABLE_CODEX_CLI = "1";
  }

  const settingsFile = getSettingsFilePath();
  const settings = await loadSettings(settingsFile);
  const provider = getProvider(resolveProviderOptions(args, settings));
  const workspaceDir = process.cwd();
  const autoApproveRef = { value: false };
  const historyFile = getHistoryFilePath();
  const initialHistory = await loadHistory(historyFile);

  const rl = createInterface({
    input: stdin,
    output: stdout,
    historySize: HISTORY_MAX,
    removeHistoryDuplicates: true,
  });
  rl.history = initialHistory;

  const askApproval = async (q) => {
    const ans = (await rl.question(q)).trim().toLowerCase();
    if (rl.history?.[0] === ans) rl.history.shift();
    return ans === "y" || ans === "yes";
  };

  const agent = new Agent({
    provider,
    workspaceDir,
    autoApproveRef,
    askApproval,
    onEvent: (evt) => {
      if (evt.type === "model_call") {
        console.log(`[model] ${evt.provider}:${evt.model}`);
      }
      if (evt.type === "tool_use") {
        const details = Object.entries(evt.input || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        console.log(`[tool] ${evt.tool}${evt.reason ? ` - ${evt.reason}` : ""}${details ? ` (${details})` : ""}`);
      }
      if (evt.type === "tool_start") {
        const details = Object.entries(evt.input || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        console.log(`[run] ${evt.tool}${details ? ` ${details}` : ""}`);
      }
    },
  });

  if (args.prompt !== null) {
    const result = await agent.runTurn(args.prompt);
    console.log(`\n${result}`);
    await saveHistory(historyFile, rl.history);
    rl.close();
    return;
  }

  console.log(`piecode ready in ${path.basename(workspaceDir)} (${provider.kind}:${provider.model})`);
  console.log("Type /help for commands.");

  while (true) {
    const input = (await rl.question("\n> ")).trim();
    if (!input) continue;

    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      printHelp();
      continue;
    }
    if (input === "/clear") {
      agent.clearHistory();
      console.log("history cleared");
      continue;
    }
    if (input.startsWith("/approve")) {
      const mode = input.split(/\s+/)[1];
      if (mode === "on" || mode === "off") {
        autoApproveRef.value = mode === "on";
        console.log(`shell auto-approval ${mode}`);
      } else {
        console.log("usage: /approve on|off");
      }
      continue;
    }
    if (input === "/model") {
      console.log(`${provider.kind}:${provider.model}`);
      continue;
    }

    try {
      const result = await agent.runTurn(input);

      // 处理任务规划结果
      if (typeof result === 'object' && result !== null) {
        if (result.executionResults) {
          console.log(`\n✅ Task Completed - ${result.taskType}`);
          console.log(`📊 Difficulty: ${result.difficulty}`);
          console.log(`🎯 Goal: ${result.goals}`);
          console.log(`\n📝 Execution Summary: ${result.summary}`);

          console.log(`\n📋 Steps: (${result.executionResults.length} total)`);
          result.executionResults.forEach(stepResult => {
            const icon = stepResult.status === 'Success' ? '✅' : (stepResult.status === 'Failed' ? '❌' : '⚠️');
            console.log(`  ${icon} ${stepResult.step}`);

            // 显示错误信息
            if (stepResult.status === 'Failed') {
              console.log(`    Error: ${stepResult.result}`);
            } else if (stepResult.status === 'Skipped') {
              console.log(`    Note: ${stepResult.result}`);
            }
          });

          if (result.recommendations && result.recommendations.length > 0) {
            console.log(`\n💡 Recommendations: ${result.recommendations.length}`);
            result.recommendations.forEach((rec, index) => {
              console.log(`  ${index + 1}. ${rec}`);
            });
          }
        } else {
          // 如果是没有执行计划的对象，直接显示
          console.log(`\n${JSON.stringify(result, null, 2)}`);
        }
      } else {
        console.log(`\n${result}`);
      }
    } catch (err) {
      console.error(`error: ${err.message}`);
    }
  }

  await saveHistory(historyFile, rl.history);
  rl.close();
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});

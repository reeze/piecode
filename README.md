# piecode

A Claude Code-like command line coding agent.

## Features

- Interactive terminal agent loop
- Model-driven tool use (`shell`, `task`, `read_file`, `read_files`, `write_file`, `apply_patch`, `replace_in_files`, `list_files`, `glob_files`, `find_files`, `search_files`, `git_status`, `git_diff`, `run_tests`)
- MCP support via `mcpServers` settings and shared agent MCP configs (list/call tools, list/read resources)
- Workspace path sandboxing for file operations
- Shell command approval mode (`/approve on|off`)
- 20 built-in model providers with live model discovery, one-command switching, and a `/doctor` health check
- Durable task ledger that survives context compaction, so long-running work keeps its plan and evidence

## Setup

Requirements:

- Node.js 22+

Configure at least one provider. Setting a single API key is enough — piecode
picks up any provider it recognises:

```bash
export ANTHROPIC_API_KEY="..."     # Anthropic
export OPENAI_API_KEY="..."        # OpenAI
export DEEPSEEK_API_KEY="..."      # DeepSeek
export MOONSHOT_API_KEY="..."      # Moonshot / Kimi
export ZHIPU_API_KEY="..."         # Z.ai / GLM
export DASHSCOPE_API_KEY="..."     # Qwen
export OPENROUTER_API_KEY="..."    # OpenRouter (any aggregated model)
codex login                        # Codex, via ~/.codex login state

# Optional thinking/reasoning effort, where the provider supports one
export PIECODE_THINKING_EFFORT="high"   # none/minimal/low/medium/high/xhigh
```

Not sure what is configured? Ask:

```bash
piecode --doctor            # providers, active model, extensions, next steps
piecode --list-providers    # every provider, whether it is ready, how to set it up
piecode --list-models       # selectable models grouped by provider
```

See [docs/providers.md](docs/providers.md) for the full provider list, the model
reference syntax, local runtimes (Ollama, LM Studio, vLLM, local Codex), and how
to add a model the registry does not know about yet.

Or use persistent settings in `~/.piecode/settings.json`:

```json
{
  "provider": "seed",
  "model": "doubao-seed-code-preview-latest",
  "thinkingEffort": "high",
  "endpoint": "https://ark.cn-beijing.volces.com/api/coding",
  "skills": {
    "enabled": ["vercel-react-best-practices"],
    "paths": [
      "/Users/reeze/.agents/skills",
      "/Users/reeze/.codex/skills"
    ]
  },
  "providers": {
    "seed": {
      "model": "doubao-seed-code-preview-latest",
      "endpoint": "https://ark.cn-beijing.volces.com/api/coding"
    },
    "codex": {
      "model": "gpt-5-codex"
    },
    "openai": {
      "endpoint": "https://api.openai.com/v1"
    }
  },
  "mcpServers": {
    "mock": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"]
    }
  },
  "mcpImport": {
    "enabled": true,
    "includeDefaults": true,
    "paths": ["/absolute/path/to/other-agent-mcp.json"]
  }
}
```

Run:

```bash
npm run agent

# list available skills
node src/cli.js --list-skills

# enable skills for one run
node src/cli.js --skill vercel-react-best-practices --prompt "optimize this React component"

# auto-enable by mention in prompt
node src/cli.js --prompt "use $vercel-react-best-practices to optimize this React component"

# choose thinking/reasoning effort for one run
node src/cli.js --thinking-effort high --prompt "inspect this repo"

# start simple full-screen TUI mode
node src/cli.js --tui

# start the Web UI (LAN accessible by default)
node src/cli.js --web
# or
npm run web
# optional overrides:
PIECODE_WEB_PORT=3737 PIECODE_WEB_HOST=0.0.0.0 npm run web
```

Build and release:

```bash
# Build distributable artifact into dist/
npm run build

# Install locally to ~/.local/piecode (binary in ~/.local/piecode/bin/piecode)
npm run install:local

# Install to a custom local path
npm run install:local -- --prefix /tmp/piecode-local

# Release dry-run (build + show publish command)
npm run release

# Publish to npm from built tarball
npm run release -- --publish
```

TUI includes live model status (running/idle/error), last turn duration, and last tool used. The TUI is rendered with Ink and avoids continuous redraw animation by default for better behavior in mobile terminals/tmux; set `PIECODE_TUI_ANIMATION=1` to opt into a slow thinking spinner.

Web UI is available with `node src/cli.js --web` or `npm run web`. It serves a browser-based agent workspace on `0.0.0.0` by default so other devices on the same LAN can open the printed network URL. The Web UI reuses the same Agent, provider, tool, MCP, skills, and approval backend as the CLI/TUI, with chat timeline, compact tool summaries, optional detail mode, session diff, TODOs, plan mode, abort, and shell approval controls. Web sessions are saved under `.piecode/web-sessions/`; use `/sessions` to list recent sessions and `/resume <short-id|session-id>` to restore one.

The agent now performs a lightweight pre-plan before execution (default on) to reduce unnecessary tool calls. If the first plan underestimates the work, it auto-replans and continues.

One-shot prompt:

```bash
node src/cli.js --prompt "inspect this repo and suggest next steps"
```

## Benchmarking

Run Terminal-Bench 2.0 against PieCode using your existing `~/.piecode/settings.json` provider/model config:

```bash
# default smoke task (hello-world)
./scripts/run-terminal-bench.sh

# run specific tasks
./scripts/run-terminal-bench.sh \
  --task-id hello-world \
  --task-id broken-python \
  --task-id fix-permissions
```

Notes:

- The script clones `terminal-bench` into `/tmp/terminal-bench` if needed.
- Results are written to `/tmp/piecode-tb-runs/<run-id>/results.json`.
- Override settings path with `PIECODE_SETTINGS_PATH=/path/to/settings.json`.
- If you use OrbStack, set Docker socket explicitly:

```bash
DOCKER_HOST=unix:///Users/$USER/.orbstack/run/docker.sock ./scripts/run-terminal-bench.sh
```

## Interactive Commands

- `/help` show help
- `/exit` quit
- `/clear` clear conversation memory
- `/plan on|off` toggle plan mode (generate plans, allow safe read-only tools, no file changes)
- `/goal <task>` run a goal-driven loop that keeps planning, executing, and verifying until completion, blockage, or the turn limit
- `/task` list background shell tasks
- `/task start [name --] <cmd>` run a shell command in the background
- `/task status <id>` show one background task
- `/task read <id>` show recent task output
- `/task stop <id>` stop a running background task
- `/approve on|off` toggle shell auto approval
- `/model` show the active model and open the model picker
- `/model <provider>:<model>` switch model, e.g. `/model deepseek:deepseek-reasoner`
- `/models` list selectable models grouped by provider
- `/provider` show every provider with readiness and setup steps
- `/provider <id>` switch to that provider's default model
- `/doctor` diagnose providers, active model, MCP and extensions
- `/ledger` show durable task state (objective, todos, evidence, next step)
- `/ledger clear` reset durable task state
- `/mcp` show MCP status/usage
- `/mcp list` list active MCP servers
- `/mcp show <name>` show server config
- `/mcp add <name> <command> [args...]` add/update local MCP server
- `/mcp remove <name>` remove local MCP server (or mask imported server)
- `/mcp reload` reload MCP settings from disk
- `/mcp import on|off` toggle shared MCP config import
- `/skills` show active skills
- `/skills list` list discovered skills
- `/skills use <name>` enable a skill
- `/skills off <name>` disable a skill
- `/skills clear` disable all skills
- `/use <name>` alias for enabling a skill
- `/attach image` attach the current clipboard image to the next prompt

You can also mention `$skill-name` in a prompt to auto-enable that skill for the current session.

## Notes

- `shell` tool runs commands from the current working directory.
- Use `/task start [name --] <cmd>` or the model-facing `shell` tool with `background: true` for long-running servers, watchers, and parallel workloads.
- File tools are restricted to the current workspace root.
- Shell tool is approval-gated by default for safety.
- MCP can be configured in `~/.piecode/settings.json` with `mcpServers` (or `mcp.servers`).
- PieCode also imports MCP servers from common agent config paths (for example Cursor/Claude-style JSON configs).
- Local `~/.piecode/settings.json` MCP entries override imported server entries with the same name.

## Documentation

- [docs/providers.md](docs/providers.md) — every provider, model reference syntax, local runtimes (Ollama, LM Studio, vLLM, local Codex), model discovery, reasoning effort.
- [docs/long-horizon.md](docs/long-horizon.md) — the durable task ledger, how it survives context compaction, and how it relates to memory, compaction and goal mode.
- Set `PIECODE_MCP_IMPORT=0` to disable shared MCP import.
- Set `PIECODE_MCP_CONFIG_PATHS` for extra JSON config files (comma-separated).
- Stdio protocol is auto-detected per server (tries `content-length` then `line`); you can force with `stdioProtocol: "content-length"` or `stdioProtocol: "line"`.
- MCP helper tools available to the model when configured:
  - `list_mcp_servers`
  - `list_mcp_tools`
  - `mcp_call_tool`
  - `list_mcp_resources`
  - `list_mcp_resource_templates`
  - `read_mcp_resource`
- Provider selection order is: CLI args -> `~/.piecode/settings.json` -> env vars -> Codex CLI session -> Codex auth file.
- Clipboard image attachments are supported in interactive mode via `/attach image` (macOS, Windows, and Linux with `wl-paste`, `xclip`, or `xsel`). They are sent to vision-capable native-tool providers with the next prompt.
- `seed` provider is OpenAI-compatible and can be selected with `"provider": "seed"` (or `--provider seed`).
- Codex OAuth tokens may not include all API scopes; if needed, set `OPENAI_API_KEY`.
- Interactive prompt history is persisted to `~/.piecode_history` by default.
- Set `PIECODE_HISTORY_FILE` to override the history file location.
- Set `PIECODE_DISABLE_CODEX_CLI=1` to skip the Codex CLI session backend.
- Set `PIECODE_SETTINGS_FILE` to override the settings file location.
- Set `PIECODE_ENABLE_PLANNER=1` to enable the experimental task planner (disabled by default).
- Set `PIECODE_PLAN_MODE=1` to start in plan mode (safe read-only tools allowed, no file changes).
- Set `PIECODE_GOAL_MAX_TURNS` to tune `/goal` loop length (default `50`, range `1-200`).
- Set `PIECODE_SKILLS_DIR` to override/extend skill root directories (comma-separated).
- Set `PIECODE_PLAN_FIRST=1` to enable lightweight pre-plan (disabled by default).
- Set `PIECODE_TOOL_BUDGET` to set initial planning budget guidance (default `6`, range `1-12`).
- Set `PIECODE_THINKING_EFFORT` (or `PIECODE_REASONING_EFFORT`) to request model thinking/reasoning effort for supported providers (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`). It can also be set with `--thinking-effort`, top-level `thinkingEffort`, or per-provider `providers.<name>.thinkingEffort` in settings.
- Model suggestions for `/model` are loaded from both built-in defaults and `~/.piecode/settings.json` (`model` and `providers.*.model`).

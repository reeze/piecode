# Pie Code Agent

A command-line AI coding agent for software engineering tasks with an interactive terminal interface, model-driven tool use, MCP integrations, skills/plugins, resumable sessions, and multi-provider AI support.

## Quick Start

```bash
# Install dependencies
npm install

# Configure an AI provider (Anthropic recommended)
export ANTHROPIC_API_KEY="your-api-key"

# Run the interactive TUI
npm run agent
# or
node src/cli.js --tui
```

## Features

- **Interactive TUI**: Ink-based full-screen terminal interface with live model status, context usage, task progress, tool summaries, TODOs, debug overlays, and timeline scrolling.
- **One-shot mode**: Run a single prompt with `node src/cli.js --prompt "..."`.
- **Web UI**: Browser-based workspace via `node src/cli.js --web` or `npm run web`.
- **Model-driven tools**: File, search, shell, git, test, web search, TODO, memory, subagent, and MCP helper tools.
- **Security controls**: Workspace sandboxing for file tools and approval-gated shell execution.
- **Multi-provider AI**: Anthropic, OpenAI-compatible APIs, OpenRouter, Seed/Volcengine, Codex auth/token mode, and Codex CLI fallback.
- **MCP support**: Configure local MCP servers and import shared agent MCP configs; list/call MCP tools and list/read MCP resources.
- **Skills and plugins**: Discover, enable, auto-enable, install, update, and invoke reusable capabilities and slash commands.
- **Project agents**: Claude Code-style `.AGENTS/*.md` agent definitions can be loaded and invoked as named subagents.
- **Memory**: Durable project/global memory loaded from `.piecode/MEMORY.md` and `~/.piecode/MEMORY.md`.
- **Planning and goal loops**: Plan mode, optional lightweight pre-planning, experimental task planner, and `/goal` iterative completion mode.
- **Sessions and diagnostics**: Resumable sessions, JSONL session events, task traces, LLM debug history, and optional tmux subagent windows.
- **Attachments and file mentions**: Clipboard image attachments and `@<file>` fuzzy project-file context.

## Tech Stack

| Technology | Purpose |
|------------|---------|
| Node.js 22+ | Runtime |
| JavaScript (ES modules) | Language |
| React + Ink | TUI rendering |
| Axios / fetch | HTTP/API requests |
| JSDOM | DOM manipulation in tests/utilities |
| markdown-it | Markdown rendering/parsing support |
| Jest | Testing |
| ESLint + Prettier | Code quality |

## Project Structure

```
.
├── src/
│   ├── cli.js                         # CLI entry, TUI loop, slash commands
│   ├── lib/                           # Core agent, tools, TUI, MCP, memory, skills/plugins
│   └── web/                           # Browser-based Web UI
├── __tests__/                         # Jest tests
├── .AGENTS/                           # Project subagent definitions and bundled skills
├── .piecode/                          # Project-local memory, sessions, plugins/skills, generated state
├── scripts/                           # Build, install, release, evaluation scripts
├── README.md                          # User-facing documentation
├── package.json                       # Dependencies and npm scripts
└── AGENTS.md                          # Project instructions for coding agents
```

Notable `src/lib/` modules include `agent.js`, `tools.js`, `providers.js`, `mcp.js`, `memory.js`, `agentDefinitions.js`, `agentManager.js`, `plugins.js`, `skills.js`, `resumableSessions.js`, `sessionProtocol.js`, `goalMode.js`, `inkLayout.js`, `tui.js`, `tuiLineEditor.js`, and `turnEngine.js`.

## Configuration

Choose one AI provider with environment variables, CLI args, or `~/.piecode/settings.json`.

### Anthropic (Recommended)

| Variable | Required? | Default |
|----------|-----------|---------|
| `ANTHROPIC_API_KEY` | ✅ Yes | - |
| `ANTHROPIC_MODEL` | ❌ No | `claude-3-5-sonnet-latest` |

### OpenAI-compatible

| Variable | Required? | Default |
|----------|-----------|---------|
| `OPENAI_API_KEY` | ✅ Yes | - |
| `OPENAI_BASE_URL` | ❌ No | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | ❌ No | `gpt-4.1-mini` |

### OpenRouter

| Variable | Required? | Default |
|----------|-----------|---------|
| `OPENROUTER_API_KEY` | ✅ Yes | - |
| `OPENROUTER_BASE_URL` | ❌ No | `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | ❌ No | `openai/gpt-4.1-mini` |
| `OPENROUTER_SITE_URL` | ❌ No | - |
| `OPENROUTER_APP_NAME` | ❌ No | - |

### Seed / Volcengine

| Variable | Required? | Default |
|----------|-----------|---------|
| `SEED_API_KEY` | ✅ Yes | - |
| `SEED_BASE_URL` | ❌ No | `https://ark.cn-beijing.volces.com/api/coding` |
| `SEED_MODEL` | ❌ No | `doubao-seed-code-preview-latest` |

### Codex

```bash
codex login
export CODEX_MODEL="gpt-5.3-codex" # optional
```

Codex auth/token mode is preferred when available. Codex CLI fallback can be disabled with `--disable-codex` or `PIECODE_DISABLE_CODEX_CLI=1`.

### Persistent Settings

Create `~/.piecode/settings.json`:

```json
{
  "provider": "seed",
  "model": "doubao-seed-code-preview-latest",
  "thinkingEffort": "high",
  "endpoint": "https://ark.cn-beijing.volces.com/api/coding",
  "skills": {
    "enabled": ["vercel-react-best-practices"],
    "paths": [
      "/Users/your-username/.agents/skills",
      "/Users/your-username/.codex/skills",
      ".piecode/skills"
    ]
  },
  "plugins": {
    "enabled": [],
    "paths": [
      "/Users/your-username/.piecode/plugins",
      ".piecode/plugins"
    ]
  },
  "providers": {
    "seed": {
      "model": "doubao-seed-code-preview-latest",
      "endpoint": "https://ark.cn-beijing.volces.com/api/coding"
    },
    "codex": { "model": "gpt-5.3-codex" },
    "openrouter": { "model": "anthropic/claude-sonnet-4.5" },
    "openai": { "endpoint": "https://api.openai.com/v1" }
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

## Usage

### Interactive Mode

```bash
npm run agent
# or
node src/cli.js --tui
```

### One-shot Prompt

```bash
node src/cli.js --prompt "inspect this repo and suggest next steps"
```

### Resume a Session

```bash
node src/cli.js --resume <session-id-or-short-id>
# or use /sessions and /resume interactively
```

### Web UI

```bash
node src/cli.js --web
# or
npm run web

# Optional host/port overrides
PIECODE_WEB_PORT=3737 PIECODE_WEB_HOST=0.0.0.0 npm run web
```

### Skills

```bash
# List available skills
node src/cli.js --list-skills

# Enable a skill for one run
node src/cli.js --skill vercel-react-best-practices --prompt "optimize this React component"

# Auto-enable via prompt mention
node src/cli.js --prompt "use $vercel-react-best-practices to optimize this React component"
```

### Plugins

```bash
# List available plugins
node src/cli.js --list-plugins

# Enable a plugin for one run
node src/cli.js --plugin <name> --prompt "..."

# Install or update plugins
node src/cli.js --plugin-install <local-dir-or-git-url>
node src/cli.js --plugin-update <name|all>
```

### Build and Release

```bash
npm run build
npm run install:local
npm run release
npm run release -- --publish
```

## Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` | Show command map |
| `/exit`, `/quit` | Quit |
| `/clear` | Clear all turn context and TODOs |
| `/compact` | Compact older context while keeping recent turns |
| `/sessions` | List recent saved sessions |
| `/resume <id>` | Resume a saved session |
| `/status` | Show current task/model/subagent status |
| `/btw <question>` | Run a strict read-only background side question |
| `/agents` | Show active/recent subagents and configured agents |
| `/plan` | Show plan mode status |
| `/plan on|off` | Toggle plan-only mode; safe read-only tools only |
| `/goal <task>` | Run an iterative goal loop until complete, blocked, or max turns |
| `/approve on|off` | Toggle shell auto-approval |
| `/trace on|off` | Toggle runtime trace logs |
| `/debug` | Show debug/session state |
| `/debug status` | Show detailed debug status |
| `/debug llm` | Open/dump latest LLM request/response debug payloads |
| `/debug last` | Show last task trace summary |
| `/debug save` | Force-save current trace/log files |
| `/model` | Show active provider/model; in TUI opens model picker |
| `/model list` | List usable model suggestions |
| `/model <model-id>` | Switch model; provider prefixes like `openrouter:<id>` and `codex:<id>` are supported |
| `/think <none|minimal|low|medium|high|xhigh|off>` | Show or set model thinking/reasoning effort |
| `/mcp` | Show MCP status and usage |
| `/mcp list` | List active MCP servers |
| `/mcp show <name>` | Show one MCP server config |
| `/mcp add <name> <command> [args...]` | Add/update local MCP server config |
| `/mcp remove <name>` | Remove local server or mask imported server |
| `/mcp reload` | Reload MCP settings from disk |
| `/mcp import on|off` | Toggle shared MCP config import |
| `/skills` | Show active skills |
| `/skills list` | List discovered skills |
| `/skills commands` | List slash commands exposed by skills |
| `/skills use <name>` | Enable a skill |
| `/skills off <name>` | Disable a skill |
| `/skills clear` | Disable all skills |
| `/<skill-command>` | Invoke a skill-backed custom command |
| `/plugins` | Show active plugins |
| `/plugins list` | List discovered plugins |
| `/plugins commands` | List slash commands exposed by plugins |
| `/plugins install <source> [--name <name>] [--project]` | Install a plugin |
| `/plugins update <name|all>` | Update git-backed plugin(s) |
| `/plugins use <name>` | Enable a plugin |
| `/plugins off <name>` | Disable a plugin |
| `/plugins clear` | Disable all plugins |
| `/use <name>` | Alias for `/skills use <name>` |
| `/skill-creator` | Run the interactive skill creation tool |
| `/workspace` | Return to workspace timeline view |
| `/attach image` | Attach current clipboard image to the next prompt |
| `! <command>` | Run a direct shell command |
| `@<file>` | Fuzzy-search project files for context |

## Development

```bash
# Run tests
npm test
npm run test:watch
npm run test:coverage

# Lint
npm run lint
npm run lint:fix

# Web UI
npm run web

# Build/release helpers
npm run build
npm run install:local
npm run release:dry-run
```

## Important Environment Variables

| Variable | Purpose |
|----------|---------|
| `PIECODE_SETTINGS_FILE` | Override settings file path (default `~/.piecode/settings.json`) |
| `PIECODE_HISTORY_FILE` | Override interactive history file (default `~/.piecode_history`) |
| `PIECODE_TUI` | Set `0` to disable TUI by default |
| `PIECODE_TUI_ANIMATION` | Set `1` to enable slow thinking spinner animation |
| `PIECODE_PLAN_MODE` | Start in plan-only mode |
| `PIECODE_PLAN_FIRST` | Enable lightweight pre-plan |
| `PIECODE_ENABLE_PLANNER` | Enable experimental task planner |
| `PIECODE_TOOL_BUDGET` | Initial planning budget guidance (default `6`, range `1-12`) |
| `PIECODE_GOAL_MAX_TURNS` | `/goal` loop limit (default `50`, range `1-200`) |
| `PIECODE_THINKING_EFFORT` / `PIECODE_REASONING_EFFORT` | Model thinking/reasoning effort |
| `PIECODE_SKILLS_DIR` | Override/extend skill root directories (comma-separated) |
| `PIECODE_PLUGINS_DIR` | Override/extend plugin root directories (comma-separated) |
| `PIECODE_MCP_IMPORT` | Set `0` to disable shared MCP import |
| `PIECODE_MCP_CONFIG_PATHS` | Extra MCP config JSON paths (comma-separated) |
| `PIECODE_SESSION_EVENTS_FILE` | JSONL event stream for GUI/remote integrations |
| `PIECODE_TMUX_SUBAGENTS` | Set `1` inside tmux to open subagent event windows |
| `PIECODE_VERBOSE_TOOL_LOGS` | Set `1` for full tool input details in logs |
| `PIECODE_LLM_DEBUG_HISTORY` | Number of LLM debug entries kept in memory |
| `PIECODE_DISABLE_CODEX_CLI` | Disable Codex CLI fallback |
| `PIECODE_CODEX_PREFER_CLI` | Prefer Codex CLI fallback |

## Key Concepts

- **Tools**: The model can request workspace-safe operations such as reading/writing files, running approved shell commands, searching code, checking git status/diffs, running tests, managing TODOs, writing memory, spawning subagents, and interacting with MCP servers.
- **Skills**: Reusable instruction bundles in `~/.agents/skills`, `~/.codex/skills`, `.piecode/skills`, or configured paths. Skills can define slash commands and auto-enable by prompt mention (`$skill-name`) or trigger.
- **Plugins**: Installable extensions with discovery, slash commands, auto-enable behavior, and optional project-local installation under `.piecode/plugins`.
- **Project agents**: `.AGENTS/*.md` files with frontmatter (`name`, `description`, `tools`, `model`, `color`) define named subagents. Tool lists restrict rather than elevate permissions.
- **Memory**: Project and global memory are loaded at startup and can be updated during work. Save only durable project conventions or preferences; never store secrets.
- **MCP**: Local and imported MCP server configs expose model-callable tools/resources through the built-in MCP helper tools.
- **Plan mode**: Limits execution to safe read-only operations and prevents file changes.
- **Goal mode**: `/goal` repeatedly asks the agent to plan, execute, verify, and report status until the task is complete, blocked, or the turn limit is reached.
- **Resumable sessions**: CLI sessions are saved under `.piecode/sessions/`; use `/sessions`, `/resume`, or `piecode --resume` to continue.

## Coding-Agent Guidelines for This Repo

- Prefer targeted reads/searches before editing; do not guess about file contents.
- Before editing existing files, read them first and preserve unrelated user changes.
- Keep changes focused on the requested task; avoid opportunistic refactors.
- After code changes, run the most relevant practical validation (`npm test`, focused Jest tests, lint, build, or a targeted command). If validation is not run, state why.
- Use `npm test` for the full Jest suite and `npm run lint` for source linting.
- Treat `.piecode/`, `.AGENTS/`, and generated session/trace files carefully; do not overwrite unrelated local state.
- Do not commit secrets, API keys, local settings, session logs, or transient debug output.

## License

[Insert License Information Here]

## Contributing

[Insert Contributing Guidelines Here]

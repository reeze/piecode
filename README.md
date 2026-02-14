# piecode

A Claude Code-like command line coding agent.

## Features

- Interactive terminal agent loop
- Model-driven tool use (`shell`, `read_file`, `write_file`, `list_files`, `search_files`)
- MCP support via `mcpServers` settings and shared agent MCP configs (list/call tools, list/read resources)
- Workspace path sandboxing for file operations
- Shell command approval mode (`/approve on|off`)
- Works with Anthropic (preferred) or OpenAI-compatible APIs

## Setup

Requirements:

- Node.js 18+

Configure one provider:

```bash
# Preferred: Anthropic
export ANTHROPIC_API_KEY="..."
export ANTHROPIC_MODEL="claude-3-5-sonnet-latest"   # optional

# Or OpenAI-compatible
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://api.openai.com/v1"  # optional
export OPENAI_MODEL="gpt-4.1-mini"                  # optional

# Or Seed / Volcengine (OpenAI-compatible endpoint)
export SEED_API_KEY="..."
export SEED_BASE_URL="https://ark.cn-beijing.volces.com/api/coding"  # optional
export SEED_MODEL="doubao-seed-code-preview-latest"                  # optional

# Or rely on Codex login state
# (reads ~/.codex/auth.json automatically)
codex login
export CODEX_MODEL="gpt-5-codex"                    # optional
```

Or use persistent settings in `~/.piecode/settings.json`:

```json
{
  "provider": "seed",
  "model": "doubao-seed-code-preview-latest",
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

# start simple full-screen TUI mode
node src/cli.js --tui
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

TUI includes live model status (running/idle/error), last turn duration, and last tool used.

The agent now performs a lightweight pre-plan before execution (default on) to reduce unnecessary tool calls. If the first plan underestimates the work, it auto-replans and continues.

One-shot prompt:

```bash
node src/cli.js --prompt "inspect this repo and suggest next steps"
```

## Interactive Commands

- `/help` show help
- `/exit` quit
- `/clear` clear conversation memory
- `/plan on|off` toggle plan mode (generate plans, allow safe read-only tools, no file changes)
- `/approve on|off` toggle shell auto approval
- `/model` show active provider/model
- `/skills` show active skills
- `/skills list` list discovered skills
- `/skills use <name>` enable a skill
- `/skills off <name>` disable a skill
- `/skills clear` disable all skills
- `/use <name>` alias for enabling a skill

You can also mention `$skill-name` in a prompt to auto-enable that skill for the current session.

## Notes

- `shell` tool runs commands from the current working directory.
- File tools are restricted to the current workspace root.
- Shell tool is approval-gated by default for safety.
- MCP can be configured in `~/.piecode/settings.json` with `mcpServers` (or `mcp.servers`).
- PieCode also imports MCP servers from common agent config paths (for example Cursor/Claude-style JSON configs).
- Local `~/.piecode/settings.json` MCP entries override imported server entries with the same name.
- Set `PIECODE_MCP_IMPORT=0` to disable shared MCP import.
- Set `PIECODE_MCP_CONFIG_PATHS` for extra JSON config files (comma-separated).
- MCP helper tools available to the model when configured:
  - `list_mcp_servers`
  - `list_mcp_tools`
  - `mcp_call_tool`
  - `list_mcp_resources`
  - `list_mcp_resource_templates`
  - `read_mcp_resource`
- Provider selection order is: CLI args -> `~/.piecode/settings.json` -> env vars -> Codex CLI session -> Codex auth file.
- `seed` provider is OpenAI-compatible and can be selected with `"provider": "seed"` (or `--provider seed`).
- Codex OAuth tokens may not include all API scopes; if needed, set `OPENAI_API_KEY`.
- Interactive prompt history is persisted to `~/.piecode_history` by default.
- Set `PIECODE_HISTORY_FILE` to override the history file location.
- Set `PIECODE_DISABLE_CODEX_CLI=1` to skip the Codex CLI session backend.
- Set `PIECODE_SETTINGS_FILE` to override the settings file location.
- Set `PIECODE_ENABLE_PLANNER=1` to enable the experimental task planner (disabled by default).
- Set `PIECODE_PLAN_MODE=1` to start in plan mode (safe read-only tools allowed, no file changes).
- Set `PIECODE_SKILLS_DIR` to override/extend skill root directories (comma-separated).
- Set `PIECODE_PLAN_FIRST=1` to enable lightweight pre-plan (disabled by default).
- Set `PIECODE_TOOL_BUDGET` to set initial planning budget guidance (default `6`, range `1-12`).
- Model suggestions for `/model` are loaded from both built-in defaults and `~/.piecode/settings.json` (`model` and `providers.*.model`).

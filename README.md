# piecode

A Claude Code-like command line coding agent.

## Features

- Interactive terminal agent loop
- Model-driven tool use (`shell`, `read_file`, `write_file`, `list_files`)
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
  }
}
```

Run:

```bash
npm run agent
```

One-shot prompt:

```bash
node src/cli.js --prompt "inspect this repo and suggest next steps"
```

## Interactive Commands

- `/help` show help
- `/exit` quit
- `/clear` clear conversation memory
- `/approve on|off` toggle shell auto approval
- `/model` show active provider/model

## Notes

- `shell` tool runs commands from the current working directory.
- File tools are restricted to the current workspace root.
- Shell tool is approval-gated by default for safety.
- Provider selection order is: CLI args -> `~/.piecode/settings.json` -> env vars -> Codex CLI session -> Codex auth file.
- `seed` provider is OpenAI-compatible and can be selected with `"provider": "seed"` (or `--provider seed`).
- Codex OAuth tokens may not include all API scopes; if needed, set `OPENAI_API_KEY`.
- Interactive prompt history is persisted to `~/.piecode_history` by default.
- Set `PIECODE_HISTORY_FILE` to override the history file location.
- Set `PIECODE_DISABLE_CODEX_CLI=1` to skip the Codex CLI session backend.
- Set `PIECODE_SETTINGS_FILE` to override the settings file location.

# Pie Code Agent

A coding agent for software engineering tasks with an interactive terminal interface, model-driven tool use, and multi-provider AI support.

## Quick Start

```bash
# Install dependencies
npm install

# Configure AI provider (Anthropic recommended)
export ANTHROPIC_API_KEY="your-api-key"

# Run in interactive mode
npm run agent
```

## Features

- **Interactive TUI**: Full-screen terminal interface with live status
- **Model-driven Tools**: `shell`, `read_file`, `write_file`, `list_files`
- **Security**: Workspace sandboxing + shell command approval
- **Multi-provider AI**: Anthropic, OpenAI-compatible, Seed/Volcengine, Codex
- **Skills System**: Plugins for extending functionality
- **Task Planning**: Experimental workflow breakdown (set `PIECODE_ENABLE_PLANNER=1`)

## Tech Stack

| Technology | Purpose |
|------------|---------|
| Node.js 18+ | Runtime |
| JavaScript (ES modules) | Language |
| Axios | HTTP requests |
| JSDOM | DOM manipulation |
| Jest | Testing |
| ESLint + Prettier | Code quality |

## Project Structure

```
.
├── src/
│   ├── cli.js                    # CLI entry
│   └── lib/
│       ├── agent.js              # Core logic
│       ├── display.js            # Display utilities
│       ├── prompt.js             # Prompt handling
│       ├── providers.js          # AI providers
│       ├── skillCreator.js       # Skill utilities
│       ├── skills.js             # Skills management
│       ├── taskPlanner.js        # Task planning
│       ├── tools.js              # Tool implementations
│       └── tui.js                # TUI interface
├── __tests__/                    # Tests
├── CLAUDE_CODE_LESSONS.md        # Claude Code lessons
├── IMPROVEMENTS.md               # Improvement ideas
├── README.md                     # Documentation
├── package.json                  # Dependencies
└── AGENTS.md                     # This file
```

## Configuration

Choose one AI provider and configure via environment variables or `~/.piecode/settings.json`.

### Anthropic (Recommended)

| Variable | Required? | Default |
|----------|-----------|---------|
| `ANTHROPIC_API_KEY` | ✅ Yes | - |
| `ANTHROPIC_MODEL` | ❌ No | `claude-3-5-sonnet-latest` |

```bash
export ANTHROPIC_API_KEY="your-api-key"
```

### OpenAI-compatible

| Variable | Required? | Default |
|----------|-----------|---------|
| `OPENAI_API_KEY` | ✅ Yes | - |
| `OPENAI_BASE_URL` | ❌ No | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | ❌ No | `gpt-4.1-mini` |

```bash
export OPENAI_API_KEY="your-api-key"
```

### Seed / Volcengine

| Variable | Required? | Default |
|----------|-----------|---------|
| `SEED_API_KEY` | ✅ Yes | - |
| `SEED_BASE_URL` | ❌ No | `https://ark.cn-beijing.volces.com/api/coding` |
| `SEED_MODEL` | ❌ No | `doubao-seed-code-preview-latest` |

```bash
export SEED_API_KEY="your-api-key"
```

### Codex

| Variable | Required? | Default |
|----------|-----------|---------|
| `CODEX_MODEL` | ❌ No | `gpt-5-codex` |

```bash
codex login  # Follow instructions
```

### Persistent Settings

Create `~/.piecode/settings.json`:

```json
{
  "provider": "seed",
  "model": "doubao-seed-code-preview-latest",
  "endpoint": "https://ark.cn-beijing.volces.com/api/coding",
  "skills": {
    "enabled": ["vercel-react-best-practices"],
    "paths": [
      "/Users/your-username/.agents/skills",
      "/Users/your-username/.codex/skills"
    ]
  },
  "providers": {
    "seed": {
      "model": "doubao-seed-code-preview-latest",
      "endpoint": "https://ark.cn-beijing.volces.com/api/coding"
    },
    "codex": { "model": "gpt-5-codex" },
    "openai": { "endpoint": "https://api.openai.com/v1" }
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

### Skills

```bash
# List available skills
node src/cli.js --list-skills

# Enable a skill for one run
node src/cli.js --skill vercel-react-best-practices --prompt "optimize this React component"

# Auto-enable via prompt mention
node src/cli.js --prompt "use $vercel-react-best-practices to optimize this React component"
```

### Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help menu |
| `/exit` | Quit |
| `/clear` | Clear conversation memory |
| `/approve on|off` | Toggle shell auto approval |
| `/model` | Show active provider/model |
| `/skills` | Show active skills |
| `/skills list` | List discovered skills |
| `/skills use <name>` | Enable skill |
| `/skills off <name>` | Disable skill |
| `/skills clear` | Disable all skills |
| `/use <name>` | Alias for `/skills use` |

## Development

```bash
# Run tests
npm test
npm run test:watch
npm run test:coverage

# Lint
npm run lint
```

## Key Concepts

- **Skills**: Reusable plugins in `~/.agents/skills` or `~/.codex/skills` that extend functionality
- **Task Planner**: Experimental feature to break down complex requests (enable with `PIECODE_ENABLE_PLANNER=1`)
- **TUI**: Full-screen terminal interface with live model status, turn duration, and conversation flow

## License

[Insert License Information Here]

## Contributing

[Insert Contributing Guidelines Here]


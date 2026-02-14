# Pie Code Agent

## Table of Contents
- [Project Overview](#project-overview)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup Instructions](#setup-instructions)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
- [Usage](#usage)
  - [Interactive Mode](#interactive-mode)
  - [One-shot Prompt](#one-shot-prompt)
  - [List Available Skills](#list-available-skills)
  - [Enable Skills](#enable-skills)
  - [Interactive Commands](#interactive-commands)
- [Development](#development)
  - [Running Tests](#running-tests)
  - [Linting](#linting)
- [Key Concepts](#key-concepts)
- [License](#license)
- [Contributing](#contributing)

## Project Overview
Pie Code is a coding agent designed to assist with software engineering tasks. It provides an interactive terminal interface for model-driven tool use, including shell commands, file operations, and task planning capabilities.

## Key Features
- ✨ Interactive terminal agent loop with TUI (Terminal User Interface)
- 🛠️ Model-driven tool use: `shell`, `read_file`, `write_file`, `list_files`
- 🔒 Workspace path sandboxing for safe file operations
- 🛡️ Shell command approval mode for security
- 🤖 Support for multiple AI providers:
  - Anthropic (preferred)
  - OpenAI-compatible APIs
  - Seed / Volcengine (OpenAI-compatible endpoint)
  - Codex login state
- 🧩 Skills system (plugins) for extending functionality
- 📋 Lightweight pre-planning before execution
- 🗂️ Task planner for complex workflows

## Tech Stack
| Technology | Purpose |
|------------|---------|
| Node.js 18+ | Runtime environment |
| JavaScript (ES modules) | Programming language |
| Axios | HTTP requests |
| JSDOM | DOM manipulation |
| Jest | Testing framework |
| ESLint + Prettier | Code quality |

## Project Structure
```
.
├── src/                          # Source code
│   ├── cli.js                    # Main CLI entry point
│   └── lib/                      # Core library
│       ├── agent.js              # Core agent logic
│       ├── display.js            # Display utilities
│       ├── prompt.js             # Prompt handling
│       ├── providers.js          # AI provider implementations
│       ├── skillCreator.js       # Skill creation utilities
│       ├── skills.js             # Skills management
│       ├── taskPlanner.js        # Task planning logic
│       ├── tools.js               # Tool implementations
│       └── tui.js                # TUI interface
├── __tests__/                    # Test files
├── CLAUDE_CODE_LESSONS.md        # Lessons from Claude Code
├── IMPROVEMENTS.md               # Project improvement ideas
├── README.md                     # Project documentation
├── package.json                  # Dependencies and scripts
└── AGENTS.md                     # This file
```

## Setup Instructions

### Prerequisites
- Node.js 18 or higher

### Installation
```bash
# Clone the repository
git clone <repository-url>
cd piecode

# Install dependencies
npm install
```

### Configuration
Configure one of the supported AI providers:

#### Anthropic (Preferred)
| Environment Variable | Required? | Description | Default |
|-----------------------|-----------|-------------|---------|
| `ANTHROPIC_API_KEY` | ✅ Yes | Your Anthropic API key | - |
| `ANTHROPIC_MODEL` | ❌ No | Anthropic model to use | `claude-3-5-sonnet-latest` |

```bash
export ANTHROPIC_API_KEY="your-api-key"
export ANTHROPIC_MODEL="claude-3-5-sonnet-latest"  # optional
```

#### OpenAI-compatible
| Environment Variable | Required? | Description | Default |
|-----------------------|-----------|-------------|---------|
| `OPENAI_API_KEY` | ✅ Yes | Your OpenAI API key | - |
| `OPENAI_BASE_URL` | ❌ No | OpenAI-compatible API endpoint | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | ❌ No | Model to use | `gpt-4.1-mini` |

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"  # optional
export OPENAI_MODEL="gpt-4.1-mini"                 # optional
```

#### Seed / Volcengine
| Environment Variable | Required? | Description | Default |
|-----------------------|-----------|-------------|---------|
| `SEED_API_KEY` | ✅ Yes | Your Seed/Volcengine API key | - |
| `SEED_BASE_URL` | ❌ No | API endpoint | `https://ark.cn-beijing.volces.com/api/coding` |
| `SEED_MODEL` | ❌ No | Model to use | `doubao-seed-code-preview-latest` |

```bash
export SEED_API_KEY="your-api-key"
export SEED_BASE_URL="https://ark.cn-beijing.volces.com/api/coding"  # optional
export SEED_MODEL="doubao-seed-code-preview-latest"                  # optional
```

#### Codex
| Environment Variable | Required? | Description | Default |
|-----------------------|-----------|-------------|---------|
| `CODEX_MODEL` | ❌ No | Codex model to use | `gpt-5-codex` |

```bash
codex login  # Follow login instructions
export CODEX_MODEL="gpt-5-codex"  # optional
```

#### Persistent Settings
Create `~/.piecode/settings.json` for persistent configuration:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Default AI provider |
| `model` | string | Default model |
| `endpoint` | string | API endpoint |
| `skills.enabled` | array | List of enabled skills |
| `skills.paths` | array | Directories to search for skills |
| `providers` | object | Provider-specific configurations |

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
    "codex": {
      "model": "gpt-5-codex"
    },
    "openai": {
      "endpoint": "https://api.openai.com/v1"
    }
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

### List Available Skills
```bash
node src/cli.js --list-skills
```

### Enable Skills
```bash
# Enable a skill for one run
node src/cli.js --skill vercel-react-best-practices --prompt "optimize this React component"

# Auto-enable by mention in prompt
node src/cli.js --prompt "use $vercel-react-best-practices to optimize this React component"
```

### Interactive Commands
| Command | Description | Example |
|---------|-------------|---------|
| `/help` | Show help menu | `/help` |
| `/exit` | Quit the application | `/exit` |
| `/clear` | Clear conversation memory | `/clear` |
| `/approve on|off` | Toggle shell auto approval | `/approve on` |
| `/model` | Show active provider and model | `/model` |
| `/skills` | Show active skills | `/skills` |
| `/skills list` | List discovered skills | `/skills list` |
| `/skills use <name>` | Enable a skill | `/skills use vercel-react-best-practices` |
| `/skills off <name>` | Disable a skill | `/skills off vercel-react-best-practices` |
| `/skills clear` | Disable all skills | `/skills clear` |
| `/use <name>` | Alias for enabling a skill | `/use vercel-react-best-practices` |

## Development

### Running Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Linting
```bash
npm run lint
```

## Key Concepts

### 🧩 Skills
Skills are reusable plugins that extend the agent's functionality. They are typically located in `~/.agents/skills` or `~/.codex/skills` directories. Skills can be enabled to add domain-specific knowledge or capabilities to the agent.

### 🗂️ Task Planner
The task planner is an experimental feature that helps break down complex requests into manageable steps. It can be enabled by setting the `PIECODE_ENABLE_PLANNER=1` environment variable.

### 📺 TUI
The Terminal User Interface provides a full-screen experience with:
- Live model status
- Last turn duration
- Last tool used
- Real-time conversation flow

## License
[Insert License Information Here]

## Contributing
[Insert Contributing Guidelines Here]


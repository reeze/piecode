# Pie Code Agent

## Project Overview
Pie Code is a oding agent designed to assist with software engineering tasks. It provides an interactive terminal interface for model-driven tool use, including shell commands, file operations, and task planning capabilities.

## Key Features
- Interactive terminal agent loop with TUI (Terminal User Interface)
- Model-driven tool use: `shell`, `read_file`, `write_file`, `list_files`
- Workspace path sandboxing for safe file operations
- Shell command approval mode for security
- Support for multiple AI providers:
  - Anthropic (preferred)
  - OpenAI-compatible APIs
  - Seed / Volcengine (OpenAI-compatible endpoint)
  - Codex login state
- Skills system (plugins) for extending functionality
- Lightweight pre-planning before execution
- Task planner for complex workflows

## Tech Stack
- Node.js 18+
- JavaScript (ES modules)
- Axios for HTTP requests
- JSDOM for DOM manipulation
- Jest for testing
- ESLint + Prettier for code quality

## Project Structure
```
.
├── src/
│   ├── cli.js                 # Main CLI entry point
│   └── lib/
│       ├── agent.js           # Core agent logic
│       ├── display.js         # Display utilities
│       ├── prompt.js          # Prompt handling
│       ├── providers.js       # AI provider implementations
│       ├── skillCreator.js    # Skill creation utilities
│       ├── skills.js          # Skills management
│       ├── taskPlanner.js     # Task planning logic
│       ├── tools.js           # Tool implementations
│       └── tui.js             # TUI interface
├── __tests__/                 # Test files
├── CLAUDE_CODE_LESSONS.md     # Lessons from Claude Code
├── IMPROVEMENTS.md            # Project improvement ideas
├── README.md                  # Project documentation
├── package.json               # Dependencies and scripts
└── AGENT.md                   # This file
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
```bash
export ANTHROPIC_API_KEY="your-api-key"
export ANTHROPIC_MODEL="claude-3-5-sonnet-latest"  # optional
```

#### OpenAI-compatible
```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"  # optional
export OPENAI_MODEL="gpt-4.1-mini"                 # optional
```

#### Seed / Volcengine
```bash
export SEED_API_KEY="your-api-key"
export SEED_BASE_URL="https://ark.cn-beijing.volces.com/api/coding"  # optional
export SEED_MODEL="doubao-seed-code-preview-latest"                  # optional
```

#### Codex
```bash
codex login  # Follow login instructions
export CODEX_MODEL="gpt-5-codex"  # optional
```

#### Persistent Settings
Create `~/.piecode/settings.json` for persistent configuration:
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
- `/help` show help
- `/exit` quit
- `/clear` clear conversation memory
- `/approve on|off` toggle shell auto approval
- `/model` show active provider/model
- `/skills` show active skills
- `/skills list` list discovered skills
- `/skills use <name>` enable a skill
- `/skills off <name>` disable a skill
- `/skills clear` disable all skills
- `/use <name>` alias for enabling a skill

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

### Skills
Skills are reusable plugins that extend the agent's functionality. They are typically located in `~/.agents/skills` or `~/.codex/skills` directories.

### Task Planner
The task planner is an experimental feature that helps break down complex requests into manageable steps. It can be enabled with `PIECODE_ENABLE_PLANNER=1`.

### TUI
The Terminal User Interface provides a full-screen experience with live model status, last turn duration, and last tool used.

## License
[Insert License Information Here]

## Contributing
[Insert Contributing Guidelines Here]

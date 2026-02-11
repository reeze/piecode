# PieCode Improvement Plan

This document outlines concrete ways to improve the PieCode agent based on codebase analysis.

---

## 🔧 Immediate Improvements (Can implement now)

### 1. Better Error Handling
- Add try-catch blocks in critical paths
- Implement graceful degradation when tools fail
- Add error recovery mechanisms
- Provide actionable error messages to users

### 2. Tool System Expansion
Add these new tools to `src/lib/tools.js`:

```javascript
// Git operations
- git_status: { cwd?: string }
- git_diff: { file?: string, staged?: boolean }
- git_log: { max_count?: number, file?: string }
- git_branch: {}

// Search operations
- search_files: { pattern: string, path?: string, glob?: string }
- grep: { pattern: string, path?: string, options?: string }

// Package management
- npm_run: { script: string, args?: string[] }
- npm_install: { packages?: string[], dev?: boolean }

// Code analysis
- analyze_imports: { path: string }
- find_duplicates: { path: string }
```

### 3. Smarter Shell Command Classification
Expand in `src/lib/tools.js`:

```javascript
const SAFE_COMMANDS = new Set([
  // Existing...
  "ls", "pwd", "cat", "echo", "head", "tail",
  // Add more safe commands
  "which", "whereis", "file", "stat",
  "dirname", "basename", "realpath",
  "tar", "zip", "unzip", "gzip", "gunzip",
  "curl", "wget", "ping",
  "date", "whoami", "uname",
]);

const DANGEROUS_COMMANDS = new Set([
  // Existing...
  "rm", "rmdir", "mv", "cp", "chmod", "chown",
  // Add more dangerous commands
  "curl -o", "wget -O",  // with output flags
  "eval", "exec",
  "source", ".",
  "ssh", "scp", "sftp",
  "nc", "netcat",
  "base64 -d",  // decode could be dangerous
]);
```

### 4. Session Persistence
Create `src/lib/session.js`:

```javascript
export class SessionManager {
  constructor(workspaceDir) {
    this.sessionFile = path.join(workspaceDir, '.piecode', 'session.json');
  }

  async save(history, metadata = {}) {
    // Save conversation history
  }

  async load() {
    // Load previous session
  }

  async clear() {
    // Clear session data
  }
}
```

---

## 🚀 Architecture Improvements (Medium-term)

### 5. Modularize Large Files

Split these monolithic files:

**`src/cli.js` (600+ lines)** →
```
src/cli/
├── index.js          # Entry point
├── parser.js         # Argument parsing
├── commands.js       # Command handlers
├── session.js        # Session management
└── help.js           # Help text
```

**`src/lib/providers.js` (500+ lines)** →
```
src/providers/
├── index.js          # Provider factory
├── base.js           # Base provider class
├── anthropic.js      # Anthropic implementation
├── openai.js         # OpenAI implementation
├── codex.js          # Codex CLI implementation
└── seed.js           # Seed/Volcengine implementation
```

**`src/lib/agent.js` (400+ lines)** →
```
src/core/
├── agent.js          # Core agent logic
├── session.js        # Session state
├── history.js        # Conversation history
└── context.js        # Context management
```

### 6. Configuration Management

Create `src/config/index.js`:

```javascript
export class ConfigManager {
  constructor() {
    this.globalConfig = this.loadGlobalConfig();
    this.workspaceConfig = this.loadWorkspaceConfig();
  }

  loadGlobalConfig() {
    const configPath = path.join(os.homedir(), '.piecode', 'config.json');
    // Load and validate
  }

  loadWorkspaceConfig() {
    const configPath = path.join(process.cwd(), '.piecode', 'config.json');
    // Load and validate
  }

  get(key, defaultValue) {
    // Workspace config overrides global
  }

  set(key, value, scope = 'workspace') {
    // Set configuration value
  }
}
```

### 7. Security Enhancements

Create `src/security/permissions.js`:

```javascript
export class PermissionManager {
  constructor(config) {
    this.rules = config.rules || [];
  }

  canExecute(command) {
    // Check against whitelist/blacklist
  }

  requiresApproval(tool, input) {
    // Determine if approval needed
  }

  auditLog(action, result) {
    // Log all actions
  }
}
```

---

## 🎯 Advanced Features (Longer-term)

### 8. MCP (Model Context Protocol) Support

Create `src/mcp/`:

```javascript
// src/mcp/client.js
export class MCPClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.tools = [];
  }

  async connect() {
    // Connect to MCP server
  }

  async discoverTools() {
    // Get available tools from server
  }

  async callTool(name, args) {
    // Execute tool via MCP
  }
}
```

### 9. Plugin System

Create `src/plugins/`:

```javascript
// src/plugins/manager.js
export class PluginManager {
  constructor(pluginDir) {
    this.plugins = new Map();
    this.pluginDir = pluginDir;
  }

  async loadPlugin(name) {
    // Load and validate plugin
  }

  async unloadPlugin(name) {
    // Cleanup and unload
  }

  getTool(name) {
    // Get tool from plugin
  }

  listPlugins() {
    // List loaded plugins
  }
}

// Plugin interface
export interface Plugin {
  name: string;
  version: string;
  tools: ToolDefinition[];
  activate(): void;
  deactivate(): void;
}
```

### 10. Sub-Agent Collaboration

Create `src/core/subagent.js`:

```javascript
export class SubAgent {
  constructor(parentAgent, task) {
    this.parent = parentAgent;
    this.task = task;
    this.status = 'idle';
  }

  async execute() {
    // Run task independently
  }

  async reportProgress() {
    // Send progress to parent
  }

  async delegate(subTask) {
    // Create child sub-agent
  }
}

export class AgentOrchestrator {
  constructor() {
    this.agents = new Map();
  }

  async spawnAgent(task) {
    // Create and manage sub-agent
  }

  async coordinate(agents) {
    // Coordinate multiple agents
  }
}
```

### 11. Intelligent Code Analysis

Create `src/analysis/`:

```javascript
// src/analysis/ast.js
export class ASTAnalyzer {
  async parseFile(filePath) {
    // Parse JavaScript/TypeScript
  }

  findDependencies(ast) {
    // Extract import/require statements
  }

  findExports(ast) {
    // Extract exported symbols
  }

  calculateComplexity(ast) {
    // Calculate cyclomatic complexity
  }
}

// src/analysis/dependencies.js
export class DependencyGraph {
  constructor() {
    this.graph = new Map();
  }

  async build(rootPath) {
    // Build dependency graph
  }

  findCircularDependencies() {
    // Detect cycles
  }

  findUnusedDependencies() {
    // Find orphaned code
  }
}
```

---

## 📊 Quality Improvements

### 12. Testing

Create test structure:

```
__tests__/
├── unit/
│   ├── tools.test.js
│   ├── agent.test.js
│   └── providers.test.js
├── integration/
│   ├── agent-loop.test.js
│   └── cli.test.js
└── fixtures/
    └── sample-project/
```

Add tests for:
- Each tool's success and error cases
- Provider API interactions (mocked)
- Agent decision-making logic
- Configuration loading
- Security validations

### 13. Performance

Optimizations to implement:

```javascript
// Streaming responses
async function* streamResponse(provider, messages) {
  // Yield chunks as they arrive
}

// File operation caching
class FileCache {
  get(path) { /* ... */ }
  set(path, content) { /* ... */ }
  invalidate(path) { /* ... */ }
}

// Lazy module loading
const heavyModule = () => import('./heavy-module.js');
```

### 14. Documentation

Create:
- `docs/API.md` - API reference
- `docs/ARCHITECTURE.md` - System design
- `docs/CONTRIBUTING.md` - Contribution guide
- `examples/` - Working example projects
- Video tutorials for common workflows

---

## 💡 Most Impactful Quick Wins

Prioritized by impact vs effort:

| Priority | Improvement | Impact | Effort |
|----------|-------------|--------|--------|
| 1 | Add `git` tool | Essential for most workflows | Low |
| 2 | Add `search_files` tool | Find code faster | Low |
| 3 | Session persistence | Never lose work | Medium |
| 4 | Better error messages | Easier debugging | Low |
| 5 | Expand safe/dangerous command lists | Better security | Low |
| 6 | Add `npm_run` tool | Common workflow | Low |
| 7 | Configuration validation | Fewer bugs | Medium |
| 8 | Tool usage analytics | Understand patterns | Medium |

---

## Implementation Strategy

1. **Phase 1 (Week 1-2)**: Quick wins - tools, error handling, security
2. **Phase 2 (Week 3-4)**: Architecture - modularization, config system
3. **Phase 3 (Month 2)**: Advanced features - MCP, plugins, sub-agents
4. **Phase 4 (Ongoing)**: Quality - tests, docs, performance

---

## Success Metrics

- [ ] Tool success rate > 95%
- [ ] Average response time < 3s
- [ ] Zero data loss (session persistence)
- [ ] Test coverage > 80%
- [ ] User satisfaction score > 4.5/5

---

*Generated from codebase analysis on $(date)*

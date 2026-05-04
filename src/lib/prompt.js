function renderActiveSkillsSection(activeSkills = []) {
  const skills = Array.isArray(activeSkills) ? activeSkills : [];
  if (skills.length === 0) return [];

  const lines = ["", "ACTIVE SKILLS:"];
  for (const rawSkill of skills) {
    if (typeof rawSkill === "string") {
      const name = rawSkill.trim();
      if (!name) continue;
      lines.push(`- ${name}`);
      continue;
    }
    if (!rawSkill || typeof rawSkill !== "object") continue;
    const name = String(rawSkill.name || rawSkill.id || "unnamed-skill").trim();
    const path = String(rawSkill.path || "").trim();
    const content = String(rawSkill.content || "").trim();
    const label = path ? `${name} (${path})` : name;
    lines.push(`- ${label}`);
    if (content) {
      const excerpt = content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
      if (excerpt) lines.push(`  guidance: ${excerpt.slice(0, 260)}`);
    }
  }
  if (lines.length === 2) return [];
  lines.push("Apply these skill instructions when relevant, but keep output focused on the user request.");
  return lines;
}

function renderActivePluginsSection(activePlugins = []) {
  const plugins = Array.isArray(activePlugins) ? activePlugins : [];
  if (plugins.length === 0) return [];

  const lines = ["", "ACTIVE PLUGINS:"];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") continue;
    const name = String(plugin.name || "unnamed-plugin").trim();
    const path = String(plugin.path || "").trim();
    const description = String(plugin.description || "").replace(/\s+/g, " ").trim();
    const label = path ? `${name} (${path})` : name;
    lines.push(`- ${label}${description ? `: ${description.slice(0, 220)}` : ""}`);

    const allow = Array.isArray(plugin?.permissions?.tools?.allow) ? plugin.permissions.tools.allow : [];
    if (allow.length > 0) {
      lines.push(`  tool guidance: prefer/limit to ${allow.join(", ")} when this plugin applies; this is not a permission grant.`);
    }

    const context = plugin?.context && typeof plugin.context === "object" ? plugin.context : {};
    const maxCharsRaw = Number(context.maxChars ?? context.max_chars ?? 4000);
    const maxChars = Math.min(Math.max(Number.isFinite(maxCharsRaw) ? Math.round(maxCharsRaw) : 4000, 0), 12000);
    const source = String(plugin.body || plugin.content || "").trim();
    if (source && maxChars > 0) {
      const excerpt = source.length > maxChars ? `${source.slice(0, maxChars)}\n[plugin context truncated]` : source;
      lines.push("  instructions:");
      for (const line of excerpt.split("\n")) lines.push(`  ${line}`);
    }
  }
  lines.push("Plugin instructions may guide workflow and slash commands, but they do not grant extra tool permissions or bypass approval, sandboxing, or write guards.");
  return lines;
}

function renderAgentDefinitionsSection(agentDefinitions = []) {
  const definitions = Array.isArray(agentDefinitions) ? agentDefinitions : [];
  const rows = definitions
    .map((definition) => ({
      name: String(definition?.name || "").trim(),
      description: String(definition?.description || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((definition) => definition.name);
  if (rows.length === 0) return [];
  return [
    "",
    "CONFIGURED PROJECT AGENTS:",
    ...rows.map((definition) => `- ${definition.name}${definition.description ? `: ${definition.description.slice(0, 220)}` : ""}`),
    "Use the subagent tool with role, agent, or name to delegate to these .AGENTS definitions when helpful.",
  ];
}

function renderMemorySection(memory = null) {
  const text = typeof memory === "string" ? memory.trim() : "";
  if (!text) return [];
  return [
    "",
    "MEMORY:",
    text,
    "Memory strategy: treat MEMORY as durable context, not a scratchpad. Save only stable user preferences, recurring workflow rules, project conventions, or long-lived facts that are likely to matter in future sessions. Prefer project memory for repo-specific facts and global memory for personal preferences. Do not store secrets, credentials, one-off task details, transient plans, command outputs, or facts already captured in AGENTS.md.",
  ];
}

function renderActivePlanSection(activePlan = null) {
  if (!activePlan) return [];
  if (typeof activePlan === "string") {
    const text = activePlan.trim();
    if (!text) return [];
    return ["", "ACTIVE PLAN:", text, "Follow this plan unless tool evidence requires an adjustment."];
  }
  if (typeof activePlan !== "object") return [];

  const summary = String(activePlan.summary || "").trim();
  const steps = Array.isArray(activePlan.steps)
    ? activePlan.steps.map((step) => String(step || "").trim()).filter(Boolean)
    : [];
  const budget = Number(activePlan.toolBudget);

  if (!summary && steps.length === 0 && !Number.isFinite(budget)) return [];

  const lines = ["", "ACTIVE PLAN:"];
  if (summary) lines.push(`Summary: ${summary}`);
  if (steps.length > 0) {
    lines.push("Steps:");
    steps.slice(0, 8).forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  }
  if (Number.isFinite(budget)) lines.push(`Tool budget: ${Math.max(1, Math.round(budget))}`);
  lines.push("Follow this plan unless tool evidence requires an adjustment.");
  return lines;
}

export function buildSystemPrompt({
  workspaceDir,
  autoApprove,
  activeSkills = [],
  activePlugins = [],
  activePlan = null,
  projectInstructions = null,
  memory = null,
  nativeTools = false,
  turnPolicy = null,
  mcpEnabled = false,
  mcpServerNames = [],
  agentDefinitions = [],
}) {
  const sections = [
    "You are a general-purpose command-line agent. Adapt to the user's task, whether it is coding, writing, research, analysis, planning, or troubleshooting.",
    `Workspace root: ${workspaceDir}`,
    `Shell auto approval: ${autoApprove ? "ON" : "OFF"}`,

    "GUIDELINES:",
    "- Be concise, factual, and task-focused; ask one clarifying question when requirements are blocked or ambiguous.",
    "- Use tools when you need current information, repository context, or to perform an action; avoid repeated identical read-only calls.",
    "- Verify repository facts before claiming them. Prefer read/list/search before shell, and prefer rg for code search.",
    "- Before editing existing files, read them first. Prefer targeted edits; use full rewrites only when intentional.",
    "- For non-trivial work, briefly state the plan, proceed step by step, then summarize changes and validation.",
    "- Use todo tracking only for real multi-step work. Save memory sparingly: durable, non-secret preferences or project facts only; avoid duplicates and transient task details.",
    "- Treat loaded PROJECT INSTRUCTIONS and MEMORY as already available; do not re-read them unless exact quotes are needed.",
    "- Inspect relevant attachments; briefly note when an attachment is ignored as irrelevant.",

    "COMPLEX TASK EXECUTION:",
    "- For multi-step or uncertain work, briefly restate a 3-7 step plan before acting.",
    "- If a command or approach fails twice, switch strategy using new evidence instead of retrying blindly; do not simply stop unless you are truly blocked.",
    "- When a tool result is repeated or unchanged, infer what it means, choose a different action if useful, or finalize from the evidence already collected.",
    "- Before finalizing, mention validation status and call out remaining risks.",
  ];

  if (!nativeTools) {
    const textToolNames = [
      "shell",
      "read_file",
      "read_files",
      "edit_file",
      "write_file",
      "replace_in_files",
      "list_files",
      "glob_files",
      "find_files",
      "rg",
      "grep",
      "search_files",
      "web_search",
      "search_web",
      "subagent",
      "collaborate",
      "memory_write",
      "remember",
      "git_status",
      "git_diff",
      "run_tests",
      "todo_write",
      "todowrite",
      ...(mcpEnabled
        ? [
            "list_mcp_servers",
            "list_mcp_tools",
            "mcp_call_tool",
            "list_mcp_resources",
            "list_mcp_resource_templates",
            "read_mcp_resource",
          ]
        : []),
    ];
    sections.push(
      "RESPONSE FORMAT:",
      "You must respond with strict JSON only. Choose one of these formats:",

      "1. Final Answer (when you have all necessary information):",
      '{"type":"final","message":"Your complete response here"}',

      "2. Tool Use (when you need to gather information or perform an action):",
      `{"type":"tool_use","tool":"${textToolNames.join("|")}","input":{...},"reason":"Brief explanation of why this tool is needed","thought":"Your reasoning for choosing this tool"}`,

      "3. Thought Process (optional, only when a brief visible reasoning step helps):",
      '{"type":"thought","content":"Short reasoning update"}',

      "TOOLS:",
      "- Inspect/search: read_file, read_files, list_files, glob_files, find_files, rg/search_files/grep, git_status, git_diff.",
      "- Change/validate: edit_file, write_file, replace_in_files, shell, run_tests.",
      "- Delegate/context: subagent, collaborate, todo_write/todowrite, memory_write/remember, web_search/search_web.",
      "- Prefer rg for code search; prefer edit_file for existing-file edits; write_file is for new files or explicit rewrites.",
      "- memory_write scope is project or global; never store secrets.",
      "- todo status is pending, in_progress, or completed.",
      ...(mcpEnabled
        ? [
            "- list_mcp_servers: {} - List configured MCP servers",
            "- list_mcp_tools: { server?: string } - List available tools from MCP server(s)",
            "- mcp_call_tool: { server: string, tool: string, input?: object } - Call a tool exposed by an MCP server",
            "- list_mcp_resources: { server?: string, cursor?: string } - List resources from MCP server(s)",
            "- list_mcp_resource_templates: { server?: string, cursor?: string } - List MCP resource templates",
            "- read_mcp_resource: { server: string, uri: string } - Read an MCP resource by URI",
          ]
        : []),

      "EXAMPLE:",
      '{"type":"tool_use","tool":"rg","input":{"pattern":"functionName\\(","path":"src"},"reason":"Find references before editing"}',

      "CRITICAL:",
      "- Your entire response must be valid JSON",
      "- No markdown formatting outside the JSON",
      "- No explanatory text before or after the JSON"
    );
  }

  if (mcpEnabled) {
    const names = Array.isArray(mcpServerNames)
      ? mcpServerNames.map((name) => String(name || "").trim()).filter(Boolean)
      : [];
    const serverLine = names.length > 0 ? names.join(", ") : "(configured)";
    sections.push("", `MCP servers available: ${serverLine}`);
  }

  if (activeSkills.length > 0) {
    sections.push(...renderActiveSkillsSection(activeSkills));
  }

  if (activePlugins.length > 0) {
    sections.push(...renderActivePluginsSection(activePlugins));
  }

  sections.push(...renderAgentDefinitionsSection(agentDefinitions));

  sections.push(...renderMemorySection(memory));

  if (activePlan) {
    sections.push(...renderActivePlanSection(activePlan));
  }

  if (projectInstructions) {
    const projectText =
      typeof projectInstructions === "string"
        ? projectInstructions
        : typeof projectInstructions?.content === "string"
          ? `source: ${projectInstructions.source || "unknown"}\n${projectInstructions.content}`
          : "";
    if (projectText.trim()) {
      sections.push("", "PROJECT INSTRUCTIONS:", projectText);
    }
  }

  if (turnPolicy && typeof turnPolicy === "object") {
    const lines = [];
    lines.push("", "TURN EXECUTION CONTRACT:");
    if (turnPolicy.name) lines.push(`- Intent: ${turnPolicy.name}`);
    if (Number.isFinite(turnPolicy.maxToolCalls)) {
      lines.push(`- Maximum tool calls this turn: ${turnPolicy.maxToolCalls}`);
    }
    if (turnPolicy.forceFinalizeAfterTool) {
      lines.push("- After the final allowed tool result, provide final answer and stop.");
    }
    if (turnPolicy.disableTodos) {
      lines.push("- Do not call todo_write/todowrite for this turn.");
    }
    if (Array.isArray(turnPolicy.allowedTools) && turnPolicy.allowedTools.length > 0) {
      lines.push(`- Allowed tools for this turn: ${turnPolicy.allowedTools.join(", ")}`);
    }
    if (turnPolicy.note) {
      lines.push(`- Note: ${turnPolicy.note}`);
    }
    if (turnPolicy.requireCommitMessage) {
      lines.push("- Final answer must include a suggested commit message.");
    }
    sections.push(...lines);
  }

  return sections.join("\n");
}

const KNOWN_TOOL_NAMES = new Set([
  "shell",
  "read_file",
  "read_files",
  "write_file",
  "edit_file",
  "apply_patch",
  "replace_in_files",
  "list_files",
  "glob_files",
  "find_files",
  "rg",
  "grep",
  "search_files",
  "web_search",
  "search_web",
  "subagent",
  "collaborate",
  "memory_write",
  "remember",
  "git_status",
  "git_diff",
  "run_tests",
  "todo_write",
  "todowrite",
  "list_mcp_servers",
  "list_mcp_tools",
  "mcp_call_tool",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

function toJsonText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function truncateForHistory(text, maxChars) {
  const source = String(text || "");
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars)}\n[truncated for context budget]`;
}

function sanitizeOpenAIToolMessagePairs(messages = []) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];

  for (let i = 0; i < input.length; i += 1) {
    const msg = input[i];
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (msg?.role !== "assistant" || toolCalls.length === 0) {
      if (msg?.role === "tool") {
        // Drop orphan tool outputs; OpenAI-compatible APIs require a matching
        // assistant tool call in the same message history.
        continue;
      }
      out.push(msg);
      continue;
    }

    const callIds = toolCalls.map((call) => String(call?.id || "").trim()).filter(Boolean);
    if (callIds.length !== toolCalls.length) {
      continue;
    }

    const followingToolMessages = [];
    let j = i + 1;
    while (j < input.length && input[j]?.role === "tool") {
      followingToolMessages.push(input[j]);
      j += 1;
    }

    const outputsById = new Map();
    for (const toolMsg of followingToolMessages) {
      const id = String(toolMsg?.tool_call_id || "").trim();
      if (id) outputsById.set(id, toolMsg);
    }

    const hasAllOutputs = callIds.every((id) => outputsById.has(id));
    if (!hasAllOutputs) {
      i = j - 1;
      continue;
    }

    out.push(msg);
    for (const id of callIds) {
      out.push(outputsById.get(id));
    }
    i = j - 1;
  }

  return out;
}

function extractFirstJsonObject(sourceText = "") {
  const source = String(sourceText || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function normalizeParsedAction(parsed = null) {
  if (!parsed || typeof parsed !== "object") return null;
  const typeRaw = String(parsed.type || "").trim();
  const type = typeRaw.toLowerCase();

  if (type === "final" && typeof parsed.message === "string") {
    return { type: "final", message: parsed.message };
  }
  if (type === "thought" && typeof parsed.content === "string") {
    return { type: "thought", content: parsed.content };
  }

  if (type === "tool_use" && parsed.tool) {
    const toolName = String(parsed.tool || "").trim();
    if (!toolName) return null;
    return {
      type: "tool_use",
      tool: toolName,
      input: parsed.input && typeof parsed.input === "object" ? parsed.input : {},
      reason: String(parsed.reason || ""),
      thought: String(parsed.thought || ""),
    };
  }

  if (type === "tool_uses" && Array.isArray(parsed.calls)) {
    const calls = parsed.calls
      .map((call) => normalizeParsedAction({ ...call, type: "tool_use" }))
      .filter((call) => call?.type === "tool_use");
    if (calls.length > 0) return { type: "tool_uses", calls };
  }

  if (KNOWN_TOOL_NAMES.has(type)) {
    return {
      type: "tool_use",
      tool: type,
      input: parsed.input && typeof parsed.input === "object" ? parsed.input : {},
      reason: String(parsed.reason || ""),
      thought: String(parsed.thought || ""),
    };
  }

  return null;
}

export function formatHistory(messages) {
  const maxToolResultChars = 4000;
  const maxMessageChars = 6000;
  const entries = Array.isArray(messages) ? messages : [];
  const lines = [];

  for (const msg of entries) {
    const role = String(msg?.role || "user").toUpperCase();
    const raw = msg?.content;
    const text = toJsonText(raw);
    let parsed = null;
    if (typeof text === "string") {
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = null;
        }
      }
    }

    if (parsed && typeof parsed === "object") {
      const type = String(parsed.type || "").toLowerCase();
      if (type === "tool_use") {
        const toolName = String(parsed.tool || "unknown");
        lines.push(`${role}: Tool Use: ${toolName}`);
        if (parsed.reason) lines.push(`Reason: ${String(parsed.reason)}`);
        if (parsed.thought) lines.push(`Thought: ${String(parsed.thought)}`);
        if (parsed.input && typeof parsed.input === "object" && Object.keys(parsed.input).length > 0) {
          lines.push(`Input: ${JSON.stringify(parsed.input)}`);
        }
        continue;
      }

      if (type === "tool_result") {
        const toolName = String(parsed.tool || "unknown");
        const resultText = toJsonText(parsed.result);
        lines.push(`${role}: Tool Result: ${toolName} (result chars: ${resultText.length})`);
        lines.push(truncateForHistory(resultText, maxToolResultChars));
        continue;
      }

      if (type === "tool_uses" && Array.isArray(parsed.calls)) {
        const names = parsed.calls.map((call) => String(call?.tool || "unknown")).join(", ");
        lines.push(`${role}: Tool Uses: ${names}`);
        continue;
      }

      if (type === "tool_results" && Array.isArray(parsed.results)) {
        lines.push(`${role}: Tool Results: ${parsed.results.length} result(s)`);
        for (const item of parsed.results.slice(0, 8)) {
          const toolName = String(item?.tool || "unknown");
          const resultText = toJsonText(item?.result);
          lines.push(`- ${toolName} (result chars: ${resultText.length})`);
          lines.push(truncateForHistory(resultText, maxToolResultChars));
        }
        continue;
      }

      if (type === "thought") {
        lines.push(`${role}: Thought: ${String(parsed.content || "")}`);
        continue;
      }

      if (type === "final") {
        lines.push(`${role}: Final: ${String(parsed.message || "")}`);
        continue;
      }
    }

    const attachments = Array.isArray(msg?.attachments) ? msg.attachments.filter((item) => item?.type === "image") : [];
    if (attachments.length > 0) {
      const summaries = attachments.map((item) => `${item.mimeType || "image"} ${item.bytes || 0} bytes`).join(", ");
      lines.push(`${role}: ${truncateForHistory(text, maxMessageChars)}`);
      lines.push(`${role}: Attachments: ${summaries}`);
    } else {
      lines.push(`${role}: ${truncateForHistory(text, maxMessageChars)}`);
    }
  }

  return lines.join("\n");
}

export function parseModelAction(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { type: "unknown", raw: text };
  }

  const parseCandidate = (candidate) => {
    if (!candidate) return null;
    try {
      return normalizeParsedAction(JSON.parse(candidate));
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(trimmed);
  if (direct) return direct;

  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (jsonBlockMatch) {
    const block = parseCandidate(String(jsonBlockMatch[1] || "").trim());
    if (block) return block;
  }

  const embedded = parseCandidate(extractFirstJsonObject(trimmed));
  if (embedded) return embedded;

  const toolLineMatch = trimmed.match(/tool\s*(?:use)?\s*:\s*([a-zA-Z0-9_.-]+)/i);
  if (toolLineMatch) {
    const tool = String(toolLineMatch[1] || "").trim().toLowerCase();
    let input = {};
    const inputSection = trimmed.match(/input\s*:\s*([\s\S]+)$/i);
    if (inputSection?.[1]) {
      const maybeJson = extractFirstJsonObject(inputSection[1]) || String(inputSection[1]).trim();
      try {
        const parsedInput = JSON.parse(maybeJson);
        input = parsedInput && typeof parsedInput === "object" ? parsedInput : {};
      } catch {
        input = {};
      }
    }
    return {
      type: "tool_use",
      tool,
      input,
      reason: "Parsed from text pattern",
      thought: "",
    };
  }

  return { type: "final", message: trimmed };
}

function buildMcpToolDefinitions({ mcpEnabled = false, mcpServerNames = [] } = {}) {
  if (!mcpEnabled) return [];
  const names = Array.isArray(mcpServerNames)
    ? mcpServerNames.map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  const serverHint = names.length > 0 ? `Configured servers: ${names.join(", ")}.` : "Use list_mcp_servers first.";
  return [
    {
      name: "list_mcp_servers",
      description: `List configured MCP servers. ${serverHint}`,
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_mcp_tools",
      description: "List available tools from one MCP server or all configured servers.",
      input_schema: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name (optional)" },
        },
      },
    },
    {
      name: "mcp_call_tool",
      description: "Call a tool exposed by an MCP server.",
      input_schema: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          tool: { type: "string", description: "MCP tool name" },
          input: { type: "object", description: "Tool input object" },
        },
        required: ["server", "tool"],
      },
    },
    {
      name: "list_mcp_resources",
      description: "List MCP resources from one server or all servers.",
      input_schema: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name (optional)" },
          cursor: { type: "string", description: "Pagination cursor (optional)" },
        },
      },
    },
    {
      name: "list_mcp_resource_templates",
      description: "List MCP resource templates from one server or all servers.",
      input_schema: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name (optional)" },
          cursor: { type: "string", description: "Pagination cursor (optional)" },
        },
      },
    },
    {
      name: "read_mcp_resource",
      description: "Read an MCP resource by URI.",
      input_schema: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          uri: { type: "string", description: "Resource URI" },
        },
        required: ["server", "uri"],
      },
    },
  ];
}

export function buildToolDefinitions(nativeTools = false, options = {}) {
  const mcpEnabled = Boolean(options?.mcpEnabled);
  const mcpServerNames = Array.isArray(options?.mcpServerNames) ? options.mcpServerNames : [];
  const baseTools = [
    {
      name: "shell",
      description:
        "Run a shell command in the workspace directory. Returns stdout/stderr. Prefer read/list/search for information gathering. Auto-approved safe commands only.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read the contents of a file at the given path (relative to workspace root).",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
        },
        required: ["path"],
      },
    },
    {
      name: "read_files",
      description: "Read multiple files in one call.",
      input_schema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "List of relative file paths to read",
          },
          max_chars_per_file: {
            type: "integer",
            description: "Maximum characters returned per file (default: 4000)",
          },
          max_total_chars: {
            type: "integer",
            description: "Total character cap across all returned files (default: 24000)",
          },
        },
        required: ["paths"],
      },
    },
    {
      name: "edit_file",
      description:
        "Make a surgical replacement in an existing file by replacing oldText with newText. oldText must match exactly once.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to existing file" },
          oldText: { type: "string", description: "Exact text to replace (must match uniquely)" },
          newText: { type: "string", description: "Replacement text" },
          old_text: { type: "string", description: "Alias for oldText" },
          new_text: { type: "string", description: "Alias for newText" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Write content to a file at the given path (relative to workspace root). Creates parent directories if needed.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "replace_in_files",
      description:
        "Preview or apply bulk replacements across files. Useful for safe large-scale refactors.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative root path to scan (default: .)" },
          find: { type: "string", description: "Text or regex pattern to find" },
          replace: { type: "string", description: "Replacement text (default: empty)" },
          file_pattern: { type: "string", description: "Glob filter, e.g. '**/*.js'" },
          max_files: { type: "integer", description: "Maximum files to scan (default: 200)" },
          max_replacements: { type: "integer", description: "Safety cap for total replacements" },
          case_sensitive: { type: "boolean", description: "Case-sensitive matching (default: true)" },
          use_regex: { type: "boolean", description: "Treat find as regular expression" },
          apply: { type: "boolean", description: "Apply changes (false = preview only)" },
        },
        required: ["find"],
      },
    },
    {
      name: "list_files",
      description:
        "List files and directories at the given path. Returns relative paths. Use max_entries to limit results.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to directory (default: current)" },
          max_entries: { type: "integer", description: "Maximum entries to return (default: 200)" },
          include_hidden: { type: "boolean", description: "Include hidden files/directories (default: false)" },
          include_ignored: {
            type: "boolean",
            description: "Include heavy ignored dirs like .git and node_modules (default: false)",
          },
        },
      },
    },
    {
      name: "glob_files",
      description: "Find files by glob pattern.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative root path to scan (default: .)" },
          pattern: { type: "string", description: "Glob pattern (default: **/*)" },
          max_results: { type: "integer", description: "Maximum matches to return (default: 200)" },
          include_hidden: { type: "boolean", description: "Include dotfiles/directories" },
        },
      },
    },
    {
      name: "find_files",
      description: "Find files by fuzzy path text match.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative root path to scan (default: .)" },
          query: { type: "string", description: "Case-insensitive path substring to match" },
          max_results: { type: "integer", description: "Maximum matches to return (default: 200)" },
          include_hidden: { type: "boolean", description: "Include dotfiles/directories" },
        },
        required: ["query"],
      },
    },
    {
      name: "rg",
      description:
        "Fast codebase search using ripgrep semantics. Prefer this for finding symbols, definitions, references, strings, and TODOs. Excludes node_modules, .git, dist, build directories automatically.",
      input_schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern. Regex by default; set fixed_strings for literal search.",
          },
          regex: {
            type: "string",
            description: "Alias for pattern.",
          },
          query: {
            type: "string",
            description: "Alias for pattern.",
          },
          path: {
            type: "string",
            description: "Relative path to search in (default: workspace root).",
          },
          glob: {
            type: "string",
            description: "Glob pattern to filter files (e.g., '*.js', '**/*.ts').",
          },
          file_pattern: {
            type: "string",
            description: "Alias for glob.",
          },
          max_results: {
            type: "integer",
            description: "Maximum matches to return (default: 50, max: 200).",
          },
          case_sensitive: {
            type: "boolean",
            description: "Case-sensitive search (default: false).",
          },
          fixed_strings: {
            type: "boolean",
            description: "Treat pattern as literal text instead of regex (default: false).",
          },
          context_lines: {
            type: "integer",
            description: "Context lines around matches (default: 2, max: 10).",
          },
        },
      },
    },
    {
      name: "grep",
      description: "Alias for rg. Fast codebase search by pattern.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern" },
          regex: { type: "string", description: "Alias for pattern" },
          query: { type: "string", description: "Alias for pattern" },
          path: { type: "string", description: "Relative path to search in" },
          glob: { type: "string", description: "Glob pattern to filter files" },
          file_pattern: { type: "string", description: "Alias for glob" },
          max_results: { type: "integer", description: "Maximum matches to return" },
          case_sensitive: { type: "boolean", description: "Case-sensitive search" },
          fixed_strings: { type: "boolean", description: "Literal search instead of regex" },
          context_lines: { type: "integer", description: "Context lines around matches" },
        },
      },
    },
    {
      name: "search_files",
      description:
        "Compatibility alias for rg. Search for patterns in files using ripgrep (preferred) or grep.",
      input_schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern. Regex by default; set fixed_strings for literal search.",
          },
          path: {
            type: "string",
            description: "Relative path to search in (default: workspace root)",
          },
          regex: {
            type: "string",
            description: "Regular expression pattern to search for",
          },
          query: {
            type: "string",
            description: "Alias for regex; accepted for compatibility",
          },
          file_pattern: {
            type: "string",
            description: "Glob pattern to filter files (e.g., '*.js', '*.ts')",
          },
          glob: {
            type: "string",
            description: "Alias for file_pattern",
          },
          max_results: {
            type: "integer",
            description: "Maximum results to return (default: 50, max: 200)",
          },
          case_sensitive: {
            type: "boolean",
            description: "Case-sensitive search (default: false)",
          },
          fixed_strings: {
            type: "boolean",
            description: "Treat pattern as literal text instead of regex",
          },
          context_lines: {
            type: "integer",
            description: "Context lines around matches (default: 2, max: 10)",
          },
        },
      },
    },
    {
      name: "web_search",
      description:
        "Search the web for current external information. Returns structured title, URL, and snippet results. Use only when local code/docs are insufficient or up-to-date external facts are needed.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          q: { type: "string", description: "Alias for query" },
          max_results: { type: "integer", description: "Maximum results to return (default: 5, max: 10)" },
          site: { type: "string", description: "Optional domain filter, e.g. openai.com" },
          recency_days: { type: "integer", description: "Optional recent-days filter where provider supports it" },
          provider: { type: "string", enum: ["brave", "tavily", "serper"], description: "Optional provider override" },
        },
        required: ["query"],
      },
    },
    {
      name: "search_web",
      description: "Alias for web_search.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          q: { type: "string", description: "Alias for query" },
          max_results: { type: "integer", description: "Maximum results to return" },
          site: { type: "string", description: "Optional domain filter" },
          recency_days: { type: "integer", description: "Optional recent-days filter" },
          provider: { type: "string", enum: ["brave", "tavily", "serper"], description: "Optional provider override" },
        },
        required: ["query"],
      },
    },
    {
      name: "subagent",
      description:
        "Spawn a read-only subagent to investigate an independent codebase question and return concise findings. Use role/agent/name to delegate to a configured .AGENTS definition; subagents cannot modify files.",
      input_schema: {
        type: "object",
        properties: {
          role: {
            type: "string",
            description: "Optional configured .AGENTS role/name to delegate to, e.g. security-reviewer.",
          },
          agent: {
            type: "string",
            description: "Alias for role.",
          },
          name: {
            type: "string",
            description: "Alias for role.",
          },
          task: {
            type: "string",
            description: "Specific investigation task for the subagent.",
          },
          context: {
            type: "string",
            description: "Optional focused context or constraints for the subagent.",
          },
          mode: {
            type: "string",
            enum: ["analysis", "readonly"],
            description: "Read-only investigation mode (default: analysis).",
          },
          tool_budget: {
            type: "integer",
            description: "Maximum child tool budget, 1-6 (default: 3).",
          },
        },
        required: ["task"],
      },
    },
    {
      name: "collaborate",
      description:
        "Run design, implementation-planning, and review agents with shared context. Use for complex tasks before making changes.",
      input_schema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task for the collaborating agents." },
          context: { type: "string", description: "Optional additional shared context." },
        },
        required: ["task"],
      },
    },
    {
      name: "memory_write",
      description:
        "Append durable memory to project (.piecode/MEMORY.md) or global (~/.piecode/MEMORY.md) scope. Use for stable preferences, project conventions, and recurring facts; never store secrets.",
      input_schema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["project", "global"],
            description: "Memory scope: project for this repository, global for personal user-wide preferences.",
          },
          content: { type: "string", description: "Concise durable memory note to append." },
        },
        required: ["content"],
      },
    },
    {
      name: "remember",
      description: "Alias for memory_write. Append durable project/global memory.",
      input_schema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["project", "global"] },
          content: { type: "string", description: "Concise durable memory note to append." },
        },
        required: ["content"],
      },
    },
    {
      name: "git_status",
      description: "Show git status for the current workspace.",
      input_schema: {
        type: "object",
        properties: {
          porcelain: { type: "boolean", description: "Use concise porcelain output (default: true)" },
        },
      },
    },
    {
      name: "git_diff",
      description: "Show git diff in the current workspace.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional path filter" },
          staged: { type: "boolean", description: "Show staged diff instead of unstaged" },
          context: { type: "integer", description: "Unified diff context lines (default: 3)" },
        },
      },
    },
    {
      name: "run_tests",
      description:
        "Run a test command and return structured summary with pass/fail and extracted failed tests.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run tests (default: npm test)" },
          timeout_ms: { type: "integer", description: "Command timeout in ms (default: 120000)" },
        },
      },
    },
    {
      name: "todo_write",
      description:
        "Update the task tracking todo list. Use to show progress on multi-step tasks.",
      input_schema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  ];
  const allTools = [
    ...baseTools,
    ...buildMcpToolDefinitions({
      mcpEnabled,
      mcpServerNames,
    }),
  ];

  const wantsOpenAI =
    nativeTools === "openai" || nativeTools === true || nativeTools === "openrouter" || nativeTools === "seed";
  if (wantsOpenAI) {
    return allTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
  return allTools;
}

export function buildMessages(arg1 = {}, arg2 = {}) {
  // Backward compatible signatures:
  // 1) buildMessages({ history, systemPrompt, prompt, format })
  // 2) buildMessages(historyArray, { systemPrompt, prompt, format })
  let history = [];
  let systemPrompt = "";
  let prompt = "";
  let format = "anthropic";
  if (Array.isArray(arg1)) {
    history = arg1;
    systemPrompt = arg2?.systemPrompt || "";
    prompt = arg2?.prompt || "";
    format = arg2?.format || "anthropic";
  } else {
    history = arg1?.history || [];
    systemPrompt = arg1?.systemPrompt || "";
    prompt = arg1?.prompt || "";
    format = arg1?.format || "anthropic";
  }

  const normalizeAttachments = (value) => (Array.isArray(value) ? value.filter((item) => item?.type === "image") : []);
  const toOpenAIContent = (role, content, attachments) => {
    const images = normalizeAttachments(attachments);
    if (images.length === 0) return content;
    const parts = [];
    const text = String(content ?? "");
    if (text) parts.push({ type: "text", text });
    for (const image of images) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
    if (parts.length === 0) return "";
    return parts;
  };
  const toAnthropicContent = (role, content, attachments) => {
    const images = normalizeAttachments(attachments);
    if (images.length === 0) return content;
    const parts = [];
    const text = String(content ?? "");
    if (text) parts.push({ type: "text", text });
    for (const image of images) {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.data,
        },
      });
    }
    return parts.length > 0 ? parts : "";
  };

  const toText = (value) => {
    if (typeof value === "string") return value;
    if (value == null) return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };
  const parseMaybeJson = (value) => {
    const text = toText(value).trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const asObject = (v) => (v && typeof v === "object" ? v : {});
  const openaiMode = String(format || "").toLowerCase() !== "anthropic";
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const items = Array.isArray(history) ? history : [];
  for (const msg of items) {
    const role = String(msg?.role || "user");
    const rawContent = msg?.content;
    const textContent = toText(rawContent);
    const toolCall = asObject(msg?.toolCall);
    const toolResult = asObject(msg?.toolResult);
    const toolCalls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : [];
    const toolResults = Array.isArray(msg?.toolResults) ? msg.toolResults : [];
    const parsed = parseMaybeJson(rawContent);

    if (toolCalls.length > 0) {
      const calls = toolCalls
        .map((call) => ({
          id: String(call?.id || ""),
          name: String(call?.name || ""),
          input: asObject(call?.input),
        }))
        .filter((call) => call.name);
      if (calls.length > 0) {
        if (!openaiMode) {
          const blocks = [];
          const preface = textContent && textContent !== "{}" ? textContent : "";
          if (preface) blocks.push({ type: "text", text: preface });
          for (const call of calls) {
            blocks.push({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input || {},
            });
          }
          messages.push({ role: "assistant", content: blocks });
        } else {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input || {}),
              },
            })),
          });
        }
        continue;
      }
    }

    if (toolResults.length > 0) {
      const results = toolResults
        .map((item) => ({
          id: String(item?.toolCallId || item?.id || ""),
          name: String(item?.name || ""),
          result: item?.result ?? "",
        }))
        .filter((item) => item.id);
      if (results.length > 0) {
        if (!openaiMode) {
          messages.push({
            role: "user",
            content: results.map((item) => ({
              type: "tool_result",
              tool_use_id: item.id,
              content: toText(item.result),
            })),
          });
        } else {
          for (const item of results) {
            messages.push({
              role: "tool",
              tool_call_id: item.id,
              content: toText(item.result),
            });
          }
        }
        continue;
      }
    }

    const legacyToolUse =
      parsed && String(parsed?.type || "").toLowerCase() === "tool_use"
        ? {
            id: String(parsed?._callId || ""),
            name: String(parsed?.tool || ""),
            input: asObject(parsed?.input),
            reason: String(parsed?.reason || ""),
          }
        : null;
    const legacyToolResult =
      parsed && String(parsed?.type || "").toLowerCase() === "tool_result"
        ? {
            id: String(parsed?._callId || ""),
            name: String(parsed?.tool || ""),
            result: parsed?.result ?? "",
          }
        : null;

    const isLegacyToolUse = Boolean(legacyToolUse);
    const effectiveToolCall =
      toolCall?.name
        ? {
            id: String(toolCall.id || ""),
            name: String(toolCall.name || ""),
            input: asObject(toolCall.input),
            reason: "",
          }
        : legacyToolUse;

    const effectiveToolResult =
      toolResult?.toolCallId
        ? {
            id: String(toolResult.toolCallId || ""),
            name: String(toolResult.name || ""),
            result: toolResult.result ?? "",
          }
        : legacyToolResult;

    if (!openaiMode) {
      if (effectiveToolCall?.name) {
        const blocks = [];
        const preface =
          !isLegacyToolUse && textContent && textContent !== "{}"
            ? textContent
            : effectiveToolCall.reason || "";
        if (preface) blocks.push({ type: "text", text: preface });
        blocks.push({
          type: "tool_use",
          id: effectiveToolCall.id || "",
          name: effectiveToolCall.name,
          input: effectiveToolCall.input || {},
        });
        messages.push({ role: "assistant", content: blocks });
        continue;
      }
      if (effectiveToolResult?.id) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: effectiveToolResult.id,
              content: toText(effectiveToolResult.result),
            },
          ],
        });
        continue;
      }
      const content = normalizeAttachments(msg?.attachments).length > 0
        ? toAnthropicContent(role, textContent, msg?.attachments)
        : textContent;
      messages.push({ role, content });
      continue;
    }

    if (effectiveToolCall?.name) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: effectiveToolCall.id || "",
            type: "function",
            function: {
              name: effectiveToolCall.name,
              arguments: JSON.stringify(effectiveToolCall.input || {}),
            },
          },
        ],
      });
      continue;
    }
    if (effectiveToolResult?.id) {
      messages.push({
        role: "tool",
        tool_call_id: effectiveToolResult.id,
        content: toText(effectiveToolResult.result),
      });
      continue;
    }
    const content = normalizeAttachments(msg?.attachments).length > 0
      ? toOpenAIContent(role, textContent, msg?.attachments)
      : textContent;
    messages.push({ role, content });
  }

  if (prompt) {
    messages.push({ role: "user", content: prompt });
  }

  return openaiMode ? sanitizeOpenAIToolMessagePairs(messages) : messages;
}

export function parseNativeResponse(response, format = "anthropic") {
  if (!response) {
    return { type: "final", message: String(response || "") };
  }

  if (format === "anthropic") {
    const content = Array.isArray(response.content) ? response.content : [];
    const toolUses = content.filter((b) => b?.type === "tool_use");
    if (toolUses.length > 0) {
      const textBlock = content.find((b) => b?.type === "text");
      const calls = toolUses.map((toolUse) => ({
        type: "tool_use",
        tool: toolUse.name,
        input: toolUse.input && typeof toolUse.input === "object" ? toolUse.input : {},
        reason: typeof textBlock?.text === "string" ? textBlock.text : "",
        thought: "",
        _callId: toolUse.id || "",
      }));
      if (calls.length > 1) return { type: "tool_uses", calls };
      return {
        type: "tool_use",
        ...calls[0],
      };
    }
    const textBlock = content.find((b) => b?.type === "text");
    return {
      type: "final",
      message: typeof textBlock?.text === "string" ? textBlock.text : "",
    };
  }

  // OpenAI format
  const message = response.message || response;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) {
    const calls = toolCalls.map((call) => {
      let input = {};
      try {
        input = JSON.parse(call.function?.arguments || "{}");
      } catch {
        // keep empty
      }
      return {
        type: "tool_use",
        tool: call.function?.name || "",
        input: input && typeof input === "object" ? input : {},
        reason: typeof message.content === "string" ? message.content : "",
        thought: "",
        _callId: call.id || "",
      };
    });
    if (calls.length === 1) return calls[0];
    return { type: "tool_uses", calls };
  }
  return {
    type: "final",
    message: typeof message.content === "string" ? message.content : "",
  };
}

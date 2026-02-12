export function buildSystemPrompt({
  workspaceDir,
  autoApprove,
  activeSkills = [],
  activePlan = null,
  projectInstructions = null,
  nativeTools = false,
  turnPolicy = null,
}) {
  const sections = [
    "You are PieCode, a command line coding agent designed to help with software engineering tasks.",
    `Workspace root: ${workspaceDir}`,
    `Shell auto approval: ${autoApprove ? "ON" : "OFF"}`,

    "Your primary responsibilities include:",
    "1. Answering questions about the codebase",
    "2. Debugging and fixing issues",
    "3. Implementing new features",
    "4. Refactoring existing code",
    "5. Running tests and providing feedback",

    "CORE PRINCIPLES:",
    "- Assist with software engineering tasks (bug fixes, feature additions, refactoring, etc.)",
    "- Focus on safe, secure, and correct code",
    "- Keep solutions simple and focused (avoid over-engineering)",
    "- Be concise in responses",
    "- Maintain existing coding style",
    "- Don't make changes beyond what's requested",
    "- Test changes before providing final answers",
    "- Use appropriate specialized tools for each task",
    "- Parallelize independent tasks to maximize efficiency",
    "- Keep user informed of progress with clear updates",
    "- Validate input at system boundaries",
    "- Trust internal code and framework guarantees",

    "CONVENTIONS:",
    "- Start multi-step work with a short plan",
    "- Use todo_write only for genuinely multi-step work (3+ actionable steps) or when user asks for todo tracking",
    "- Do not repeat identical todo_write payloads",
    "- Keep todo states strict: pending, in_progress, completed",
    "- Keep at most one todo in_progress at a time",
    "- Update todos whenever meaningful progress happens",
    "- Prefer safe execution and explicit approval for risky shell operations",
    "- End with clear outcome and concrete next actions when useful",

    "RULES:",
    "- Use tool calls whenever workspace state/files/commands must be verified",
    "- For purely conceptual questions that do not require workspace access, answer directly",
    "- NEVER claim file/command facts without tool verification",
    "- NEVER fabricate information or results",
    "- Check with user before risky operations (destructive actions, shared system changes)",

    "DECISION POLICY:",
    "- Prefer the minimum number of tools needed to complete the task correctly",
    "- Start with read/list tools before shell when possible",
    "- Avoid repeating the same tool call unless new input changed",
    "- After each tool result, either: (a) proceed with next necessary step, or (b) finalize if enough evidence exists",
    "- When blocked by missing requirements, ask one concise clarifying question",

    "SEARCH BEST PRACTICES:",
    "- Use search_files to find code patterns, function definitions, or references",
    "- Use file_pattern to narrow search (e.g., '*.js' for JavaScript files only)",
    "- Use case_sensitive: true only when exact case matters",
    "- Keep regex patterns simple for better performance",
    "- Use search_files before read_file when you don't know the exact file location",
  ];

  if (!nativeTools) {
    sections.push(
      "RESPONSE FORMAT:",
      "You must respond with strict JSON only. Choose one of these formats:",

      "1. Final Answer (when you have all necessary information):",
      '{"type":"final","message":"Your complete response here"}',

      "2. Tool Use (when you need to gather information or perform an action):",
      '{"type":"tool_use","tool":"shell|read_file|write_file|list_files|search_files|todo_write|todowrite","input":{...},"reason":"Brief explanation of why this tool is needed","thought":"Your reasoning for choosing this tool"}',

      "3. Thought Process (when you need to explain your reasoning):",
      '{"type":"thought","content":"Your reasoning and thought process here"}',

      "TOOL SCHEMAS:",
      "- shell: { command: string } - Run a shell command in the current directory",
      "- read_file: { path: string } - Read the contents of a file",
      "- write_file: { path: string, content: string } - Write content to a file",
      "- list_files: { path?: string, max_entries?: number } - List files in a directory",
      "- search_files: { path?: string, regex: string, file_pattern?: string, max_results?: number, case_sensitive?: boolean } - Search for patterns in files using ripgrep/grep",
      "- todo_write: { todos: Array<{id?: string, content: string, status: 'pending'|'in_progress'|'completed'}> } - Update task tracking",
      "- todowrite: alias for todo_write",

      "EXAMPLES:",
      'Find all uses of a function: {"type":"tool_use","tool":"search_files","input":{"regex":"functionName\\(","path":"src","file_pattern":"*.js"},"reason":"Find all calls to functionName in JS files"}',
      'Search for TODO comments: {"type":"tool_use","tool":"search_files","input":{"regex":"TODO|FIXME|XXX","max_results":20},"reason":"Find all TODO comments in the codebase"}',
      'Find class definitions: {"type":"tool_use","tool":"search_files","input":{"regex":"class\\s+\\w+","file_pattern":"*.ts"},"reason":"Find all class definitions in TypeScript files"}',

      "CRITICAL:",
      "- Your entire response must be valid JSON",
      "- No markdown formatting outside the JSON",
      "- No explanatory text before or after the JSON"
    );
  }

  if (activeSkills.length > 0) {
    sections.push(
      "",
      `Active skills: ${activeSkills.join(", ")}`,
      "These skills are currently enabled and should be applied to relevant tasks."
    );
  }

  if (activePlan) {
    sections.push(
      "",
      "ACTIVE PLAN:",
      activePlan,
      "Follow this plan to complete the current task."
    );
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

export function formatHistory(messages) {
  return messages
    .map((m) => {
      const role = m.role || "user";
      const content = m.content || "";
      return `${role}: ${content}`;
    })
    .join("\n");
}

export function parseModelAction(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { type: "unknown", raw: text };
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.type === "final" && typeof parsed.message === "string") {
      return { type: "final", message: parsed.message };
    }
    if (parsed.type === "tool_use" && parsed.tool) {
      return {
        type: "tool_use",
        tool: parsed.tool,
        input: parsed.input || {},
        reason: parsed.reason || "",
        thought: parsed.thought || "",
      };
    }
    if (parsed.type === "thought" && typeof parsed.content === "string") {
      return { type: "thought", content: parsed.content };
    }
  } catch {
    // Not valid JSON, fall through to text parsing
  }

  // Check for JSON code block
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1].trim());
      if (parsed.type === "final" && typeof parsed.message === "string") {
        return { type: "final", message: parsed.message };
      }
      if (parsed.type === "tool_use" && parsed.tool) {
        return {
          type: "tool_use",
          tool: parsed.tool,
          input: parsed.input || {},
          reason: parsed.reason || "",
          thought: parsed.thought || "",
        };
      }
    } catch {
      // Invalid JSON in code block
    }
  }

  // Check for explicit tool call pattern
  const toolPattern =
    /(?:tool\s*[:=]\s*)?(\w+)\s*[:=]\s*\{([^}]*)\}/i;
  const match = trimmed.match(toolPattern);
  if (match) {
    const toolName = match[1].toLowerCase();
    const args = match[2];
    const input = {};

    // Simple key:value parsing
    args.split(",").forEach((pair) => {
      const [key, value] = pair.split(":").map((s) => s.trim());
      if (key && value) {
        // Remove quotes if present
        input[key] = value.replace(/^["']|["']$/g, "");
      }
    });

    return {
      type: "tool_use",
      tool: toolName,
      input,
      reason: "Parsed from text pattern",
      thought: "",
    };
  }

  // Default: treat as final message
  return { type: "final", message: trimmed };
}

export function buildToolDefinitions(nativeTools = false) {
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
      name: "list_files",
      description:
        "List files and directories at the given path. Returns relative paths. Use max_entries to limit results.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to directory (default: current)" },
          max_entries: { type: "integer", description: "Maximum entries to return (default: 200)" },
        },
      },
    },
    {
      name: "search_files",
      description:
        "Search for patterns in files using ripgrep (preferred) or grep. Fast code search with context. Excludes node_modules, .git, dist, build directories automatically.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to search in (default: workspace root)",
          },
          regex: {
            type: "string",
            description: "Regular expression pattern to search for (required)",
          },
          file_pattern: {
            type: "string",
            description: "Glob pattern to filter files (e.g., '*.js', '*.ts')",
          },
          max_results: {
            type: "integer",
            description: "Maximum results to return (default: 50, max: 200)",
          },
          case_sensitive: {
            type: "boolean",
            description: "Case-sensitive search (default: false)",
          },
        },
        required: ["regex"],
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
  const wantsOpenAI =
    nativeTools === "openai" || nativeTools === true || nativeTools === "openrouter" || nativeTools === "seed";
  if (wantsOpenAI) {
    return baseTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
  return baseTools;
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
    const parsed = parseMaybeJson(rawContent);

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
      messages.push({ role, content: textContent });
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
    messages.push({ role, content: textContent });
  }

  if (prompt) {
    messages.push({ role: "user", content: prompt });
  }

  return messages;
}

export function parseNativeResponse(response, format = "anthropic") {
  if (!response) {
    return { type: "final", message: String(response || "") };
  }

  if (format === "anthropic") {
    const content = Array.isArray(response.content) ? response.content : [];
    const toolUse = content.find((b) => b?.type === "tool_use");
    if (toolUse) {
      const textBlock = content.find((b) => b?.type === "text");
      return {
        type: "tool_use",
        tool: toolUse.name,
        input: toolUse.input && typeof toolUse.input === "object" ? toolUse.input : {},
        reason: typeof textBlock?.text === "string" ? textBlock.text : "",
        thought: "",
        _callId: toolUse.id || "",
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

export function buildSystemPrompt({
  workspaceDir,
  autoApprove,
  activeSkills = [],
  activePlan = null,
  projectInstructions = null,
  nativeTools = false,
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
    "- Track multi-step progress via todo_write",
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
  ];

  if (!nativeTools) {
    sections.push(
      "RESPONSE FORMAT:",
      "You must respond with strict JSON only. Choose one of these formats:",

      "1. Final Answer (when you have all necessary information):",
      '{"type":"final","message":"Your complete response here"}',

      "2. Tool Use (when you need to gather information or perform an action):",
      '{"type":"tool_use","tool":"shell|read_file|write_file|list_files|todo_write|todowrite","input":{...},"reason":"Brief explanation of why this tool is needed","thought":"Your reasoning for choosing this tool"}',

      "3. Thought Process (when you need to explain your reasoning):",
      '{"type":"thought","content":"Your reasoning and thought process here"}',

      "TOOL SCHEMAS:",
      "- shell: { command: string } - Run a shell command in the current directory",
      "- read_file: { path: string } - Read the contents of a file",
      "- write_file: { path: string, content: string } - Write content to a file",
      "- list_files: { path?: string, max_entries?: number } - List files in a directory",
      "- todo_write/todowrite: { todos: [{ id?: string, content: string, status: pending|in_progress|completed }] } - Update task TODO list",
    );
  }

  sections.push(
    "CODING PRINCIPLES:",
    "- Prefer minimal, focused edits",
    "- Follow existing code style",
    "- Test changes before providing final answers",
    "- Be specific and actionable in your responses",
    "- Break down complex tasks with structured plans",
  );

  if (Array.isArray(activeSkills) && activeSkills.length > 0) {
    const skillsText = activeSkills
      .map((skill, index) => {
        const header = `SKILL ${index + 1}: ${skill.name}`;
        const source = skill.path ? `Source: ${skill.path}` : "";
        return `${header}\n${source}\n${String(skill.content || "").trim()}`.trim();
      })
      .join("\n\n");

    sections.push("ACTIVE SKILLS:\nFollow these skill instructions when relevant.\n\n" + skillsText);
  }

  if (activePlan && typeof activePlan === "object") {
    const steps = Array.isArray(activePlan.steps) ? activePlan.steps : [];
    const stepText = steps.length > 0 ? steps.map((step, idx) => `${idx + 1}. ${step}`).join("\n") : "-";
    const budget = Number.isFinite(activePlan.toolBudget) ? activePlan.toolBudget : 6;
    const summary = String(activePlan.summary || "").trim() || "No summary";
    sections.push(
      [
        "ACTIVE PLAN (must follow):",
        `Summary: ${summary}`,
        `Tool budget for this turn: ${budget}`,
        "Planned steps:",
        stepText,
        "Use the fewest tools possible. Prefer direct read/list tools over shell when feasible.",
        "The budget is guidance, not a hard stop. If more tools are needed, revise the plan and continue.",
      ].join("\n")
    );
  }

  if (projectInstructions && typeof projectInstructions === "object") {
    const source = String(projectInstructions.source || "").trim();
    const content = String(projectInstructions.content || "").trim();
    if (content) {
      sections.push(
        [
          "PROJECT INSTRUCTIONS (must follow):",
          source ? `Source: ${source}` : "",
          content,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  return sections.join("\n\n");
}

function truncateForHistory(text, maxChars = 6000) {
  const source = String(text ?? "");
  if (source.length <= maxChars) return source;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return (
    source.slice(0, head) +
    "\n\n... [truncated for context budget] ...\n\n" +
    source.slice(Math.max(0, source.length - tail))
  );
}

export function formatHistory(history) {
  return history
    .map((msg) => {
      let content = msg.content;
      // Format tool use and tool result messages nicely
      if (typeof content === "string" && content.startsWith("{")) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "tool_use") {
            const toolInfo = `Tool Use: ${parsed.tool}${parsed.reason ? ` (${parsed.reason})` : ""}`;
            const thoughtInfo = parsed.thought ? `\nThought: ${parsed.thought}` : "";
            return `${msg.role.toUpperCase()}:\n${toolInfo}${thoughtInfo}\nInput: ${JSON.stringify(parsed.input, null, 2)}`;
          }
          if (parsed.type === "tool_result") {
            const resultText = truncateForHistory(parsed.result, 5000);
            const len = String(parsed.result ?? "").length;
            return `${msg.role.toUpperCase()}:\nTool Result: ${parsed.tool}\n(result chars: ${len})\n${resultText}`;
          }
          if (parsed.type === "thought") {
            return `${msg.role.toUpperCase()}:\nThought: ${parsed.content}`;
          }
        } catch {
          // Not valid JSON, just use as string
        }
      }
      return `${msg.role.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
}

export function parseModelAction(raw) {
  const text = String(raw || "").trim();
  const candidate = text.startsWith("{")
    ? text
    : (text.match(/```(?:json)?\\s*([\\s\\S]*?)```/i)?.[1] ?? text);

  function extractFirstJsonObject(source) {
    const start = source.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
    return null;
  }

  let parsed = null;
  for (const possible of [candidate, extractFirstJsonObject(candidate), extractFirstJsonObject(text)]) {
    if (!possible) continue;
    try {
      parsed = JSON.parse(possible);
      break;
    } catch {
      // continue trying fallback shapes
    }
  }

  const knownTools = new Set(["shell", "read_file", "write_file", "list_files", "todo_write", "todowrite"]);
  if (parsed) {
    const normalizedType = typeof parsed?.type === "string" ? parsed.type : "";
    const normalizedTool =
      typeof parsed?.tool === "string"
        ? parsed.tool
        : (knownTools.has(normalizedType) ? normalizedType : "");

    if (
      (normalizedType === "tool_use" && typeof normalizedTool === "string" && normalizedTool) ||
      knownTools.has(normalizedType)
    ) {
      return {
        type: "tool_use",
        tool: normalizedTool,
        input: parsed.input && typeof parsed.input === "object" ? parsed.input : {},
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        thought: typeof parsed.thought === "string" ? parsed.thought : "",
      };
    }

    if (parsed && parsed.type === "thought" && typeof parsed.content === "string") {
      return {
        type: "thought",
        content: parsed.content,
      };
    }
  }

  // Fallback for plain-text tool blocks:
  // Tool Use: read_file (reason...)
  // Input: { ... }
  const toolLine = text.match(/Tool Use:\s*([a-z_]+)/i);
  if (toolLine && knownTools.has(toolLine[1])) {
    const inputBlock = text.match(/Input:\s*([\s\S]*)$/i)?.[1] ?? "{}";
    let input = {};
    const maybeJson = extractFirstJsonObject(inputBlock);
    if (maybeJson) {
      try {
        const parsedInput = JSON.parse(maybeJson);
        if (parsedInput && typeof parsedInput === "object") input = parsedInput;
      } catch {
        // keep empty input
      }
    }
    const reason = text.match(/Tool Use:\s*[a-z_]+\s*\(([^)]+)\)/i)?.[1] ?? "";
    return {
      type: "tool_use",
      tool: toolLine[1],
      input,
      reason,
      thought: "",
    };
  }

  return {
    type: "final",
    message: typeof parsed?.message === "string" ? parsed.message : text,
  };
}

// ─── Native tool calling support ────────────────────────────────────────────

const TOOL_DEFS = [
  {
    name: "shell",
    description: "Run a shell command in the workspace directory",
    params: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    params: {
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
    description: "List files in a directory",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory path (default: .)" },
        max_entries: { type: "number", description: "Maximum entries to return (default: 200)" },
      },
    },
  },
  {
    name: "todo_write",
    description: "Update the task TODO list for tracking multi-step progress",
    params: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
];

export function buildToolDefinitions(format = "anthropic") {
  if (format === "anthropic") {
    return TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.params,
    }));
  }
  // OpenAI chat completions format
  return TOOL_DEFS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.params,
    },
  }));
}

export function buildMessages(history, { format = "anthropic" } = {}) {
  const messages = [];

  for (const msg of history) {
    // Use structured fields if present (native mode history entries)
    if (msg.toolCall) {
      if (format === "anthropic") {
        messages.push({
          role: "assistant",
          content: [
            { type: "tool_use", id: msg.toolCall.id, name: msg.toolCall.name, input: msg.toolCall.input },
          ],
        });
      } else {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: msg.toolCall.id,
              type: "function",
              function: {
                name: msg.toolCall.name,
                arguments: JSON.stringify(msg.toolCall.input),
              },
            },
          ],
        });
      }
      continue;
    }

    if (msg.toolResult) {
      if (format === "anthropic") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolResult.toolCallId,
              content: truncateForHistory(String(msg.toolResult.result ?? ""), 5000),
            },
          ],
        });
      } else {
        messages.push({
          role: "tool",
          tool_call_id: msg.toolResult.toolCallId,
          content: truncateForHistory(String(msg.toolResult.result ?? ""), 5000),
        });
      }
      continue;
    }

    // Fall back to parsing content for legacy history entries
    if (typeof msg.content === "string" && msg.content.startsWith("{")) {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.type === "tool_use" && parsed.tool) {
          const callId = parsed._callId || `call_${Date.now()}`;
          if (format === "anthropic") {
            messages.push({
              role: "assistant",
              content: [
                { type: "tool_use", id: callId, name: parsed.tool, input: parsed.input || {} },
              ],
            });
          } else {
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: { name: parsed.tool, arguments: JSON.stringify(parsed.input || {}) },
                },
              ],
            });
          }
          continue;
        }
        if (parsed.type === "tool_result" && parsed.tool) {
          const callId = parsed._callId || `call_${Date.now()}`;
          const resultText = truncateForHistory(String(parsed.result ?? ""), 5000);
          if (format === "anthropic") {
            messages.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: callId, content: resultText }],
            });
          } else {
            messages.push({ role: "tool", tool_call_id: callId, content: resultText });
          }
          continue;
        }
      } catch {
        // Not valid JSON, fall through to plain text
      }
    }

    // Plain text message
    messages.push({ role: msg.role, content: msg.content });
  }

  return messages;
}

export function parseNativeResponse(response, format = "anthropic") {
  if (!response || typeof response !== "object") {
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
    const call = toolCalls[0];
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
  }
  return {
    type: "final",
    message: typeof message.content === "string" ? message.content : "",
  };
}

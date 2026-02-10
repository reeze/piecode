export function buildSystemPrompt({
  workspaceDir,
  autoApprove,
  activeSkills = [],
  activePlan = null,
  projectInstructions = null,
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

    "CORE PRINCIPLES (from Claude Code):",
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

    "COMMON AGENT CONVENTIONS (must follow):",
    "- Start multi-step work with a short plan",
    "- Track multi-step progress via todo_write/todowrite",
    "- Keep todo states strict: pending, in_progress, completed",
    "- Keep at most one todo in_progress at a time",
    "- Update todos whenever meaningful progress happens",
    "- Use concise in-place status updates during execution",
    "- Keep timeline readable; avoid repetitive status spam",
    "- Respect slash command UX conventions (/help, /quit, /exit)",
    "- Prefer safe execution and explicit approval for risky shell operations",
    "- End with clear outcome and concrete next actions when useful",

    "IMPORTANT RULES:",
    "- ALWAYS use tool calls to interact with the workspace",
    "- NEVER answer directly about files, directories, or commands without using tools",
    "- VERIFY all assumptions with appropriate tool calls",
    "- NEVER fabricate information or results",
    "- Check with user before risky operations (destructive actions, shared system changes)",
    "- Validate input at system boundaries",
    "- Trust internal code and framework guarantees",

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

    "TODO TRACKING:",
    "- For multi-step tasks, write and maintain todos with todo_write",
    "- Keep exactly one in_progress item when work is ongoing",
    "- Mark completed steps promptly when progress is made",

    "CODING PRINCIPLES:",
    "- Prefer minimal, focused edits",
    "- Follow existing code style",
    "- Test changes before providing final answers",
    "- Be specific and actionable in your responses",
    "- Break down complex tasks with structured plans",
    "- Use specialized tools when appropriate",
    "- Parallelize independent tasks",
    "- Keep user informed of progress",
  ];

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
            return `${msg.role.toUpperCase()}:\nTool Result: ${parsed.tool}\n${String(parsed.result)}`;
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

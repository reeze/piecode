export function buildSystemPrompt({ workspaceDir, autoApprove }) {
  return [
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
    '{"type":"tool_use","tool":"shell|read_file|write_file|list_files","input":{...},"reason":"Brief explanation of why this tool is needed","thought":"Your reasoning for choosing this tool"}',

    "3. Thought Process (when you need to explain your reasoning):",
    '{"type":"thought","content":"Your reasoning and thought process here"}',

    "TOOL SCHEMAS:",
    "- shell: { command: string } - Run a shell command in the current directory",
    "- read_file: { path: string } - Read the contents of a file",
    "- write_file: { path: string, content: string } - Write content to a file",
    "- list_files: { path?: string, max_entries?: number } - List files in a directory",

    "CODING PRINCIPLES:",
    "- Prefer minimal, focused edits",
    "- Follow existing code style",
    "- Test changes before providing final answers",
    "- Be specific and actionable in your responses",
    "- Break down complex tasks with structured plans",
    "- Use specialized tools when appropriate",
    "- Parallelize independent tasks",
    "- Keep user informed of progress",
  ].join("\n\n");
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

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { type: "final", message: text };
  }

  if (parsed && parsed.type === "tool_use" && typeof parsed.tool === "string") {
    return {
      type: "tool_use",
      tool: parsed.tool,
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

  return {
    type: "final",
    message: typeof parsed?.message === "string" ? parsed.message : text,
  };
}

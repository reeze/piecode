import { buildSystemPrompt, formatHistory, parseModelAction, buildToolDefinitions, buildMessages, parseNativeResponse } from '../src/lib/prompt.js';

describe('Prompt functions', () => {
  describe('buildSystemPrompt', () => {
    test('should generate system prompt with workspace and autoApprove settings', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: true,
      });

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('/test/workspace');
      expect(prompt).toContain('Shell auto approval: ON');
    });

    test('should include general-purpose guidelines', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
      });

      expect(prompt).toContain('general-purpose command-line agent');
      expect(prompt).toContain('coding, writing, research, analysis, planning, or troubleshooting');
      expect(prompt).toContain('GUIDELINES');
      expect(prompt).not.toContain('CAPABILITIES');
      expect(prompt).not.toContain('OPERATING RULES');
    });

    test('should include tool guidance in text mode (nativeTools=false)', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        nativeTools: false,
      });

      expect(prompt).toContain('RESPONSE FORMAT');
      expect(prompt).toContain('TOOLS');
      expect(prompt).toContain('"type":"thought"');
      expect(prompt).toContain('todo_write/todowrite');
      expect(prompt).toContain('clarify_user');
      expect(prompt).toContain('edit_file');
      expect(prompt).not.toContain('apply_patch');
    });

    test('should omit tool schemas in native mode (nativeTools=true)', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        nativeTools: true,
      });

      expect(prompt).not.toContain('RESPONSE FORMAT');
      expect(prompt).not.toContain('TOOLS:');
      expect(prompt).not.toContain('"type":"thought"');
      expect(prompt).not.toContain('todo_write/todowrite');
    });

    test('native mode prompt should be smaller than text mode', () => {
      const opts = { workspaceDir: '/test', autoApprove: false };
      const textPrompt = buildSystemPrompt({ ...opts, nativeTools: false });
      const nativePrompt = buildSystemPrompt({ ...opts, nativeTools: true });

      expect(nativePrompt.length).toBeLessThan(textPrompt.length);
    });

    test('should include configured project agents', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        agentDefinitions: [
          { name: 'security-reviewer', description: 'Security and sandbox review' },
        ],
      });

      expect(prompt).toContain('CONFIGURED PROJECT AGENTS');
      expect(prompt).toContain('security-reviewer');
      expect(prompt).toContain('role, agent, or name');
    });

    test('should include active skills instructions', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        activeSkills: [
          {
            name: 'demo-skill',
            path: '/skills/demo/SKILL.md',
            content: '# Demo\\nUse strict typing.',
          },
        ],
      });

      expect(prompt).toContain('ACTIVE SKILLS');
      expect(prompt).toContain('demo-skill');
      expect(prompt).toContain('Use strict typing.');
    });

    test('should include project instructions when provided', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        projectInstructions: {
          source: 'AGENTS.md',
          content: 'Do not edit generated files.',
        },
      });

      expect(prompt).toContain('PROJECT INSTRUCTIONS');
      expect(prompt).toContain('AGENTS.md');
      expect(prompt).toContain('Do not edit generated files.');
    });

    test('should include duplicate read guard for AGENTS context', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        projectInstructions: {
          source: 'AGENTS.md',
          content: 'Project instructions body.',
        },
      });

      expect(prompt).toContain('avoid repeated identical read-only calls');
      expect(prompt).toContain('do not re-read them unless exact quotes are needed');
      expect(prompt).toContain('do not simply stop unless you are truly blocked');
      expect(prompt).toContain('finalize from the evidence already collected');
    });

    test('should include long-running task discipline', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        nativeTools: true,
      });

      expect(prompt).toContain('LONG TASK LOOP');
      expect(prompt).toContain('EXPLORATION DISCIPLINE');
      expect(prompt).toContain('VALIDATION LADDER');
      expect(prompt).toContain('WORKTREE SAFETY');
      expect(prompt).toContain('DONE CRITERIA');
      expect(prompt).toContain('USER-FACING PROGRESS CONTRACT');
      expect(prompt).toContain('surface progress in phases');
      expect(prompt).toContain('Final responses should be user-friendly');
      expect(prompt).toContain('The harness will show that sentence as progress');
      expect(prompt).toContain('changed files, validation, blockers, and next step');
      expect(prompt).toContain('brief progress syncs');
      expect(prompt).toContain('Do not expand file diffs by default');
      expect(prompt).toContain('Treat uncommitted changes as user-owned');
    });

    test('should include todo tracking conventions in text mode', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
        nativeTools: false,
      });

      expect(prompt).toContain('todo_write');
      expect(prompt).toContain('pending, in_progress, or completed');
      expect(prompt).toContain('Before editing existing files, read them first');
      expect(prompt).toContain('Prefer targeted edits');
      expect(prompt).toContain('write_file is for new files or explicit rewrites');
      expect(prompt).toContain('Before tool calls, say what context you are gathering');
      expect(prompt).toContain('include a non-empty `thought` field');
      expect(prompt).toContain('show diffs only when the user asks for review');
    });
  });

  describe('parseModelAction', () => {
    test('should parse final answer', () => {
      const result = parseModelAction('{"type":"final","message":"Hello world"}');
      expect(result.type).toBe('final');
      expect(result.message).toBe('Hello world');
    });

    test('should parse tool use without thought', () => {
      const result = parseModelAction('{"type":"tool_use","tool":"read_file","input":{"path":"test.txt"},"reason":"Read test file"}');
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('read_file');
      expect(result.input).toEqual({ path: 'test.txt' });
      expect(result.reason).toBe('Read test file');
    });

    test('should parse tool use with thought', () => {
      const result = parseModelAction('{"type":"tool_use","tool":"read_file","input":{"path":"test.txt"},"reason":"Read test file","thought":"I need to read this file to understand the content"}');
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('read_file');
      expect(result.input).toEqual({ path: 'test.txt' });
      expect(result.reason).toBe('Read test file');
      expect(result.thought).toBe('I need to read this file to understand the content');
    });

    test('should parse thought process', () => {
      const result = parseModelAction('{"type":"thought","content":"Let me think about this task carefully"}');
      expect(result.type).toBe('thought');
      expect(result.content).toBe('Let me think about this task carefully');
    });

    test('should parse shorthand tool type', () => {
      const result = parseModelAction('{"type":"read_file","input":{"path":"test.txt"},"reason":"Read file"}');
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('read_file');
      expect(result.input).toEqual({ path: 'test.txt' });
    });

    test('should parse clarify_user tool', () => {
      const result = parseModelAction(
        '{"type":"tool_use","tool":"clarify_user","input":{"question":"Choose mode","options":[{"label":"Fast"}],"multiple":false}}'
      );
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('clarify_user');
      expect(result.input.question).toBe('Choose mode');
      expect(result.input.options).toEqual([{ label: 'Fast' }]);
    });

    test('should parse todo_write tool', () => {
      const result = parseModelAction(
        '{"type":"tool_use","tool":"todo_write","input":{"todos":[{"content":"step a","status":"pending"}]}}'
      );
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('todo_write');
      expect(result.input).toEqual({ todos: [{ content: 'step a', status: 'pending' }] });
    });

    test('should parse todowrite alias tool type', () => {
      const result = parseModelAction(
        '{"type":"todowrite","input":{"todos":[{"content":"step a","status":"in_progress"}]}}'
      );
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('todowrite');
      expect(result.input).toEqual({ todos: [{ content: 'step a', status: 'in_progress' }] });
    });

    test('should parse subagent shorthand tool type', () => {
      const result = parseModelAction(
        '{"type":"subagent","input":{"task":"inspect auth flow","tool_budget":2}}'
      );
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('subagent');
      expect(result.input).toEqual({ task: 'inspect auth flow', tool_budget: 2 });
    });

    test('should parse tool_use with todowrite alias as tool field', () => {
      const result = parseModelAction(
        '{"type":"tool_use","tool":"todowrite","input":{"todos":[{"content":"step b","status":"completed"}]}}'
      );
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('todowrite');
      expect(result.input).toEqual({ todos: [{ content: 'step b', status: 'completed' }] });
    });

    test('should parse plain text tool block', () => {
      const result = parseModelAction('Tool Use: read_file (Read file)\\nInput: {\"path\":\"test.txt\"}');
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('read_file');
      expect(result.input).toEqual({ path: 'test.txt' });
    });

    test('should parse JSON tool call with preamble text', () => {
      const result = parseModelAction(
        'I will inspect first.\\n{"type":"tool_use","tool":"search_files","input":{"query":"todo_write","path":"src"},"reason":"find todo logic"}'
      );
      expect(result.type).toBe('tool_use');
      expect(result.tool).toBe('search_files');
      expect(result.input).toEqual({ query: 'todo_write', path: 'src' });
    });

    test('should handle invalid JSON', () => {
      const result = parseModelAction('Invalid JSON response');
      expect(result.type).toBe('final');
      expect(result.message).toBe('Invalid JSON response');
    });
  });

  describe('buildToolDefinitions', () => {
    test('should expose subagent in native tool definitions', () => {
      const tools = buildToolDefinitions('openai');
      const names = tools.map((tool) => tool.function?.name || tool.name);
      expect(names).toContain('subagent');
      const subagent = tools.find((tool) => tool.function?.name === 'subagent');
      expect(subagent.function.parameters.required).toContain('task');
      expect(subagent.function.parameters.properties.role).toBeDefined();
      expect(subagent.function.parameters.properties.agent).toBeDefined();
      expect(subagent.function.parameters.properties.name).toBeDefined();
    });
  });

  describe('formatHistory', () => {
    test('should format basic messages', () => {
      const history = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'World' },
      ];

      const formatted = formatHistory(history);
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('USER');
      expect(formatted).toContain('ASSISTANT');
    });

    test('should format tool use with thought', () => {
      const history = [
        {
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_use',
            tool: 'read_file',
            input: { path: 'test.txt' },
            reason: 'Read test file',
            thought: 'I need to read this file to understand the content'
          })
        },
      ];

      const formatted = formatHistory(history);
      expect(formatted).toContain('Tool Use: read_file');
      expect(formatted).toContain('Read test file');
      expect(formatted).toContain('I need to read this file to understand the content');
    });

    test('should format thought process', () => {
      const history = [
        {
          role: 'assistant',
          content: JSON.stringify({
            type: 'thought',
            content: 'Let me think about this task carefully'
          })
        },
      ];

      const formatted = formatHistory(history);
      expect(formatted).toContain('Thought: Let me think about this task carefully');
    });

    test('should truncate oversized tool_result payloads for context budget', () => {
      const big = 'x'.repeat(9000);
      const history = [
        {
          role: 'user',
          content: JSON.stringify({
            type: 'tool_result',
            tool: 'read_file',
            result: big,
          }),
        },
      ];

      const formatted = formatHistory(history);
      expect(formatted).toContain('Tool Result: read_file');
      expect(formatted).toContain('result chars: 9000');
      expect(formatted).toContain('[truncated for context budget]');
      expect(formatted.length).toBeLessThan(7000);
    });
  });

  describe('buildToolDefinitions', () => {
    test('returns Anthropic format with input_schema', () => {
      const tools = buildToolDefinitions('anthropic');
      expect(tools.length).toBeGreaterThanOrEqual(5);

      const clarify = tools.find((t) => t.name === 'clarify_user');
      expect(clarify).toBeDefined();
      expect(clarify.input_schema.properties.options).toBeDefined();

      const shell = tools.find((t) => t.name === 'shell');
      expect(shell).toBeDefined();
      expect(shell.input_schema).toBeDefined();
      expect(shell.input_schema.properties.command).toBeDefined();

      const readFile = tools.find((t) => t.name === 'read_file');
      expect(readFile).toBeDefined();
      expect(readFile.input_schema.properties.path).toBeDefined();
    });

    test('returns OpenAI format with function wrapper', () => {
      const tools = buildToolDefinitions('openai');
      expect(tools.length).toBeGreaterThanOrEqual(5);

      const clarify = tools.find((t) => t.function?.name === 'clarify_user');
      expect(clarify).toBeDefined();
      expect(clarify.function.parameters.properties.multiple).toBeDefined();

      const shell = tools.find((t) => t.function?.name === 'shell');
      expect(shell).toBeDefined();
      expect(shell.type).toBe('function');
      expect(shell.function.parameters.properties.command).toBeDefined();

      const writeFile = tools.find((t) => t.function?.name === 'write_file');
      expect(writeFile).toBeDefined();
      expect(writeFile.function.parameters.required).toContain('path');
      expect(writeFile.function.parameters.required).toContain('content');

      const editFile = tools.find((t) => t.function?.name === 'edit_file');
      expect(editFile).toBeDefined();
      expect(editFile.function.parameters.properties.oldText).toBeDefined();
      expect(editFile.function.parameters.properties.newText).toBeDefined();

      const applyPatch = tools.find((t) => t.function?.name === 'apply_patch');
      expect(applyPatch).toBeUndefined();
    });

    test('includes todo_write tool', () => {
      const anthropic = buildToolDefinitions('anthropic');
      const todo = anthropic.find((t) => t.name === 'todo_write');
      expect(todo).toBeDefined();
      expect(todo.input_schema.properties.todos).toBeDefined();

      const edit = anthropic.find((t) => t.name === 'edit_file');
      expect(edit).toBeDefined();
      expect(edit.input_schema.properties.path).toBeDefined();
      expect(edit.input_schema.properties.oldText).toBeDefined();

      const applyPatch = anthropic.find((t) => t.name === 'apply_patch');
      expect(applyPatch).toBeUndefined();

      const openai = buildToolDefinitions('openai');
      const todoOai = openai.find((t) => t.function?.name === 'todo_write');
      expect(todoOai).toBeDefined();
    });
  });

  describe('buildMessages', () => {
    test('converts plain text history to Anthropic messages', () => {
      const history = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const messages = buildMessages(history, { format: 'anthropic' });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    test('converts image attachments to Anthropic image blocks', () => {
      const history = [
        {
          role: 'user',
          content: 'Describe this screenshot',
          attachments: [{ type: 'image', mimeType: 'image/png', data: 'abc123', bytes: 12 }],
        },
      ];

      const messages = buildMessages(history, { format: 'anthropic' });
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'Describe this screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
      ]);
    });

    test('converts image attachments to OpenAI image_url parts', () => {
      const history = [
        {
          role: 'user',
          content: 'Describe this screenshot',
          attachments: [{ type: 'image', mimeType: 'image/jpeg', data: 'def456', bytes: 34 }],
        },
      ];

      const messages = buildMessages(history, { format: 'openai' });
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'Describe this screenshot' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,def456' } },
      ]);
    });

    test('converts structured toolCall entries to Anthropic tool_use blocks', () => {
      const history = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: '{}',
          toolCall: { id: 'call_1', name: 'read_file', input: { path: 'test.txt' } },
        },
        {
          role: 'user',
          content: '{}',
          toolResult: { toolCallId: 'call_1', name: 'read_file', result: 'file contents' },
        },
      ];

      const messages = buildMessages(history, { format: 'anthropic' });
      expect(messages).toHaveLength(3);

      // tool_use block
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content[0].type).toBe('tool_use');
      expect(messages[1].content[0].id).toBe('call_1');
      expect(messages[1].content[0].name).toBe('read_file');
      expect(messages[1].content[0].input).toEqual({ path: 'test.txt' });

      // tool_result block
      expect(messages[2].role).toBe('user');
      expect(messages[2].content[0].type).toBe('tool_result');
      expect(messages[2].content[0].tool_use_id).toBe('call_1');
      expect(messages[2].content[0].content).toBe('file contents');
    });

    test('converts structured toolCall entries to OpenAI tool_calls', () => {
      const history = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: '{}',
          toolCall: { id: 'call_1', name: 'read_file', input: { path: 'test.txt' } },
        },
        {
          role: 'user',
          content: '{}',
          toolResult: { toolCallId: 'call_1', name: 'read_file', result: 'file contents' },
        },
      ];

      const messages = buildMessages(history, { format: 'openai' });
      expect(messages).toHaveLength(3);

      // tool_calls
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBeNull();
      expect(messages[1].tool_calls[0].id).toBe('call_1');
      expect(messages[1].tool_calls[0].function.name).toBe('read_file');
      expect(JSON.parse(messages[1].tool_calls[0].function.arguments)).toEqual({ path: 'test.txt' });

      // tool result
      expect(messages[2].role).toBe('tool');
      expect(messages[2].tool_call_id).toBe('call_1');
      expect(messages[2].content).toBe('file contents');
    });

    test('converts batched toolCalls and toolResults to OpenAI messages', () => {
      const history = [
        { role: 'user', content: 'Read two files' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
            { id: 'call_2', name: 'read_file', input: { path: 'b.txt' } },
          ],
        },
        {
          role: 'user',
          toolResults: [
            { toolCallId: 'call_1', name: 'read_file', result: 'a' },
            { toolCallId: 'call_2', name: 'read_file', result: 'b' },
          ],
        },
      ];

      const messages = buildMessages(history, { format: 'openai' });
      expect(messages).toHaveLength(4);
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].tool_calls).toHaveLength(2);
      expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'a' });
      expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_2', content: 'b' });
    });

    test('drops orphan OpenAI tool calls without matching outputs', () => {
      const history = [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          toolCall: { id: 'call_orphan', name: 'read_file', input: { path: 'a.txt' } },
        },
        { role: 'assistant', content: 'Stopped before tool result was recorded.' },
      ];

      const messages = buildMessages(history, { format: 'openai' });
      expect(messages).toEqual([
        { role: 'user', content: 'Read the file' },
        { role: 'assistant', content: 'Stopped before tool result was recorded.' },
      ]);
    });

    test('drops orphan OpenAI tool outputs without matching calls', () => {
      const history = [
        { role: 'user', content: 'Continue' },
        {
          role: 'user',
          toolResult: { toolCallId: 'call_missing', name: 'read_file', result: 'contents' },
        },
      ];

      const messages = buildMessages(history, { format: 'openai' });
      expect(messages).toEqual([{ role: 'user', content: 'Continue' }]);
    });

    test('falls back to parsing content JSON for legacy history entries', () => {
      const history = [
        {
          role: 'assistant',
          content: JSON.stringify({ type: 'tool_use', tool: 'list_files', input: {}, _callId: 'legacy_1' }),
        },
        {
          role: 'user',
          content: JSON.stringify({ type: 'tool_result', tool: 'list_files', result: 'a.js\nb.js', _callId: 'legacy_1' }),
        },
      ];

      const messages = buildMessages(history, { format: 'anthropic' });
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content[0].type).toBe('tool_use');
      expect(messages[0].content[0].name).toBe('list_files');

      expect(messages[1].role).toBe('user');
      expect(messages[1].content[0].type).toBe('tool_result');
    });
  });

  describe('parseNativeResponse', () => {
    test('parses Anthropic tool_use response', () => {
      const response = {
        content: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      };

      const action = parseNativeResponse(response, 'anthropic');
      expect(action.type).toBe('tool_use');
      expect(action.tool).toBe('read_file');
      expect(action.input).toEqual({ path: 'test.txt' });
      expect(action.reason).toBe('Let me read that file.');
      expect(action.thought).toBe('Let me read that file.');
      expect(action._callId).toBe('toolu_01');
    });

    test('parses Anthropic final text response', () => {
      const response = {
        content: [
          { type: 'text', text: 'The answer is 42.' },
        ],
        stop_reason: 'end_turn',
      };

      const action = parseNativeResponse(response, 'anthropic');
      expect(action.type).toBe('final');
      expect(action.message).toBe('The answer is 42.');
    });

    test('preserves Anthropic final answer formatting', () => {
      const response = {
        content: [
          { type: 'text', text: 'Done:\n- changed prompt\n- ran tests' },
        ],
        stop_reason: 'end_turn',
      };

      const action = parseNativeResponse(response, 'anthropic');
      expect(action.type).toBe('final');
      expect(action.message).toBe('Done:\n- changed prompt\n- ran tests');
    });

    test('parses Anthropic response with only tool_use (no text)', () => {
      const response = {
        content: [
          { type: 'tool_use', id: 'toolu_02', name: 'shell', input: { command: 'ls' } },
        ],
      };

      const action = parseNativeResponse(response, 'anthropic');
      expect(action.type).toBe('tool_use');
      expect(action.tool).toBe('shell');
      expect(action._callId).toBe('toolu_02');
      expect(action.reason).toBe('');
    });

    test('parses Anthropic response with multiple tool_use blocks', () => {
      const response = {
        content: [
          { type: 'text', text: 'read both' },
          { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 'toolu_02', name: 'read_file', input: { path: 'b.txt' } },
        ],
        stop_reason: 'tool_use',
      };

      const action = parseNativeResponse(response, 'anthropic');
      expect(action.type).toBe('tool_uses');
      expect(action.calls).toHaveLength(2);
      expect(action.calls[0]._callId).toBe('toolu_01');
      expect(action.calls[0].thought).toBe('read both');
      expect(action.calls[1].reason).toBe('read both');
      expect(action.calls[1].input).toEqual({ path: 'b.txt' });
    });

    test('parses OpenAI tool_calls response', () => {
      const response = {
        message: {
          role: 'assistant',
          content: 'Reading the file now.',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"config.json"}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      };

      const action = parseNativeResponse(response, 'openai');
      expect(action.type).toBe('tool_use');
      expect(action.tool).toBe('read_file');
      expect(action.input).toEqual({ path: 'config.json' });
      expect(action.reason).toBe('Reading the file now.');
      expect(action.thought).toBe('Reading the file now.');
      expect(action._callId).toBe('call_abc');
    });

    test('preserves OpenAI array content before tool calls as progress thought', () => {
      const response = {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will search the prompt path first.' }],
          tool_calls: [
            {
              id: 'call_rg',
              type: 'function',
              function: { name: 'rg', arguments: '{"pattern":"progress","path":"src/lib"}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      };

      const action = parseNativeResponse(response, 'openai');
      expect(action.type).toBe('tool_use');
      expect(action.tool).toBe('rg');
      expect(action.input).toEqual({ pattern: 'progress', path: 'src/lib' });
      expect(action.reason).toBe('I will search the prompt path first.');
      expect(action.thought).toBe('I will search the prompt path first.');
    });

    test('parses OpenAI final text response', () => {
      const response = {
        message: {
          role: 'assistant',
          content: 'All done!',
        },
        finishReason: 'stop',
      };

      const action = parseNativeResponse(response, 'openai');
      expect(action.type).toBe('final');
      expect(action.message).toBe('All done!');
    });

    test('preserves OpenAI final answer formatting', () => {
      const response = {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done:\n- prompt\n- tests' }],
        },
        finishReason: 'stop',
      };

      const action = parseNativeResponse(response, 'openai');
      expect(action.type).toBe('final');
      expect(action.message).toBe('Done:\n- prompt\n- tests');
    });

    test('handles null/undefined response gracefully', () => {
      expect(parseNativeResponse(null, 'anthropic').type).toBe('final');
      expect(parseNativeResponse(undefined, 'openai').type).toBe('final');
    });

    test('handles malformed OpenAI arguments gracefully', () => {
      const response = {
        message: {
          tool_calls: [
            { id: 'call_x', type: 'function', function: { name: 'shell', arguments: 'not-json' } },
          ],
        },
      };

      const action = parseNativeResponse(response, 'openai');
      expect(action.type).toBe('tool_use');
      expect(action.tool).toBe('shell');
      expect(action.input).toEqual({});
    });
  });
});

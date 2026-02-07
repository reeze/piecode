import { buildSystemPrompt, formatHistory, parseModelAction } from '../src/lib/prompt.js';

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

    test('should include all core principles', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
      });

      expect(prompt).toContain('CORE PRINCIPLES');
      expect(prompt).toContain('Assist with software engineering tasks');
      expect(prompt).toContain('Focus on safe, secure, and correct code');
      expect(prompt).toContain('Keep solutions simple and focused');
    });

    test('should include thought process support', () => {
      const prompt = buildSystemPrompt({
        workspaceDir: '/test/workspace',
        autoApprove: false,
      });

      expect(prompt).toContain('Thought Process');
      expect(prompt).toContain('"type":"thought"');
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

    test('should handle invalid JSON', () => {
      const result = parseModelAction('Invalid JSON response');
      expect(result.type).toBe('final');
      expect(result.message).toBe('Invalid JSON response');
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
  });
});
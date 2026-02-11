import { Agent } from "../src/lib/agent.js";
import { buildSystemPrompt, formatHistory, parseModelAction } from "../src/lib/prompt.js";

function createMockProvider(response) {
  return {
    kind: "test-provider",
    model: "test-model",
    async complete() {
      return response;
    },
  };
}

function createAgent(provider) {
  return new Agent({
    provider,
    workspaceDir: process.cwd(),
    autoApproveRef: { value: false },
    askApproval: async () => true,
    activeSkillsRef: { value: [] },
    projectInstructionsRef: { value: null },
  });
}

describe("performance", () => {
  describe("simple prompt round-trip", () => {
    test("runTurn with a direct final answer completes under 50ms", async () => {
      const provider = createMockProvider('{"type":"final","message":"Hello! How can I help?"}');
      const agent = createAgent(provider);

      const start = performance.now();
      const result = await agent.runTurn("Hi");
      const elapsed = performance.now() - start;

      expect(result).toBe("Hello! How can I help?");
      expect(elapsed).toBeLessThan(50);
    });

    test("runTurn with one tool call + final answer completes under 50ms", async () => {
      let callCount = 0;
      const provider = {
        kind: "test-provider",
        model: "test-model",
        async complete() {
          callCount++;
          if (callCount === 1) {
            return '{"type":"tool_use","tool":"list_files","input":{},"reason":"List workspace files"}';
          }
          return '{"type":"final","message":"Found 3 files in the workspace."}';
        },
      };
      const agent = createAgent(provider);

      const start = performance.now();
      const result = await agent.runTurn("List files");
      const elapsed = performance.now() - start;

      expect(result).toBe("Found 3 files in the workspace.");
      expect(callCount).toBe(2);
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("buildSystemPrompt performance", () => {
    test("builds prompt under 1ms with no skills/plan", () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        buildSystemPrompt({
          workspaceDir: "/test/workspace",
          autoApprove: false,
        });
      }
      const elapsed = performance.now() - start;
      const avgMs = elapsed / 100;

      expect(avgMs).toBeLessThan(1);
    });

    test("builds prompt under 2ms with skills and plan", () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        buildSystemPrompt({
          workspaceDir: "/test/workspace",
          autoApprove: true,
          activeSkills: [
            { name: "skill-1", path: "/skills/1.md", content: "Instructions for skill 1" },
            { name: "skill-2", path: "/skills/2.md", content: "Instructions for skill 2" },
          ],
          activePlan: {
            summary: "Fix the bug in auth module",
            steps: ["Read the file", "Find the bug", "Fix it", "Test"],
            toolBudget: 6,
          },
          projectInstructions: {
            source: "AGENTS.md",
            content: "Follow strict TypeScript typing.",
          },
        });
      }
      const elapsed = performance.now() - start;
      const avgMs = elapsed / 100;

      expect(avgMs).toBeLessThan(2);
    });
  });

  describe("parseModelAction performance", () => {
    test("parses 1000 JSON responses under 20ms", () => {
      const inputs = [
        '{"type":"final","message":"Hello"}',
        '{"type":"tool_use","tool":"read_file","input":{"path":"test.txt"},"reason":"Read"}',
        '{"type":"thought","content":"Thinking..."}',
        '{"type":"read_file","input":{"path":"a.js"},"reason":"Check"}',
        'Invalid JSON fallback text',
      ];

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        parseModelAction(inputs[i % inputs.length]);
      }
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(20);
    });
  });

  describe("formatHistory performance", () => {
    test("formats 50-message history under 5ms", () => {
      const history = [];
      for (let i = 0; i < 50; i++) {
        if (i % 3 === 0) {
          history.push({ role: "user", content: `Message ${i}: What is the status?` });
        } else if (i % 3 === 1) {
          history.push({
            role: "assistant",
            content: JSON.stringify({
              type: "tool_use",
              tool: "read_file",
              input: { path: `file${i}.txt` },
              reason: "Reading file",
              thought: "Need to check this file",
            }),
          });
        } else {
          history.push({
            role: "user",
            content: JSON.stringify({
              type: "tool_result",
              tool: "read_file",
              result: "x".repeat(200),
            }),
          });
        }
      }

      const start = performance.now();
      const formatted = formatHistory(history);
      const elapsed = performance.now() - start;

      expect(typeof formatted).toBe("string");
      expect(formatted.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(5);
    });
  });
});

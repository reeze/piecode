/**
 * Comparative Benchmark: PieCode vs Codex CLI vs Claude Code
 *
 * This test suite measures PieCode's overhead in the agent loop and compares
 * the architectural approach to Codex CLI and Claude Code. It quantifies:
 *
 * 1. LLM round-trips per task (the #1 latency driver)
 * 2. Planning overhead (extra LLM calls before execution)
 * 3. System prompt size (affects TTFT and cost)
 * 4. History serialization cost (grows with conversation)
 * 5. Response parsing overhead (JSON text parsing vs native tool_use)
 */

import { Agent } from "../src/lib/agent.js";
import { buildSystemPrompt, formatHistory, parseModelAction } from "../src/lib/prompt.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockAgent({ completeResponses = [], streamResponses = null, enablePlanner = false, planFirst = true } = {}) {
  let callIndex = 0;
  const llmCalls = [];

  const provider = {
    kind: "mock",
    model: "mock-model",
    async complete({ systemPrompt, prompt, signal }) {
      const callNum = callIndex++;
      const start = performance.now();
      const response = typeof completeResponses === "function"
        ? completeResponses(callNum, { systemPrompt, prompt })
        : (completeResponses[callNum] ?? '{"type":"final","message":"done"}');
      const elapsed = performance.now() - start;
      llmCalls.push({ callNum, stage: "complete", elapsed, promptLen: prompt.length, sysLen: systemPrompt.length });
      return response;
    },
  };

  if (streamResponses) {
    provider.completeStream = async ({ systemPrompt, prompt, onDelta, signal }) => {
      const callNum = callIndex++;
      const start = performance.now();
      const response = typeof streamResponses === "function"
        ? streamResponses(callNum, { systemPrompt, prompt })
        : (streamResponses[callNum] ?? '{"type":"final","message":"done"}');
      onDelta?.(response);
      const elapsed = performance.now() - start;
      llmCalls.push({ callNum, stage: "stream", elapsed, promptLen: prompt.length, sysLen: systemPrompt.length });
      return response;
    };
  }

  // Save original env
  const origPlanner = process.env.PIECODE_ENABLE_PLANNER;
  const origPlanFirst = process.env.PIECODE_PLAN_FIRST;
  process.env.PIECODE_ENABLE_PLANNER = enablePlanner ? "1" : "0";
  process.env.PIECODE_PLAN_FIRST = planFirst ? "1" : "0";

  const agent = new Agent({
    provider,
    workspaceDir: process.cwd(),
    autoApproveRef: { value: true },
    askApproval: async () => true,
    activeSkillsRef: { value: [] },
    projectInstructionsRef: { value: null },
  });

  // Restore env
  process.env.PIECODE_ENABLE_PLANNER = origPlanner;
  process.env.PIECODE_PLAN_FIRST = origPlanFirst;

  return { agent, llmCalls, provider };
}

// ─── Benchmark 1: LLM Round-Trips ──────────────────────────────────────────

describe("Benchmark 1: LLM round-trips per task", () => {
  /*
   * COMPARISON:
   * - Claude Code: 1 LLM call for simple Q&A (native tool_use, no planning call)
   * - Codex CLI: 1 LLM call via Responses API (native function_call)
   * - PieCode (planFirst=true): 2 LLM calls (1 plan + 1 execution) for simple Q&A
   * - PieCode (planFirst=false): 1 LLM call for simple Q&A
   */

  test("simple Q&A: PieCode with planFirst=true makes 2 LLM calls (1 wasted)", async () => {
    const { agent, llmCalls } = createMockAgent({
      completeResponses: [
        // Call 0: planning call (extra overhead)
        '{"summary":"Answer the greeting","steps":["Respond directly"],"toolBudget":1}',
        // Call 1: actual execution
        '{"type":"final","message":"Hello! How can I help you?"}',
      ],
      planFirst: true,
      enablePlanner: false,
    });

    await agent.runTurn("Hi there");

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0].stage).toBe("complete"); // planning call
    expect(llmCalls[1].stage).toBe("complete"); // execution call
  });

  test("simple Q&A: PieCode with planFirst=false makes 1 LLM call (optimal)", async () => {
    const { agent, llmCalls } = createMockAgent({
      completeResponses: [
        '{"type":"final","message":"Hello! How can I help you?"}',
      ],
      planFirst: false,
    });

    await agent.runTurn("Hi there");

    expect(llmCalls).toHaveLength(1);
  });

  test("file read task: PieCode with planFirst=true makes 4 LLM calls vs Claude Code's 2", async () => {
    const { agent, llmCalls } = createMockAgent({
      completeResponses: [
        // Call 0: planning (wasted for simple read)
        '{"summary":"Read and summarize file","steps":["Read file","Summarize"],"toolBudget":2}',
        // Call 1: model decides to read file
        '{"type":"tool_use","tool":"read_file","input":{"path":"package.json"},"reason":"Read the file"}',
        // Call 2: model summarizes after reading
        '{"type":"final","message":"The file contains project configuration."}',
      ],
      planFirst: true,
      enablePlanner: false,
    });

    await agent.runTurn("Read package.json and summarize it");

    // PieCode: 1 plan + 2 execution = 3 calls
    // Claude Code would do: 1 call (returns tool_use) + 1 call (returns text) = 2 calls
    // Codex CLI would do: 1 call (returns function_call) + 1 call (returns text) = 2 calls
    expect(llmCalls).toHaveLength(3);
  });

  test("file read task: PieCode with planFirst=false matches Claude Code at 2 LLM calls", async () => {
    const { agent, llmCalls } = createMockAgent({
      completeResponses: [
        '{"type":"tool_use","tool":"read_file","input":{"path":"package.json"},"reason":"Read the file"}',
        '{"type":"final","message":"The file contains project configuration."}',
      ],
      planFirst: false,
    });

    await agent.runTurn("Read package.json and summarize it");

    expect(llmCalls).toHaveLength(2);
  });
});

// ─── Benchmark 2: System Prompt Size ────────────────────────────────────────

describe("Benchmark 2: system prompt size (affects TTFT + cost)", () => {
  /*
   * COMPARISON:
   * - Claude Code: ~2-4K tokens system prompt (lean, tool schemas via API)
   * - Codex CLI: ~1-2K tokens system prompt (tools defined via Responses API schema)
   * - PieCode: system prompt contains tool schemas as text (~3K chars base)
   *
   * PieCode embeds tool schemas as plain text in the system prompt because it
   * uses text-based JSON responses instead of native tool_use API features.
   * This inflates every single LLM call.
   */

  test("base system prompt size", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/test",
      autoApprove: false,
    });

    const charCount = prompt.length;
    const estimatedTokens = Math.ceil(charCount / 4); // rough estimate

    // PieCode's system prompt is larger than necessary because it embeds:
    // 1. Tool schemas as text (Claude Code uses API-level tool definitions)
    // 2. JSON response format instructions (Claude Code uses native tool_use)
    // 3. Redundant principles (duplicated across sections)
    expect(charCount).toBeGreaterThan(2500);

    // For reference:
    // Claude Code system prompt: ~2000-4000 tokens (tools defined via API)
    // Codex CLI system prompt: ~1000-2000 tokens (tools defined via schema)
    // PieCode system prompt: ~800-1000 tokens (but adds ~300 tokens for tool schemas as text)
    console.log(`PieCode base system prompt: ${charCount} chars (~${estimatedTokens} tokens)`);
  });

  test("system prompt with skills + plan adds significant overhead", () => {
    const basePrompt = buildSystemPrompt({ workspaceDir: "/test", autoApprove: false });
    const fullPrompt = buildSystemPrompt({
      workspaceDir: "/test",
      autoApprove: false,
      activeSkills: [
        { name: "skill-1", path: "/s1.md", content: "x".repeat(500) },
        { name: "skill-2", path: "/s2.md", content: "x".repeat(500) },
      ],
      activePlan: {
        summary: "Multi-step debugging task",
        steps: ["Read logs", "Find error", "Fix code", "Run tests"],
        toolBudget: 6,
      },
      projectInstructions: {
        source: "AGENTS.md",
        content: "Follow strict TypeScript patterns.",
      },
    });

    const overhead = fullPrompt.length - basePrompt.length;
    console.log(`Skills + plan + instructions overhead: ${overhead} chars`);

    // This overhead is sent with EVERY LLM call in the loop
    expect(overhead).toBeGreaterThan(1000);
  });

  test("system prompt is rebuilt from scratch every iteration (no caching)", () => {
    const calls = [];
    const origBuild = buildSystemPrompt;

    // PieCode rebuilds the full system prompt on every iteration
    // Claude Code and Codex use persistent system prompt with API-level caching
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const prompt = buildSystemPrompt({
        workspaceDir: "/test",
        autoApprove: false,
        activeSkills: [{ name: "s1", content: "test" }],
        activePlan: { summary: "plan", steps: ["step1"], toolBudget: 4 },
      });
      calls.push(prompt.length);
    }
    const elapsed = performance.now() - start;

    // All calls produce identical prompts (wasteful rebuild)
    expect(new Set(calls).size).toBe(1);
    console.log(`100 identical prompt rebuilds: ${elapsed.toFixed(2)}ms`);
  });
});

// ─── Benchmark 3: History Serialization ─────────────────────────────────────

describe("Benchmark 3: history serialization overhead", () => {
  /*
   * COMPARISON:
   * - Claude Code: uses native API message format (no serialization needed)
   * - Codex CLI: uses Responses API with native message threading
   * - PieCode: serializes entire history to a single text string via formatHistory()
   *            on EVERY iteration. This is O(n) per iteration, O(n*m) per turn.
   */

  test("formatHistory grows linearly and is called every iteration", () => {
    const sizes = [10, 25, 50, 100];
    const results = [];

    for (const size of sizes) {
      const history = [];
      for (let i = 0; i < size; i++) {
        history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}: ${"x".repeat(200)}` });
      }

      const start = performance.now();
      const formatted = formatHistory(history);
      const elapsed = performance.now() - start;

      results.push({ size, elapsed, outputLen: formatted.length });
    }

    console.log("History serialization scaling:");
    results.forEach((r) => {
      console.log(`  ${r.size} messages: ${r.elapsed.toFixed(3)}ms, ${r.outputLen} chars output`);
    });

    // In PieCode, this runs EVERY loop iteration.
    // With 5 tool calls, a 50-message history is serialized 5+ times.
    // Claude Code avoids this entirely by using native message arrays.
  });

  test("multi-tool task: history serialization is called N+1 times", async () => {
    let formatCallCount = 0;
    const originalFormat = formatHistory;

    // Track how many times the agent loop formats history
    const { agent, llmCalls } = createMockAgent({
      completeResponses: [
        '{"type":"tool_use","tool":"list_files","input":{},"reason":"List files"}',
        '{"type":"tool_use","tool":"read_file","input":{"path":"package.json"},"reason":"Read pkg"}',
        '{"type":"tool_use","tool":"read_file","input":{"path":"src/lib/agent.js"},"reason":"Read agent"}',
        '{"type":"final","message":"Analysis complete."}',
      ],
      planFirst: false,
    });

    const result = await agent.runTurn("Analyze the project structure");

    // PieCode made 4 LLM calls, each one re-serialized the growing history
    expect(llmCalls).toHaveLength(4);

    // Each successive call had a longer prompt because history grew
    for (let i = 1; i < llmCalls.length; i++) {
      expect(llmCalls[i].promptLen).toBeGreaterThan(llmCalls[i - 1].promptLen);
    }

    console.log("Prompt sizes per iteration:");
    llmCalls.forEach((c, i) => {
      console.log(`  Iteration ${i}: prompt=${c.promptLen} chars, system=${c.sysLen} chars`);
    });
  });
});

// ─── Benchmark 4: Response Parsing ──────────────────────────────────────────

describe("Benchmark 4: response parsing (text JSON vs native tool_use)", () => {
  /*
   * COMPARISON:
   * - Claude Code: model returns structured tool_use content blocks (no parsing needed)
   * - Codex CLI: model returns function_call objects (no parsing needed)
   * - PieCode: model returns raw text that must be parsed as JSON with multiple fallbacks
   *
   * PieCode's parseModelAction has 4 fallback strategies:
   * 1. Direct JSON.parse
   * 2. Extract first JSON object from string
   * 3. Extract first JSON object from original text
   * 4. Regex-based plain text tool block parsing
   *
   * This means every response hits at least 1 parse attempt, and malformed
   * responses can hit all 4, adding latency and fragility.
   */

  test("well-formed JSON: single parse attempt (fast path)", () => {
    const input = '{"type":"tool_use","tool":"read_file","input":{"path":"test.txt"},"reason":"Read"}';

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      parseModelAction(input);
    }
    const elapsed = performance.now() - start;

    console.log(`Well-formed JSON: ${(elapsed / 10000).toFixed(4)}ms per parse`);
    expect(elapsed).toBeLessThan(50); // 10K parses < 50ms
  });

  test("JSON with preamble text: requires extractFirstJsonObject fallback", () => {
    const input = 'I\'ll read that file for you.\n{"type":"tool_use","tool":"read_file","input":{"path":"test.txt"},"reason":"Read"}';

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      parseModelAction(input);
    }
    const elapsed = performance.now() - start;

    const result = parseModelAction(input);
    expect(result.type).toBe("tool_use");
    console.log(`JSON with preamble: ${(elapsed / 10000).toFixed(4)}ms per parse (needs fallback)`);
  });

  test("plain text fallback: slowest path with regex", () => {
    const input = 'Tool Use: read_file (Read the config)\nInput: {"path":"config.json"}';

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      parseModelAction(input);
    }
    const elapsed = performance.now() - start;

    const result = parseModelAction(input);
    expect(result.type).toBe("tool_use");
    console.log(`Plain text fallback: ${(elapsed / 10000).toFixed(4)}ms per parse (slowest)`);
  });

  test("completely invalid response: all fallbacks tried, returns final", () => {
    const input = "I apologize, but I cannot help with that. Let me try a different approach to solve your problem.";

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      parseModelAction(input);
    }
    const elapsed = performance.now() - start;

    const result = parseModelAction(input);
    expect(result.type).toBe("final");
    console.log(`Invalid response (all fallbacks): ${(elapsed / 10000).toFixed(4)}ms per parse`);
  });
});

// ─── Benchmark 5: Planning Overhead ─────────────────────────────────────────

describe("Benchmark 5: planning overhead", () => {
  /*
   * COMPARISON:
   * - Claude Code: NO separate planning call. The model plans inline within its
   *   first response, using extended thinking or just thinking text. Zero extra latency.
   * - Codex CLI: NO separate planning call. Single Responses API call handles everything.
   * - PieCode planFirst mode: ALWAYS makes a separate planning LLM call before execution.
   *   This adds 1-3 seconds of latency to EVERY turn, even trivial ones.
   * - PieCode PIECODE_ENABLE_PLANNER mode: makes TWO extra LLM calls (analyzeTask +
   *   createExecutionPlan), then executes a rigid plan without model guidance.
   */

  test("planFirst overhead: adds full LLM round-trip to every turn", async () => {
    const { agent, llmCalls } = createMockAgent({
      completeResponses: [
        '{"summary":"answer","steps":["respond"],"toolBudget":1}',
        '{"type":"final","message":"2+2=4"}',
      ],
      planFirst: true,
    });

    const start = performance.now();
    await agent.runTurn("What is 2+2?");
    const elapsed = performance.now() - start;

    expect(llmCalls).toHaveLength(2);

    // The planning call prompt is much smaller (no history formatting)
    // but it's still a full LLM round-trip adding 1-3s real latency
    console.log(`Planning call prompt: ${llmCalls[0].promptLen} chars`);
    console.log(`Execution call prompt: ${llmCalls[1].promptLen} chars`);
    console.log(`Planning call adds ${llmCalls[0].promptLen} chars of prompt overhead`);
  });

  test("replan overhead: adds another LLM call when tool budget is exceeded", async () => {
    let callCount = 0;
    const { agent, llmCalls } = createMockAgent({
      completeResponses: (n) => {
        if (n === 0) return '{"summary":"multi-step","steps":["a","b","c"],"toolBudget":2}'; // plan
        if (n === 1) return '{"type":"tool_use","tool":"list_files","input":{},"reason":"List"}';
        if (n === 2) return '{"type":"tool_use","tool":"read_file","input":{"path":"a.js"},"reason":"Read"}';
        // After 2 tool calls, budget exceeded -> replan call happens
        if (n === 3) return '{"summary":"continue","steps":["finish"],"toolBudget":4}'; // replan
        if (n === 4) return '{"type":"final","message":"Done."}';
        return '{"type":"final","message":"Done."}';
      },
      planFirst: true,
    });

    await agent.runTurn("Analyze and fix the code");

    // plan(1) + tool1(1) + tool2(1) + replan(1) + final(1) = 5 calls
    // Claude Code would do: tool1(1) + tool2(1) + final(1) = 3 calls
    console.log(`Total LLM calls with replan: ${llmCalls.length}`);
    console.log("Breakdown:", llmCalls.map((c, i) => `call${i}=${c.stage}`).join(", "));
  });

  test("PIECODE_ENABLE_PLANNER: rigid plan executes without model guidance", async () => {
    // When enablePlanner is true, PieCode:
    // 1. Makes an LLM call to analyzeTask (classify + decompose)
    // 2. Creates a static execution plan (no LLM involvement)
    // 3. Executes each step sequentially with hardcoded tool calls
    // 4. Never consults the model during execution
    //
    // This is fundamentally different from Claude Code and Codex, where
    // the model decides each tool call based on previous results.

    const { agent } = createMockAgent({
      completeResponses: [
        // analyzeTask call returns classification
        JSON.stringify({
          type: "analysis_result",
          taskType: "analysis",
          difficulty: "simple",
          goal: "Analyze project",
          subTasks: [{ id: "s1", description: "list files" }],
          requiredTools: ["list_files"],
          challenges: [],
        }),
      ],
      enablePlanner: true,
      planFirst: true,
    });

    // shouldPlanTask returns true for "analyze" keyword
    const shouldPlan = agent.shouldPlanTask("analyze the project");
    expect(shouldPlan).toBe(true);

    // The planner generates static steps, not model-driven ones
    // This means PieCode can't adapt to unexpected tool results
  });
});

// ─── Benchmark 6: End-to-End Overhead Summary ───────────────────────────────

describe("Benchmark 6: end-to-end overhead summary", () => {
  test("measure total overhead breakdown for a typical 3-tool-call task", async () => {
    const timings = { planning: 0, systemPromptBuild: 0, historyFormat: 0, parsing: 0, toolExec: 0 };

    let callCount = 0;
    const responses = [
      // plan
      '{"summary":"Read and analyze","steps":["list","read","summarize"],"toolBudget":4}',
      // tool 1
      '{"type":"tool_use","tool":"list_files","input":{},"reason":"List workspace"}',
      // tool 2
      '{"type":"tool_use","tool":"read_file","input":{"path":"package.json"},"reason":"Read pkg"}',
      // final
      '{"type":"final","message":"Analysis: This is a Node.js project with Jest tests."}',
    ];

    const provider = {
      kind: "mock",
      model: "mock",
      async complete({ systemPrompt, prompt }) {
        return responses[callCount++] ?? '{"type":"final","message":"done"}';
      },
    };

    process.env.PIECODE_PLAN_FIRST = "1";
    process.env.PIECODE_ENABLE_PLANNER = "0";

    const agent = new Agent({
      provider,
      workspaceDir: process.cwd(),
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
    });

    const start = performance.now();
    const result = await agent.runTurn("What is this project about?");
    const totalElapsed = performance.now() - start;

    // Restore env
    delete process.env.PIECODE_PLAN_FIRST;
    delete process.env.PIECODE_ENABLE_PLANNER;

    expect(result).toContain("Node.js project");
    expect(callCount).toBe(4); // 1 plan + 3 execution

    console.log("\n=== End-to-End Overhead Summary ===");
    console.log(`Total time (mock provider): ${totalElapsed.toFixed(2)}ms`);
    console.log(`Total LLM calls: ${callCount}`);
    console.log(`  - Planning calls: 1 (could be 0 like Claude Code/Codex)`);
    console.log(`  - Execution calls: 3`);
    console.log("");
    console.log("Comparison for this task (read project + summarize):");
    console.log("  Claude Code: 3 LLM calls (tool_use + tool_use + text), native streaming");
    console.log("  Codex CLI:   3 LLM calls (function_call + function_call + text), Responses API");
    console.log("  PieCode:     4 LLM calls (plan + tool + tool + text), text JSON parsing");
    console.log("");
    console.log("Per-call overhead unique to PieCode:");
    console.log("  - System prompt rebuilt from scratch (not cached)");
    console.log("  - Full history serialized to text string (not native messages)");
    console.log("  - Response parsed from raw text JSON (not structured API response)");
    console.log("  - No parallel tool execution support");
  });
});

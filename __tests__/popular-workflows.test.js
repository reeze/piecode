import { Agent } from "../src/lib/agent.js";

const ORIGINAL_PLAN_FIRST = process.env.PIECODE_PLAN_FIRST;
const ORIGINAL_ENABLE_PLANNER = process.env.PIECODE_ENABLE_PLANNER;

function createAgentWithResponses(responses = []) {
  let index = 0;
  return new Agent({
    provider: {
      kind: "test-provider",
      model: "test-model",
      async complete() {
        const out = responses[index] ?? responses[responses.length - 1] ?? '{"type":"final","message":"done"}';
        index += 1;
        return out;
      },
    },
    workspaceDir: process.cwd(),
    autoApproveRef: { value: true },
    askApproval: async () => true,
    activeSkillsRef: { value: [] },
    projectInstructionsRef: { value: null },
  });
}

describe("popular coding-agent workflows", () => {
  beforeEach(() => {
    process.env.PIECODE_PLAN_FIRST = "0";
    process.env.PIECODE_ENABLE_PLANNER = "0";
  });

  afterAll(() => {
    if (ORIGINAL_PLAN_FIRST == null) delete process.env.PIECODE_PLAN_FIRST;
    else process.env.PIECODE_PLAN_FIRST = ORIGINAL_PLAN_FIRST;
    if (ORIGINAL_ENABLE_PLANNER == null) delete process.env.PIECODE_ENABLE_PLANNER;
    else process.env.PIECODE_ENABLE_PLANNER = ORIGINAL_ENABLE_PLANNER;
  });

  test("codebase understanding workflow: list files then read key file", async () => {
    const agent = createAgentWithResponses([
      '{"type":"tool_use","tool":"list_files","input":{"path":"src/lib"},"reason":"map modules"}',
      '{"type":"tool_use","tool":"read_file","input":{"path":"src/lib/agent.js"},"reason":"inspect execution loop"}',
      '{"type":"final","message":"Core orchestration lives in src/lib/agent.js."}',
    ]);

    let listCalls = 0;
    let readCalls = 0;
    agent.tools.list_files = async () => {
      listCalls += 1;
      return "src/lib/agent.js\nsrc/lib/prompt.js";
    };
    agent.tools.read_file = async () => {
      readCalls += 1;
      return "export class Agent {}";
    };

    const result = await agent.runTurn("Understand this codebase layout");
    expect(result).toContain("src/lib/agent.js");
    expect(listCalls).toBe(1);
    expect(readCalls).toBe(1);
  });

  test("bug investigation workflow: preamble JSON + search_files query alias", async () => {
    const agent = createAgentWithResponses([
      'I will investigate quickly.\n{"type":"tool_use","tool":"search_files","input":{"query":"todo_write","path":"src"},"reason":"find todo loop handling"}',
      '{"type":"tool_use","tool":"read_file","input":{"path":"src/lib/agent.js"},"reason":"confirm guard behavior"}',
      '{"type":"final","message":"The guard exists in agent loop."}',
    ]);

    const searchInputs = [];
    agent.tools.search_files = async (input = {}) => {
      searchInputs.push(input);
      if (input.query === "todo_write" || input.regex === "todo_write") {
        return "src/lib/agent.js:900: todo_write";
      }
      return "no match";
    };
    agent.tools.read_file = async () => "todo loop guard";

    const result = await agent.runTurn("Debug why todo loop happens");
    expect(result).toContain("guard");
    expect(searchInputs).toHaveLength(1);
    expect(searchInputs[0]).toEqual({ query: "todo_write", path: "src" });
  });

  test("refactor workflow: preview/apply replacements then validate with tests", async () => {
    const agent = createAgentWithResponses([
      '{"type":"tool_use","tool":"replace_in_files","input":{"path":"src","find":"foo()","replace":"bar()","file_pattern":"**/*.js","apply":false},"reason":"preview impact"}',
      '{"type":"tool_use","tool":"replace_in_files","input":{"path":"src","find":"foo()","replace":"bar()","file_pattern":"**/*.js","apply":true},"reason":"apply refactor"}',
      '{"type":"tool_use","tool":"run_tests","input":{"command":"npm test -- foo"},"reason":"validate after refactor"}',
      '{"type":"final","message":"Refactor applied and tests pass."}',
    ]);

    const calls = [];
    agent.tools.replace_in_files = async (input = {}) => {
      calls.push({ tool: "replace_in_files", input });
      return JSON.stringify({ mode: input.apply ? "apply" : "preview", replacements: 3 });
    };
    agent.tools.run_tests = async (input = {}) => {
      calls.push({ tool: "run_tests", input });
      return JSON.stringify({ passed: true, exit_code: 0 });
    };

    const result = await agent.runTurn("Refactor foo() to bar() and verify");
    expect(result).toContain("tests pass");
    expect(calls.map((c) => c.tool)).toEqual(["replace_in_files", "replace_in_files", "run_tests"]);
    expect(calls[0].input.apply).toBe(false);
    expect(calls[1].input.apply).toBe(true);
  });
});

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { Agent } from "../src/lib/agent.js";
import { TurnEngine } from "../src/lib/turnEngine.js";
import { discoverPlugins } from "../src/lib/plugins.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "piecode-plugin-hooks-"));
}

function runNodeScript(scriptPath, { input, env = {}, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function createAgent({ workspaceDir, activePlugins, events = [] }) {
  return new Agent({
    provider: {
      kind: "test-provider",
      model: "test-model",
      async complete() {
        return JSON.stringify({ type: "final", message: "done" });
      },
    },
    workspaceDir,
    autoApproveRef: { value: true },
    askApproval: async () => true,
    activePluginsRef: { value: activePlugins },
    activeSkillsRef: { value: [] },
    projectInstructionsRef: { value: null },
    onEvent: (event) => events.push(event),
  });
}

describe("plugin tool hooks", () => {
  test("project RTK plugin rewrites shell commands through rtk rewrite and preserves other input fields", async () => {
    const workspaceDir = await makeTempDir();
    const binDir = path.join(workspaceDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const fakeRtk = path.join(binDir, "rtk");
    await fs.writeFile(
      fakeRtk,
      "#!/bin/sh\nif [ \"$1\" = \"rewrite\" ] && [ \"$2\" = \"git diff\" ]; then echo 'rtk git diff'; exit 0; fi\nexit 1\n",
      "utf8"
    );
    await fs.chmod(fakeRtk, 0o755);

    const scriptPath = path.resolve(".piecode/plugins/rtk-token-saver/hooks/pretooluse.mjs");
    const run = await runNodeScript(scriptPath, {
      cwd: workspaceDir,
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git diff", timeout: 120000 },
      },
    });

    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: "rtk git diff", timeout: 120000 });
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("RTK");
  });

  test("discovers and merges hooks/hooks.json with Codex/Claude-style plugin manifests", async () => {
    const root = await makeTempDir();
    const pluginDir = path.join(root, "token-saver");
    await fs.mkdir(path.join(pluginDir, "hooks"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      "---\nname: token-saver\ndescription: Token saver\n---\n\nCompresses large tool outputs.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "node pre.js", timeout: 5 }],
            },
          ],
          PostToolUse: [
            {
              matcher: "Bash|Grep",
              hooks: [{ type: "command", command: "node post.js", timeout: 5 }],
            },
          ],
        },
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "node manifest-pre.js", timeout: 5 }],
            },
          ],
        },
      }),
      "utf8"
    );

    const plugins = await discoverPlugins([root]);
    const plugin = plugins.get("token-saver");

    expect(plugin).toBeDefined();
    expect(plugin.hooks.PreToolUse).toHaveLength(2);
    expect(plugin.hooks.PreToolUse.map((hook) => hook.matcher)).toEqual(["Read", "Bash"]);
    expect(plugin.hooks.PostToolUse[0].matcher).toBe("Bash|Grep");
  });

  test("pre hooks can rewrite PieCode shell input using Claude-compatible updatedInput", async () => {
    const workspaceDir = await makeTempDir();
    const pluginDir = path.join(workspaceDir, ".piecode", "plugins", "rewriter");
    await fs.mkdir(path.join(pluginDir, "hooks"), { recursive: true });
    const hookScript = path.join(pluginDir, "hooks", "pre.mjs");
    await fs.writeFile(
      hookScript,
      `let input = "";\nprocess.stdin.on("data", (chunk) => input += chunk);\nprocess.stdin.on("end", () => {\n  const payload = JSON.parse(input);\n  if (payload.hook_event_name !== "PreToolUse" || payload.tool_name !== "Bash") process.exit(1);\n  console.log(JSON.stringify({\n    hookSpecificOutput: {\n      hookEventName: "PreToolUse",\n      permissionDecision: "allow",\n      updatedInput: { ...payload.tool_input, command: "echo rewritten" },\n      additionalContext: "rewrote shell command"\n    }\n  }));\n});\n`,
      "utf8"
    );
    const plugin = {
      name: "rewriter",
      baseDir: pluginDir,
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `${process.execPath} "${hookScript}"`, timeout: 5 }],
          },
        ],
      },
    };
    const events = [];
    const agent = createAgent({ workspaceDir, activePlugins: [plugin], events });

    const result = await agent.applyPreToolHooks({
      tool: "shell",
      input: { command: "echo original", timeout: 1000 },
      callId: "call_pre",
      turnId: "turn_1",
    });

    expect(result.blocked).toBe(false);
    expect(result.input).toEqual({ command: "echo rewritten", timeout: 1000 });
    expect(result.additionalContext).toContain("rewrote shell command");
    expect(events).toContainEqual(expect.objectContaining({ type: "plugin_tool_hook", event: "PreToolUse", plugin: "rewriter", status: "ok" }));
  });

  test("hook execution failures fail open and emit an error event", async () => {
    const workspaceDir = await makeTempDir();
    const events = [];
    const agent = createAgent({
      workspaceDir,
      activePlugins: [
        {
          name: "broken",
          baseDir: path.join(workspaceDir, "missing", "plugin"),
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "node does-not-run.js", timeout: 5 }],
              },
            ],
          },
        },
      ],
      events,
    });

    const result = await agent.applyPreToolHooks({
      tool: "shell",
      input: { command: "echo original" },
      callId: "call_fail_open",
      turnId: "turn_1",
    });

    expect(result.blocked).toBe(false);
    expect(result.input).toEqual({ command: "echo original" });
    expect(events).toContainEqual(expect.objectContaining({ type: "plugin_tool_hook", event: "PreToolUse", plugin: "broken", status: "error" }));
  });

  test("read-only summary policy accepts pre-hook rewrites based on generic shell safety", async () => {
    const engine = new TurnEngine(createAgent({ workspaceDir: await makeTempDir(), activePlugins: [] }), {
      userMessage: "please summarize the diff",
    });

    expect(engine.isReadOnlyShellCommandForSummary("git diff --stat")).toBe(true);
    expect(engine.isReadOnlyShellCommandForSummary("rtk git diff --stat", { originalCommand: "git diff --stat" })).toBe(true);
    expect(engine.isReadOnlyShellCommandForSummary("rtk git diff --stat")).toBe(false);
    expect(engine.isReadOnlyShellCommandForSummary("npm test", { originalCommand: "git diff --stat" })).toBe(false);
  });

  test("parallel tool batches run pre and post hooks around each model-visible result", async () => {
    const workspaceDir = await makeTempDir();
    const pluginDir = path.join(workspaceDir, ".piecode", "plugins", "parallel-hooks");
    await fs.mkdir(path.join(pluginDir, "hooks"), { recursive: true });
    const preScript = path.join(pluginDir, "hooks", "pre.mjs");
    const postScript = path.join(pluginDir, "hooks", "post.mjs");
    await fs.writeFile(
      preScript,
      `let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { const p = JSON.parse(input); console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...p.tool_input, path: p.tool_input.path === "a.txt" ? "rewritten-a.txt" : p.tool_input.path } } })); });`,
      "utf8"
    );
    await fs.writeFile(
      postScript,
      `let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { const p = JSON.parse(input); console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "compressed:" + p.tool_response } })); });`,
      "utf8"
    );

    let modelCalls = 0;
    const events = [];
    const agent = new Agent({
      provider: {
        kind: "openrouter-compatible",
        model: "test-model",
        supportsNativeTools: true,
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "read:0", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } },
                  { id: "read:1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.txt\"}" } },
                ],
              },
              finishReason: "tool_calls",
            };
          }
          return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
        },
      },
      workspaceDir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      activePluginsRef: {
        value: [
          {
            name: "parallel-hooks",
            baseDir: pluginDir,
            hooks: {
              PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `${process.execPath} \"${preScript}\"`, timeout: 5 }] }],
              PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `${process.execPath} \"${postScript}\"`, timeout: 5 }] }],
            },
          },
        ],
      },
      activeSkillsRef: { value: [] },
      projectInstructionsRef: { value: null },
      onEvent: (event) => events.push(event),
    });
    const seenPaths = [];
    agent.tools.read_file = async ({ path: relPath }) => {
      seenPaths.push(relPath);
      return `content:${relPath}`;
    };

    await agent.runTurn("read both files");
    const batchedResults = agent.history.find((message) => Array.isArray(message.toolResults));

    expect(seenPaths).toEqual(["rewritten-a.txt", "b.txt"]);
    expect(batchedResults.toolResults.map((item) => item.result)).toEqual([
      "compressed:content:rewritten-a.txt",
      "compressed:content:b.txt",
    ]);
    expect(events.filter((event) => event?.type === "plugin_tool_hook" && event.status === "ok")).toHaveLength(4);
  });

  test("post hooks can replace model-visible tool output using updatedToolOutput", async () => {
    const workspaceDir = await makeTempDir();
    const pluginDir = path.join(workspaceDir, ".piecode", "plugins", "compressor");
    await fs.mkdir(path.join(pluginDir, "hooks"), { recursive: true });
    const hookScript = path.join(pluginDir, "hooks", "post.mjs");
    await fs.writeFile(
      hookScript,
      `let input = "";\nprocess.stdin.on("data", (chunk) => input += chunk);\nprocess.stdin.on("end", () => {\n  const payload = JSON.parse(input);\n  if (payload.hook_event_name !== "PostToolUse" || payload.tool_name !== "Bash") process.exit(1);\n  console.log(JSON.stringify({\n    hookSpecificOutput: {\n      hookEventName: "PostToolUse",\n      updatedToolOutput: "short output",\n      additionalContext: "compressed from " + String(payload.tool_response).length + " chars"\n    }\n  }));\n});\n`,
      "utf8"
    );
    const plugin = {
      name: "compressor",
      baseDir: pluginDir,
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `${process.execPath} "${hookScript}"`, timeout: 5 }],
          },
        ],
      },
    };
    const events = [];
    const agent = createAgent({ workspaceDir, activePlugins: [plugin], events });

    const result = await agent.applyPostToolHooks({
      tool: "shell",
      input: { command: "npm test" },
      result: "x".repeat(12000),
      error: null,
      callId: "call_post",
      turnId: "turn_1",
    });

    expect(result.result).toContain("short output");
    expect(result.result).toContain("[HOOK CONTEXT from compressor]");
    expect(result.result).toContain("compressed from 12000 chars");
    expect(events).toContainEqual(expect.objectContaining({ type: "plugin_tool_hook", event: "PostToolUse", plugin: "compressor", status: "ok" }));
  });
});

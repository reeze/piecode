import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpHub, mergeCommonMcpServers, resolveMcpServerConfigs } from "../src/lib/mcp.js";
import { createToolset } from "../src/lib/tools.js";
import { buildSystemPrompt, buildToolDefinitions } from "../src/lib/prompt.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureServerPath = path.join(testDir, "fixtures", "mockMcpServer.mjs");
const fixtureLineServerPath = path.join(testDir, "fixtures", "mockMcpServerLine.mjs");

describe("mcp support", () => {
  test("resolves MCP server configuration from settings", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const map = resolveMcpServerConfigs(
      {
        mcpServers: {
          mock: {
            command: process.execPath,
            args: [fixtureServerPath],
          },
        },
      },
      workspaceDir
    );

    expect(map.size).toBe(1);
    expect(map.has("mock")).toBe(true);
    const row = map.get("mock");
    expect(row.command).toBe(process.execPath);
    expect(row.args).toEqual([fixtureServerPath]);
    expect(row.cwd).toBe(workspaceDir);
    expect(row.stdioProtocol).toBe("auto");
  });

  test("supports explicit stdioProtocol override", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const map = resolveMcpServerConfigs(
      {
        mcpServers: {
          lineMock: {
            command: process.execPath,
            args: [fixtureLineServerPath],
            stdioProtocol: "line",
          },
        },
      },
      workspaceDir
    );
    const row = map.get("lineMock");
    expect(row.stdioProtocol).toBe("line");
  });

  test("imports shared MCP config files and keeps local overrides", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const homeDir = path.join(workspaceDir, "home");
    const cursorPath = path.join(homeDir, ".cursor", "mcp.json");
    const claudePath = path.join(homeDir, ".claude", "claude_desktop_config.json");
    await fs.mkdir(path.dirname(cursorPath), { recursive: true });
    await fs.mkdir(path.dirname(claudePath), { recursive: true });
    await fs.writeFile(
      cursorPath,
      JSON.stringify(
        {
          mcpServers: {
            shared: { command: "cursor-cmd" },
            cursorOnly: { command: "cursor-only" },
          },
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      claudePath,
      JSON.stringify(
        {
          mcpServers: {
            claudeOnly: { command: "claude-only" },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const merged = await mergeCommonMcpServers(
      {
        mcpServers: {
          shared: { command: "local-cmd" },
        },
      },
      {
        workspaceDir,
        homeDir,
        env: {},
      }
    );

    expect(merged.mcpServers.shared.command).toBe("local-cmd");
    expect(merged.mcpServers.cursorOnly.command).toBe("cursor-only");
    expect(merged.mcpServers.claudeOnly.command).toBe("claude-only");
    expect(merged.mcp.servers.cursorOnly.command).toBe("cursor-only");
  });

  test("imports from explicit mcpImport paths and can be disabled", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const customPath = path.join(workspaceDir, "custom-mcp.json");
    await fs.writeFile(
      customPath,
      JSON.stringify(
        {
          mcp: {
            servers: {
              customServer: { command: "custom-cmd" },
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const enabled = await mergeCommonMcpServers(
      {
        mcpImport: {
          includeDefaults: false,
          paths: ["./custom-mcp.json"],
        },
      },
      {
        workspaceDir,
        homeDir: workspaceDir,
        env: {},
      }
    );
    expect(enabled.mcpServers.customServer.command).toBe("custom-cmd");

    const disabled = await mergeCommonMcpServers(
      {
        mcpImport: {
          includeDefaults: false,
          paths: ["./custom-mcp.json"],
        },
      },
      {
        workspaceDir,
        homeDir: workspaceDir,
        env: { PIECODE_MCP_IMPORT: "0" },
      }
    );
    expect(disabled.mcpServers).toBeUndefined();
  });

  test("hub can list tools/resources and call MCP tools", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const hub = new McpHub({
      workspaceDir,
      settings: {
        mcpServers: {
          mock: {
            command: process.execPath,
            args: [fixtureServerPath],
          },
        },
      },
    });

    try {
      expect(hub.hasServers()).toBe(true);
      expect(hub.getServerNames()).toEqual(["mock"]);

      const tools = await hub.listTools();
      expect(tools.some((tool) => tool.server === "mock" && tool.name === "echo_tool")).toBe(true);

      const callResult = await hub.callTool({
        server: "mock",
        tool: "echo_tool",
        input: { text: "hello" },
      });
      expect(JSON.stringify(callResult)).toContain("echo:hello");

      const resources = await hub.listResources();
      expect(resources.some((row) => row.server === "mock" && row.uri === "memo://hello")).toBe(true);

      const templates = await hub.listResourceTemplates();
      expect(templates.some((row) => row.server === "mock" && row.uriTemplate === "memo://{name}")).toBe(true);

      const resource = await hub.readResource({
        server: "mock",
        uri: "memo://hello",
      });
      expect(JSON.stringify(resource)).toContain("hello from mock mcp");
    } finally {
      await hub.close();
    }
  });

  test("hub auto-falls back to line protocol for line-delimited servers", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const hub = new McpHub({
      workspaceDir,
      settings: {
        mcpServers: {
          lineMock: {
            command: process.execPath,
            args: [fixtureLineServerPath],
          },
        },
      },
    });

    try {
      const tools = await hub.listTools({ server: "lineMock" });
      expect(tools.some((tool) => tool.server === "lineMock" && tool.name === "echo_tool")).toBe(true);
      const callResult = await hub.callTool({
        server: "lineMock",
        tool: "echo_tool",
        input: { text: "line" },
      });
      expect(JSON.stringify(callResult)).toContain("echo:line");
    } finally {
      await hub.close();
    }
  });

  test("toolset exposes MCP helper tools when MCP hub is configured", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "piecode-mcp-"));
    const hub = new McpHub({
      workspaceDir,
      settings: {
        mcpServers: {
          mock: {
            command: process.execPath,
            args: [fixtureServerPath],
          },
        },
      },
    });
    const tools = createToolset({
      workspaceDir,
      autoApproveRef: { value: true },
      askApproval: async () => true,
      mcpHub: hub,
    });

    try {
      const serversText = await tools.list_mcp_servers({});
      expect(serversText).toContain("mock");

      const toolsText = await tools.list_mcp_tools({ server: "mock" });
      expect(toolsText).toContain("echo_tool");

      const callText = await tools.mcp_call_tool({
        server: "mock",
        tool: "echo_tool",
        input: { text: "abc" },
      });
      expect(callText).toContain("echo:abc");

      const resourcesText = await tools.list_mcp_resources({ server: "mock" });
      expect(resourcesText).toContain("memo://hello");

      const templatesText = await tools.list_mcp_resource_templates({ server: "mock" });
      expect(templatesText).toContain("memo://{name}");

      const readText = await tools.read_mcp_resource({ server: "mock", uri: "memo://hello" });
      expect(readText).toContain("hello from mock mcp");
    } finally {
      await hub.close();
    }
  });

  test("prompt/tool definitions include MCP tools when enabled", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/tmp/work",
      autoApprove: false,
      nativeTools: false,
      mcpEnabled: true,
      mcpServerNames: ["mock"],
    });
    expect(prompt).toContain("MCP servers available: mock");
    expect(prompt).toContain("list_mcp_servers");
    expect(prompt).toContain("mcp_call_tool");
    expect(prompt).toContain("read_mcp_resource");

    const openaiTools = buildToolDefinitions("openai", {
      mcpEnabled: true,
      mcpServerNames: ["mock"],
    });
    expect(openaiTools.some((row) => row.function?.name === "list_mcp_servers")).toBe(true);
    expect(openaiTools.some((row) => row.function?.name === "mcp_call_tool")).toBe(true);
    expect(openaiTools.some((row) => row.function?.name === "read_mcp_resource")).toBe(true);
  });
});

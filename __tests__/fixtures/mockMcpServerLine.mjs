import process from "node:process";

let lineBuffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(msg) {
  const method = String(msg?.method || "");
  if (!Object.prototype.hasOwnProperty.call(msg || {}, "id")) return;
  const id = msg.id;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: "mock-mcp-line",
          version: "1.0.0",
        },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo_tool",
            description: "Echoes provided text",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = String(msg?.params?.name || "");
    const args = msg?.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
    if (name === "echo_tool") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `echo:${String(args.text || "")}`,
            },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: `unknown tool: ${name}`,
      },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `method not found: ${method}`,
    },
  });
}

function handleLine(line) {
  const text = String(line || "").trim();
  if (!text) return;

  // Simulate servers that expect line-delimited JSON and reject framed stdio input.
  if (/^content-length:/i.test(text)) {
    process.stderr.write(
      "Received exception from stream: Invalid JSON expected value at line 1 column 1 input_value='Content-Length: ...'\n"
    );
    setTimeout(() => process.exit(2), 0);
    return;
  }

  let msg = null;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "notifications/initialized") return;
  handleRequest(msg);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lineBuffer += String(chunk || "");
  while (true) {
    const idx = lineBuffer.indexOf("\n");
    if (idx < 0) break;
    const line = lineBuffer.slice(0, idx);
    lineBuffer = lineBuffer.slice(idx + 1);
    handleLine(line);
  }
});

import process from "node:process";

let buffer = Buffer.alloc(0);
const separator = Buffer.from("\r\n\r\n");

function send(message) {
  const payload = JSON.stringify(message);
  const bytes = Buffer.byteLength(payload, "utf8");
  process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${payload}`);
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
          name: "mock-mcp",
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

  if (method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          {
            uri: "memo://hello",
            name: "hello",
            description: "Greeting memo",
            mimeType: "text/plain",
          },
        ],
      },
    });
    return;
  }

  if (method === "resources/templates/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resourceTemplates: [
          {
            uriTemplate: "memo://{name}",
            name: "memo template",
            description: "Template for memo resources",
            mimeType: "text/plain",
          },
        ],
      },
    });
    return;
  }

  if (method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri: String(msg?.params?.uri || ""),
            mimeType: "text/plain",
            text: "hello from mock mcp",
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
      code: -32601,
      message: `method not found: ${method}`,
    },
  });
}

function handlePayload(payload) {
  let msg = null;
  try {
    msg = JSON.parse(payload);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "notifications/initialized") return;
  handleRequest(msg);
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf(separator);
    if (headerEnd < 0) return;
    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    let contentLength = 0;
    for (const line of headerText.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "content-length") {
        contentLength = Number.parseInt(value, 10);
      }
    }
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      buffer = buffer.slice(headerEnd + separator.length);
      continue;
    }
    const payloadStart = headerEnd + separator.length;
    const payloadEnd = payloadStart + contentLength;
    if (buffer.length < payloadEnd) return;
    const payload = buffer.slice(payloadStart, payloadEnd).toString("utf8");
    buffer = buffer.slice(payloadEnd);
    handlePayload(payload);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  drain();
});

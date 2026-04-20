const fs = require("fs");

function runToolMcpServer({ toolHost, runtimeId = "", workspaceRoot = "" }) {
  const reader = createMessageReader(process.stdin);

  reader.onMessage(async (message) => {
    if (!message || typeof message !== "object") {
      return;
    }
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    const params = message.params || {};

    try {
      if (method === "initialize") {
        writeRpcResponse(id, {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "cyberboss-tools",
            version: "0.1.0",
          },
        });
        return;
      }

      if (method === "notifications/initialized") {
        return;
      }

      if (method === "tools/list") {
        writeRpcResponse(id, {
          tools: toolHost.listTools(),
        });
        return;
      }

      if (method === "tools/call") {
        const toolName = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object"
          ? params.arguments
          : {};
        const result = await toolHost.invokeTool(toolName, args, {
          runtimeId,
          workspaceRoot,
        });
        writeRpcResponse(id, {
          content: [
            {
              type: "text",
              text: formatToolResult(result),
            },
          ],
        });
        return;
      }

      writeRpcError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      writeRpcResponse(id, {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error || "unknown error"),
          },
        ],
        isError: true,
      });
    }
  });
}

function formatToolResult(result) {
  if (!result || typeof result !== "object") {
    return String(result || "");
  }
  if (result.text && result.data) {
    return `${result.text}\n${JSON.stringify(result.data, null, 2)}`;
  }
  if (result.text) {
    return String(result.text);
  }
  return JSON.stringify(result, null, 2);
}

function createMessageReader(stream) {
  let buffer = Buffer.alloc(0);
  const listeners = new Set();

  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) {
        return;
      }
      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
      buffer = buffer.slice(bodyStart + contentLength);
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      for (const listener of listeners) {
        listener(parsed);
      }
    }
  });

  return {
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function writeRpcResponse(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function writeRpcError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  fs.writeSync(process.stdout.fd, Buffer.concat([header, body]));
}

module.exports = { runToolMcpServer };

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

let input = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  parseAvailableMessages();
});

function parseAvailableMessages(): void {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const header = input.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      return;
    }

    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (input.length < bodyEnd) {
      return;
    }

    const body = input.subarray(bodyStart, bodyEnd).toString("utf8");
    input = input.subarray(bodyEnd);
    handle(JSON.parse(body) as JsonRpcRequest);
  }
}

function handle(request: JsonRpcRequest): void {
  if (request.id === undefined) {
    return;
  }

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "runx-mcp-fixture",
        version: "0.0.0",
      },
    });
    return;
  }

  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "echo",
          description: "Echo a message through the fixture MCP server.",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "Message to echo.",
              },
            },
            required: ["message"],
            additionalProperties: false,
          },
        },
        {
          name: "fail",
          description: "Return a fixture MCP error for testing.",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "sleep",
          description: "Never respond, for timeout testing.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "env",
          description: "Return a single fixture server environment variable.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
              },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (request.method === "tools/call") {
    handleToolCall(request.id, request.params);
    return;
  }

  respondError(request.id, -32601, "method not found");
}

function handleToolCall(id: number, params: unknown): void {
  if (!isRecord(params) || typeof params.name !== "string") {
    respondError(id, -32602, "invalid tool call");
    return;
  }

  if (params.name === "sleep") {
    return;
  }

  const args = isRecord(params.arguments) ? params.arguments : {};

  if (params.name === "env") {
    respond(id, {
      content: [
        {
          type: "text",
          text: String(process.env[String(args.name ?? "")] ?? ""),
        },
      ],
    });
    return;
  }

  if (params.name === "fail") {
    respondError(id, -32000, `fixture failure: ${String(args.message ?? "")}`);
    return;
  }

  if (params.name !== "echo") {
    respondError(id, -32601, "tool not found");
    return;
  }

  respond(id, {
    content: [
      {
        type: "text",
        text: String(args.message ?? ""),
      },
    ],
  });
}

function respond(id: number, result: unknown): void {
  write({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function respondError(id: number, code: number, message: string): void {
  write({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function write(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

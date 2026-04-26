import { describe, expect, it } from "vitest";

import { invokeMcp } from "./index.js";

const fixtureServer = {
  command: "node",
  args: ["--import", "tsx", "packages/core/src/harness/mcp-fixture.ts"],
  cwd: ".",
};

describe("invokeMcp", () => {
  it("calls an MCP echo tool over stdio", async () => {
    const result = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: fixtureServer,
        tool: "echo",
        arguments: { message: "{{message}}" },
        raw: {},
        timeoutSeconds: 15,
      },
      inputs: { message: "hi" },
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("hi");
    expect(result.metadata?.mcp).toBeDefined();
  }, 15000);

  it("returns sanitized MCP tool errors", async () => {
    const result = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: fixtureServer,
        tool: "fail",
        arguments: { message: "{{message}}" },
        raw: {},
        timeoutSeconds: 15,
      },
      inputs: { message: "super-secret-value" },
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toBe("MCP tool returned error -32000.");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  }, 15000);

  it("applies the sandbox env allowlist to MCP server processes", async () => {
    const blocked = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: fixtureServer,
        tool: "env",
        arguments: { name: "RUNX_SECRET_VALUE" },
        raw: {},
        timeoutSeconds: 15,
        sandbox: {
          profile: "readonly",
          cwdPolicy: "workspace",
          envAllowlist: ["PATH", "ALLOWED_VALUE"],
          writablePaths: [],
          raw: {},
        },
      },
      inputs: {},
      skillDirectory: process.cwd(),
      env: {
        PATH: process.env.PATH,
        ALLOWED_VALUE: "allowed",
        RUNX_SECRET_VALUE: "secret",
      },
    });

    expect(blocked.status).toBe("success");
    expect(blocked.stdout).toBe("");
    expect(blocked.metadata?.sandbox).toMatchObject({
      profile: "readonly",
      env: {
        mode: "allowlist",
        allowlist: ["PATH", "ALLOWED_VALUE"],
      },
      filesystem: {
        enforcement: "bubblewrap-mount-namespace",
      },
    });

    const allowed = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: fixtureServer,
        tool: "env",
        arguments: { name: "ALLOWED_VALUE" },
        raw: {},
        timeoutSeconds: 15,
        sandbox: {
          profile: "readonly",
          cwdPolicy: "workspace",
          envAllowlist: ["PATH", "ALLOWED_VALUE"],
          writablePaths: [],
          raw: {},
        },
      },
      inputs: {},
      skillDirectory: process.cwd(),
      env: {
        PATH: process.env.PATH,
        ALLOWED_VALUE: "allowed",
        RUNX_SECRET_VALUE: "secret",
      },
    });

    expect(allowed.status).toBe("success");
    expect(allowed.stdout).toBe("allowed");
    expect(JSON.stringify(blocked)).not.toContain("secret");
    expect(JSON.stringify(allowed)).not.toContain("secret");
  }, 15000);

  it("times out unanswered MCP tool calls", async () => {
    const result = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: fixtureServer,
        tool: "sleep",
        raw: {},
        timeoutSeconds: 0.05,
      },
      inputs: {},
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toContain("timed out");
  }, 15000);

  it("returns sanitized failure when the MCP server sends malformed JSON", async () => {
    const malformedServer = {
      command: "node",
      args: [
        "-e",
        "const body = '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":'; process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
      ],
    };
    const result = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: malformedServer,
        tool: "echo",
        raw: {},
        timeoutSeconds: 1,
      },
      inputs: {},
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toBe("MCP adapter failed.");
  }, 15000);

  it("returns failure for missing tool metadata", async () => {
    const result = await invokeMcp({
      source: {
        type: "mcp",
        args: [],
        server: fixtureServer,
        raw: {},
      },
      inputs: {},
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
  });
});

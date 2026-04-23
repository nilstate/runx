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

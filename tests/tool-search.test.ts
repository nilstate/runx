import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("tool-search CLI", () => {
  it("returns imported fixture MCP tools as JSON", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["tool", "search", "echo", "--source", "fixture-mcp", "--json"],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_ENABLE_FIXTURE_TOOL_CATALOG: "1",
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const report = JSON.parse(stdout.contents()) as {
      status: string;
      query: string;
      source: string;
      results: Array<{
        name: string;
        source: string;
        source_label: string;
        source_type: string;
        namespace: string;
        external_name: string;
        catalog_ref: string;
      }>;
    };
    expect(report).toMatchObject({
      status: "success",
      query: "echo",
      source: "fixture-mcp",
    });
    expect(report.results).toEqual([
      expect.objectContaining({
        name: "fixture.echo",
        source: "fixture-mcp",
        source_label: "Fixture MCP Catalog",
        source_type: "mcp",
        namespace: "fixture",
        external_name: "echo",
        catalog_ref: "fixture-mcp:fixture.echo",
      }),
    ]);
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}

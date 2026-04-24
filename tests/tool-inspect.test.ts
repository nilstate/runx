import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("tool-inspect CLI", () => {
  it("returns imported tool inspection as JSON", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["tool", "inspect", "fixture.echo", "--source", "fixture-mcp", "--json"],
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
      tool: {
        name: string;
        execution_source_type: string;
        provenance: {
          origin: string;
          source: string;
          source_type: string;
          catalog_ref: string;
        };
      };
    };
    expect(report).toMatchObject({
      status: "success",
      tool: {
        name: "fixture.echo",
        execution_source_type: "catalog",
        provenance: {
          origin: "imported",
          source: "fixture-mcp",
          source_type: "mcp",
          catalog_ref: "fixture-mcp:fixture.echo",
        },
      },
    });
  });

  it("renders local tool inspection for built-in tools", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["tool", "inspect", "fs.read"],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("fs.read");
    expect(stdout.contents()).toContain("local");
    expect(stdout.contents()).toContain("cli-tool");
    expect(stdout.contents()).toContain("path: string");
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

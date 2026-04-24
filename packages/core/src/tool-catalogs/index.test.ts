import { describe, expect, it } from "vitest";

import {
  createFixtureMcpToolCatalogAdapter,
  resolveCatalogTool,
  searchToolCatalogAdapters,
} from "./index.js";

describe("tool catalogs", () => {
  it("imports fixture MCP tools as normalized runx tools", async () => {
    const adapters = [createFixtureMcpToolCatalogAdapter()];

    const results = await searchToolCatalogAdapters(adapters, "echo");
    expect(results).toEqual([
      expect.objectContaining({
        tool_id: "fixture-mcp/fixture.echo",
        name: "fixture.echo",
        source: "fixture-mcp",
        source_label: "Fixture MCP Catalog",
        source_type: "mcp",
        namespace: "fixture",
        external_name: "echo",
        catalog_ref: "fixture-mcp:fixture.echo",
      }),
    ]);

    const resolved = await resolveCatalogTool(adapters, "fixture.echo", {
      env: { ...process.env, RUNX_CWD: process.cwd() },
      searchFromDirectory: process.cwd(),
    });

    expect(resolved).toMatchObject({
      referencePath: "catalog:fixture-mcp:fixture.echo",
      result: expect.objectContaining({
        name: "fixture.echo",
        source: "fixture-mcp",
      }),
      tool: {
        name: "fixture.echo",
        source: {
          type: "mcp",
          tool: "echo",
        },
        scopes: ["fixture.echo"],
        inputs: {
          message: {
            type: "string",
            required: true,
            description: "Message to echo.",
          },
        },
      },
    });
  });
});

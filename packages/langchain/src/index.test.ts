import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";

import type { RunLocalSkillResult } from "@runxhq/core/runner-local";

import { createLangChainToolCatalogAdapter, createRunxLangChainTool } from "./index.js";

describe("@runxhq/langchain", () => {
  it("normalizes LangChain tools into runx tool catalog entries and invokes them", async () => {
    const echoTool = tool(
      async ({ message }: { message: string }) => `echo:${message}`,
      {
        name: "echo",
        description: "Echo a message from LangChain.",
        schema: z.object({
          message: z.string().describe("Message to echo."),
        }),
      },
    );

    const adapter = createLangChainToolCatalogAdapter({
      source: "langchain-demo",
      label: "LangChain Demo",
      namespace: "langchain",
      baseDirectory: process.cwd(),
      tools: [echoTool],
    });

    const results = await adapter.search("echo");
    expect(results).toEqual([
      expect.objectContaining({
        name: "langchain.echo",
        source: "langchain-demo",
        source_type: "langchain",
        catalog_ref: "langchain-demo:langchain.echo",
      }),
    ]);

    const resolved = await adapter.resolve?.("langchain-demo:langchain.echo", {
      searchFromDirectory: process.cwd(),
      env: process.env,
    });
    expect(resolved).toMatchObject({
      referencePath: "catalog:langchain-demo:langchain.echo",
      tool: {
        name: "langchain.echo",
        source: {
          type: "catalog",
          catalogRef: "langchain-demo:langchain.echo",
        },
        inputs: {
          message: {
            type: "string",
            required: true,
            description: "Message to echo.",
          },
        },
      },
    });

    const invocation = await resolved?.invoke({
      inputs: { message: "hello" },
      skillDirectory: process.cwd(),
    });
    expect(invocation).toMatchObject({
      status: "success",
      stdout: "echo:hello",
    });
  });

  it("wraps a governed runx workflow as a LangChain tool", async () => {
    const runSkill = vi.fn(async () => successResult("wrapped-output"));

    const wrapped = createRunxLangChainTool({
      name: "docs_pr",
      description: "Open a governed docs PR workflow.",
      schema: z.object({
        repo: z.string(),
      }),
      skillPath: "/tmp/skills/docs-pr",
      sdk: { runSkill },
      mapInput: (input) => {
        const record = input as { repo: string };
        return { repo_url: record.repo };
      },
    });

    const output = await wrapped.invoke({ repo: "acme/docs" });
    expect(output).toBe("wrapped-output");
    expect(runSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillPath: "/tmp/skills/docs-pr",
      inputs: { repo_url: "acme/docs" },
    }));
  });

  it("fails fast when a wrapped runx workflow pauses for resolution", async () => {
    const runSkill = vi.fn(async (): Promise<RunLocalSkillResult> => ({
      status: "needs_resolution",
      skill: {} as never,
      skillPath: "/tmp/skills/review",
      inputs: { repo: "acme/docs" },
      runId: "run_123",
      requests: [],
    }));

    const wrapped = createRunxLangChainTool({
      name: "review_pr",
      description: "Run governed review.",
      schema: z.object({
        repo: z.string(),
      }),
      skillPath: "/tmp/skills/review",
      sdk: { runSkill },
    });

    await expect(wrapped.invoke({ repo: "acme/docs" })).rejects.toThrow(
      "paused for resolution",
    );
  });
});

function successResult(stdout: string): RunLocalSkillResult {
  return {
    status: "success",
    skill: {} as never,
    inputs: {},
    execution: {
      status: "success",
      stdout,
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 1,
    },
    state: {} as never,
    receipt: {} as never,
  };
}

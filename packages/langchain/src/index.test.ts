import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createRunxCliSkillRunner,
  createRunxLangChainTool,
  type RunxCliProcessRunner,
  type RunxSkillCliResult,
} from "./index.js";

describe("@runxhq/langchain", () => {
  it("invokes governed runx skills through the CLI JSON boundary", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    const processRunner: RunxCliProcessRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          status: "sealed",
          schema: "runx.skill_run.v1",
          result: "from-cli",
        }),
        stderr: "",
      };
    };

    const runner = createRunxCliSkillRunner({
      command: "fake-runx",
      env: {
        ...process.env,
        RUNX_LANGCHAIN_CAPTURE_PATH: "/tmp/runx-langchain-argv.txt",
      },
      processRunner,
    });
    const result = await runner.runSkill({
      skillPath: "/tmp/skills/docs-pr",
      receiptDir: "/tmp/receipts",
      runId: "run_123",
      answersPath: "/tmp/answers.json",
    });

    expect(result).toEqual({
      status: "sealed",
      schema: "runx.skill_run.v1",
      result: "from-cli",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("fake-runx");
    expect(calls[0]?.env.RUNX_LANGCHAIN_CAPTURE_PATH).toBe("/tmp/runx-langchain-argv.txt");
    expect(calls[0]?.args).toEqual([
      "resume",
      "run_123",
      "/tmp/answers.json",
      "--json",
      "--receipt-dir",
      "/tmp/receipts",
    ]);
  });

  it("wraps a governed runx workflow as a LangChain tool", async () => {
    const runSkill = vi.fn(async (): Promise<RunxSkillCliResult> => successResult("wrapped-output"));

    const wrapped = createRunxLangChainTool({
      name: "docs_pr",
      description: "Open a governed docs PR workflow.",
      schema: z.object({
        repo: z.string(),
      }),
      skillPath: "/tmp/skills/docs-pr",
      cli: { runSkill },
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
    const runSkill = vi.fn(async (): Promise<RunxSkillCliResult> => ({
      status: "needs_agent",
      schema: "runx.skill_run.v1",
      run_id: "run_123",
      requests: [],
    }));

    const wrapped = createRunxLangChainTool({
      name: "review_pr",
      description: "Run governed review.",
      schema: z.object({
        repo: z.string(),
      }),
      skillPath: "/tmp/skills/review",
      cli: { runSkill },
    });

    await expect(wrapped.invoke({ repo: "acme/docs" })).rejects.toThrow(
      "needs agent input",
    );
  });
});

function successResult(stdout: string): RunxSkillCliResult {
  return {
    status: "sealed",
    schema: "runx.skill_run.v1",
    result: stdout,
  };
}

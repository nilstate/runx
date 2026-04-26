import { describe, expect, it } from "vitest";

import { writeLocalSkillResult } from "./cli-presentation.js";

describe("CLI presentation", () => {
  it("renders escalated graph-backed skill results distinctly in JSON mode", () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = writeLocalSkillResult(
      { stdin: process.stdin, stdout, stderr },
      {},
      { json: true } as any,
      {
        status: "failure",
        skill: { name: "fanout-skill" },
        inputs: {},
        execution: {
          status: "failure",
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: null,
          durationMs: 1,
          errorMessage: "fanout escalation: conflicting recommendations",
        },
        state: {},
        receipt: {
          id: "gx_escalated",
          kind: "graph_execution",
          status: "failure",
          duration_ms: 1,
          disposition: "escalated",
          outcome_state: "pending",
        },
      } as any,
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "escalated",
      execution_status: "failure",
      disposition: "escalated",
      outcome_state: "pending",
    });
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

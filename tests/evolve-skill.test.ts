import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("evolve skill", () => {
  it("introspects by default with no objective and resumes to a bounded recommendation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-evolve-introspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const answersPath = path.join(tempDir, "answers.json");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const firstExitCode = await runCli(
        ["evolve", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      );

      expect(firstExitCode).toBe(2);
      expect(stderr.contents()).toBe("");
      const firstReport = JSON.parse(stdout.contents()) as {
        status: string;
        run_id: string;
        requests: Array<{
          id: string;
          kind: string;
          work?: {
            envelope: {
              inputs: {
                repo_profile: {
                  root: string;
                };
              };
            };
          };
        }>;
      };
      expect(firstReport).toMatchObject({
        status: "needs_resolution",
        requests: [{ id: "agent_step.evolve-introspect.output", kind: "cognitive_work" }],
      });
      expect(firstReport.requests[0]?.work?.envelope.inputs.repo_profile.root).toBe(process.cwd());
      stdout.clear();

      await writeFile(
        answersPath,
        `${JSON.stringify(
          {
            answers: {
              "agent_step.evolve-introspect.output": {
                opportunity_report: {
                  summary: "Documentation and release hygiene are the highest-leverage gaps.",
                  opportunities: [
                    {
                      id: "docs-release-notes",
                      title: "Add release notes workflow",
                      impact: "high",
                      effort: "low",
                    },
                  ],
                },
                recommended_objective: {
                  objective: "add release notes",
                  rationale: "Bounded docs improvement with visible user value.",
                },
                change_plan: {
                  steps: ["draft release notes process", "add docs"],
                  estimated_scope: "small",
                  risk_assessment: "low",
                },
                spec_document: {
                  spec_version: "1.1",
                  task_id: "evolve_release_notes",
                  phases: ["scope", "model", "materialize"],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const exitCode = await runCli(
        [
          "evolve",
          "--receipt",
          firstReport.run_id,
          "--answers",
          answersPath,
          "--receipt-dir",
          receiptDir,
          "--non-interactive",
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");

      const report = JSON.parse(stdout.contents()) as {
        status: string;
        receipt: { id: string; kind: string };
      };
      expect(report.status).toBe("success");
      expect(report.receipt).toMatchObject({
        kind: "chain_execution",
      });

      const journal = await readFile(path.join(receiptDir, "journals", `${report.receipt.id}.jsonl`), "utf8");
      expect(journal).toContain("\"type\":\"run_event\"");
      expect(journal).toContain("\"step_id\":\"introspect\"");
      expect(journal).toContain("\"selected_runner\":\"introspect\"");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("yields the plan request and resumes to completion on the same run id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-evolve-"));
    const receiptDir = path.join(tempDir, "receipts");
    const answersPath = path.join(tempDir, "answers.json");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const firstExitCode = await runCli(
        ["evolve", "add release notes", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      );

      expect(firstExitCode).toBe(2);
      expect(stderr.contents()).toBe("");
      const firstReport = JSON.parse(stdout.contents()) as {
        status: string;
        run_id: string;
        requests: Array<{ id: string; kind: string }>;
      };
      expect(firstReport).toMatchObject({
        status: "needs_resolution",
        requests: [{ id: "agent_step.evolve-plan.output", kind: "cognitive_work" }],
      });
      stdout.clear();

      await writeFile(
        answersPath,
        `${JSON.stringify(
          {
            answers: {
              "agent_step.evolve-plan.output": {
                objective_brief: {
                  objective: "add release notes",
                  target_type: "repo",
                  target_ref: ".",
                },
                diagnosis_report: {
                  findings: ["docs missing"],
                  recommended_phases: ["plan", "act"],
                },
                change_plan: {
                  steps: ["draft release notes"],
                  estimated_scope: "small",
                  risk_assessment: "low",
                },
                spec_document: {
                  spec_version: "1.1",
                  task_id: "evolve_release_notes",
                  phases: ["plan", "act"],
                },
              },
            },
            approvals: {
              "evolve.plan.approval": true,
            },
          },
          null,
          2,
        )}\n`,
      );

      const exitCode = await runCli(
        [
          "evolve",
          "--receipt",
          firstReport.run_id,
          "--answers",
          answersPath,
          "--receipt-dir",
          receiptDir,
          "--non-interactive",
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");

      const report = JSON.parse(stdout.contents()) as {
        status: string;
        receipt: { id: string; kind: string };
      };
      expect(report.status).toBe("success");
      expect(report.receipt).toMatchObject({
        kind: "chain_execution",
      });

      const journal = await readFile(path.join(receiptDir, "journals", `${report.receipt.id}.jsonl`), "utf8");
      expect(journal).toContain("\"type\":\"run_event\"");
      expect(journal).toContain("\"step_id\":\"plan\"");
      expect(journal).toContain("\"type\":\"receipt_link\"");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string; clear: () => void } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
    clear: () => {
      buffer = "";
    },
  } as NodeJS.WriteStream & { contents: () => string; clear: () => void };
}

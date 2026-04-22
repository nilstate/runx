import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readJournalEntries } from "../packages/artifacts/src/index.js";
import { createFileJournalStore } from "../packages/memory/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { inspectLocalGraph, runLocalGraph, runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("local governed graph runner", () => {
  it("runs a sequential chain and writes linked receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/sequential/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps.map((step) => step.stepId)).toEqual(["first", "second"]);
      expect(result.steps[0].stdout).toBe("hello from chain");
      expect(result.steps[1].stdout).toBe("hello from chain");
      expect(result.steps[1].contextFrom).toEqual([
        {
          input: "message",
          fromStep: "first",
          output: "stdout",
          receiptId: result.steps[0].receiptId,
        },
      ]);
      expect(result.receipt.kind).toBe("graph_execution");
      expect(result.receipt.steps.map((step) => step.receipt_id)).toEqual(result.steps.map((step) => step.receiptId));

      const files = await readdir(receiptDir);
      expect(files).toContain("journals");
      expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(3);
      expect(files).toContain(`${result.receipt.id}.json`);

      const chainReceiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(chainReceiptContents).not.toContain("hello from chain");
      expect(chainReceiptContents).not.toContain(process.cwd());
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes explicit chain inputs into steps without storing raw inputs in the chain receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-input-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/sequential/input.yaml"),
        inputs: { message: "explicit chain input" },
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0].stdout).toBe("explicit chain input");

      const chainReceiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(chainReceiptContents).not.toContain("explicit chain input");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspects a sequential chain receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-composite-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/sequential/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const inspection = await inspectLocalGraph({
        graphId: result.receipt.id,
        receiptDir,
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });

      expect(inspection.summary).toMatchObject({
        id: result.receipt.id,
        name: "sequential-echo",
        status: "success",
      });
      expect(inspection.summary.steps.map((step) => step.id)).toEqual(["first", "second"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspects a composite receipt through the CLI shell", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-cli-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/sequential/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });
      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const inspectExit = await runCli(
        ["skill", "inspect", result.receipt.id, "--receipt-dir", receiptDir],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir, RUNX_HOME: path.join(tempDir, "home") },
      );

      expect(inspectExit).toBe(0);
      expect(stdout.contents()).toContain("sequential-echo");
      expect(stdout.contents()).toContain("graph_execution");
      expect(stdout.contents()).toContain(result.receipt.id);
      expect(stdout.contents()).toContain("verified");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes step_started before step_waiting_resolution for agent-mediated graph steps", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-started-before-waiting-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const graphPath = path.join(tempDir, "waiting-chain.yaml");

    try {
      await writeFile(
        graphPath,
        `name: waiting-chain
owner: runx
steps:
  - id: review
    skill: ${JSON.stringify(path.resolve("fixtures/skills/agent-step"))}
    inputs:
      prompt: review this
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });

      expect(result.status).toBe("needs_resolution");
      if (result.status !== "needs_resolution") {
        return;
      }

      const stepEvents = (await readJournalEntries(receiptDir, result.runId))
        .filter((entry) => entry.type === "run_event" && entry.data.step_id === "review")
        .map((entry) => entry.data.kind);

      expect(stepEvents).toEqual(["step_started", "step_waiting_resolution"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects reflect facts only for opted-in post-run policies", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-post-run-reflect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const skillDir = path.join(tempDir, "reflectable");
    const journalDir = path.join(tempDir, "journal");
    const project = path.join(tempDir, "project");
    const caller: Caller = {
      resolve: async (request) => {
        if (request.kind !== "cognitive_work") {
          return undefined;
        }
        if (request.id === "agent_step.reflectable-auto.output") {
          return {
            actor: "reviewer",
            payload: {
              verdict: "auto",
            },
          };
        }
        if (request.id === "agent_step.reflectable-never.output") {
          return {
            actor: "reviewer",
            payload: {
              verdict: "never",
            },
          };
        }
        return undefined;
      },
      report: () => undefined,
    };

    try {
      await writeReflectableSkill(skillDir);
      const env = {
        ...process.env,
        RUNX_CWD: tempDir,
        INIT_CWD: tempDir,
        RUNX_PROJECT: project,
        RUNX_JOURNAL_DIR: "journal",
      };

      const autoResult = await runLocalSkill({
        skillPath: skillDir,
        runner: "auto-review",
        caller,
        env,
        receiptDir,
        runxHome,
      });
      expect(autoResult.status).toBe("success");
      if (autoResult.status !== "success") {
        return;
      }

      await expect(createFileJournalStore(journalDir).listFacts({ project })).resolves.toEqual([
        expect.objectContaining({
          scope: "reflect",
          key: `receipt:${autoResult.receipt.id}`,
          source: "post_run.reflect",
          receipt_id: autoResult.receipt.id,
          value: expect.objectContaining({
            skill_ref: "reflectable",
            policy: "auto",
            mediation: "agentic",
            selected_runner: "auto-review",
          }),
        }),
      ]);
      expect(
        (await readJournalEntries(receiptDir, autoResult.receipt.id)).some(
          (entry) => entry.type === "run_event" && entry.data.kind === "reflect_projected",
        ),
      ).toBe(true);

      const alwaysResult = await runLocalSkill({
        skillPath: skillDir,
        runner: "always-deterministic",
        caller,
        env,
        receiptDir,
        runxHome,
      });
      expect(alwaysResult.status).toBe("success");
      if (alwaysResult.status !== "success") {
        return;
      }

      await expect(createFileJournalStore(journalDir).listFacts({ project })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: `receipt:${autoResult.receipt.id}`,
            value: expect.objectContaining({ policy: "auto" }),
          }),
          expect.objectContaining({
            key: `receipt:${alwaysResult.receipt.id}`,
            value: expect.objectContaining({
              policy: "always",
              mediation: "deterministic",
              selected_runner: "always-deterministic",
            }),
          }),
        ]),
      );
      expect(
        (await readJournalEntries(receiptDir, alwaysResult.receipt.id)).some(
          (entry) => entry.type === "run_event" && entry.data.kind === "reflect_projected",
        ),
      ).toBe(true);

      const neverResult = await runLocalSkill({
        skillPath: skillDir,
        runner: "never-review",
        caller,
        env,
        receiptDir,
        runxHome,
      });
      expect(neverResult.status).toBe("success");
      if (neverResult.status !== "success") {
        return;
      }

      const facts = await createFileJournalStore(journalDir).listFacts({ project });
      expect(facts).toHaveLength(2);
      expect(facts.some((fact) => fact.key === `receipt:${neverResult.receipt.id}`)).toBe(false);
      expect(
        (await readJournalEntries(receiptDir, neverResult.receipt.id)).some(
          (entry) => entry.type === "run_event" && entry.data.kind === "reflect_projected",
        ),
      ).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeReflectableSkill(skillDir: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: reflectable
description: Temporary fixture for post-run reflect policy tests.
---
Reflectable test fixture.
`,
  );
  await writeFile(
    path.join(skillDir, "X.yaml"),
    `skill: reflectable
runners:
  auto-review:
    type: agent-step
    agent: reviewer
    task: reflectable-auto
    outputs:
      verdict: string
    runx:
      post_run:
        reflect: auto
  always-deterministic:
    type: cli-tool
    command: node
    args:
      - -e
      - |
          process.stdout.write(JSON.stringify({ verdict: "deterministic" }));
    runx:
      post_run:
        reflect: always
  never-review:
    type: agent-step
    agent: reviewer
    task: reflectable-never
    outputs:
      verdict: string
    runx:
      post_run:
        reflect: never
`,
  );
}

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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseChainYaml, validateChain } from "../packages/parser/src/index.js";
import { runLocalChain, runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const passiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("project rules", () => {
  it("injects governed MEMORY.md and CONVENTIONS.md into agent envelopes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-project-rules-envelope-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const memoryContents = "# Workspace Memory\n\nKeep changes bounded.\n";
    const conventionsContents = "# Workspace Conventions\n\nPrefer explicit types.\n";

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContents);
      await writeFile(path.join(workspaceDir, "CONVENTIONS.md"), conventionsContents);

      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/agent-step"),
        inputs: { prompt: "review this" },
        caller: passiveCaller,
        env: {
          ...process.env,
          RUNX_CWD: workspaceDir,
          INIT_CWD: workspaceDir,
        },
        receiptDir,
        runxHome,
      });

      expect(result.status).toBe("needs_resolution");
      if (result.status !== "needs_resolution") {
        return;
      }

      const envelope =
        result.requests[0]?.kind === "cognitive_work"
          ? result.requests[0].work.envelope
          : undefined;

      expect(envelope?.project_memory).toEqual({
        root_path: workspaceDir,
        path: path.join(workspaceDir, "MEMORY.md"),
        sha256: envelope?.project_memory?.sha256,
        content: memoryContents,
      });
      expect(envelope?.project_memory?.sha256).toHaveLength(64);
      expect(envelope?.project_conventions).toEqual({
        root_path: workspaceDir,
        path: path.join(workspaceDir, "CONVENTIONS.md"),
        sha256: envelope?.project_conventions?.sha256,
        content: conventionsContents,
      });
      expect(envelope?.project_conventions?.sha256).toHaveLength(64);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pins one MEMORY.md and CONVENTIONS.md snapshot across the chain and its step receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-project-rules-chain-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    const conventionsPath = path.join(workspaceDir, "CONVENTIONS.md");
    const originalMemory = "# Project Memory\n\nDo not widen scope mid-run.\n";
    const originalConventions = "# Project Conventions\n\nKeep patches crisp.\n";
    const mutatedMemory = "# Project Memory\n\nThis changed during the run.\n";
    const mutatedConventions = "# Project Conventions\n\nThis also changed mid-run.\n";
    let seenEnvelope:
      | {
          readonly project_memory?: {
            readonly root_path: string;
            readonly path: string;
            readonly sha256: string;
            readonly content: string;
          };
          readonly project_conventions?: {
            readonly root_path: string;
            readonly path: string;
            readonly sha256: string;
            readonly content: string;
          };
        }
      | undefined;

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(memoryPath, originalMemory);
      await writeFile(conventionsPath, originalConventions);

      const chain = validateChain(
        parseChainYaml(`
name: project-rules-snapshot
steps:
  - id: mutate
    run:
      type: cli-tool
      command: node
      args:
        - -e
        - ${JSON.stringify(
          `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(memoryPath)}, ${JSON.stringify(mutatedMemory)}); fs.writeFileSync(${JSON.stringify(conventionsPath)}, ${JSON.stringify(mutatedConventions)}); process.stdout.write("mutated");`,
        )}
  - id: inspect
    run:
      type: agent-step
      agent: codex
      task: inspect-project-rules
    context:
      prior: mutate.stdout
`),
      );

      const caller: Caller = {
        resolve: async (request) => {
          if (request.kind !== "cognitive_work") {
            return undefined;
          }
          seenEnvelope = {
            project_memory: request.work.envelope.project_memory,
            project_conventions: request.work.envelope.project_conventions,
          };
          return {
            actor: "agent",
            payload: {
              status: "ok",
              prior: request.work.envelope.inputs.prior,
            },
          };
        },
        report: () => undefined,
      };

      const result = await runLocalChain({
        chain,
        chainDirectory: workspaceDir,
        caller,
        env: {
          ...process.env,
          RUNX_CWD: workspaceDir,
          INIT_CWD: workspaceDir,
        },
        receiptDir,
        runxHome,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(await readFile(memoryPath, "utf8")).toBe(mutatedMemory);
      expect(await readFile(conventionsPath, "utf8")).toBe(mutatedConventions);
      expect(seenEnvelope?.project_memory).toMatchObject({
        root_path: workspaceDir,
        path: memoryPath,
        content: originalMemory,
      });
      expect(seenEnvelope?.project_conventions).toMatchObject({
        root_path: workspaceDir,
        path: conventionsPath,
        content: originalConventions,
      });
      expect(result.receipt.metadata).toMatchObject({
        project_memory: {
          root_path: workspaceDir,
          path: memoryPath,
          sha256: seenEnvelope?.project_memory?.sha256,
        },
        project_conventions: {
          root_path: workspaceDir,
          path: conventionsPath,
          sha256: seenEnvelope?.project_conventions?.sha256,
        },
      });

      const firstStepReceipt = JSON.parse(
        await readFile(path.join(receiptDir, `${result.steps[0]?.receiptId}.json`), "utf8"),
      ) as { metadata?: Record<string, unknown> };
      const secondStepReceipt = JSON.parse(
        await readFile(path.join(receiptDir, `${result.steps[1]?.receiptId}.json`), "utf8"),
      ) as { metadata?: Record<string, unknown> };
      const chainReceiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");

      expect(firstStepReceipt.metadata).toMatchObject({
        project_memory: { sha256: seenEnvelope?.project_memory?.sha256 },
        project_conventions: { sha256: seenEnvelope?.project_conventions?.sha256 },
      });
      expect(secondStepReceipt.metadata).toMatchObject({
        project_memory: { sha256: seenEnvelope?.project_memory?.sha256 },
        project_conventions: { sha256: seenEnvelope?.project_conventions?.sha256 },
      });
      expect(chainReceiptContents).not.toContain(originalMemory);
      expect(chainReceiptContents).not.toContain(originalConventions);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

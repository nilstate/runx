import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { runLocalSkill, type Caller } from "@runxhq/core/runner-local";

function caller(approved = false): Caller {
  return {
    resolve: async (request) => request.kind === "approval" ? { actor: "human", payload: approved } : undefined,
    report: () => undefined,
  };
}

describe("cli-tool sandbox profiles", () => {
  it("denies readonly declared workspace writes before command execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sandbox-readonly-"));
    const outputPath = path.join(tempDir, "should-not-exist.txt");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/sandbox-readonly"),
        inputs: { output_path: outputPath },
        caller: caller(),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: createDefaultSkillAdapters(),
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.reasons).toEqual(["readonly sandbox cannot declare writable paths"]);
      await expect(readFile(outputPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("permits workspace-write declarations and records actual local enforcement limits", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sandbox-write-"));
    const outputPath = path.join(tempDir, "out.txt");
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/sandbox-workspace-write"),
        inputs: { output_path: outputPath },
        caller: caller(),
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: { ...process.env, RUNX_CWD: tempDir },
        adapters: createDefaultSkillAdapters(),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      await expect(readFile(outputPath, "utf8")).resolves.toBe("sandbox-ok");
      const receiptContents = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(receiptContents).toContain('"profile": "workspace-write"');
      expect(receiptContents).toContain('"enforcement": "cwd-boundary-and-writable-path-admission"');
      expect(receiptContents).toContain('"mode": "allowlist"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires explicit approval for unrestricted local development profile", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sandbox-unrestricted-"));
    const skillPath = path.join(tempDir, "sandbox-unrestricted");
    const receiptDir = path.join(tempDir, "receipts");

    try {
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(skillPath, "SKILL.md"),
        `---
name: sandbox-unrestricted
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write('approved')"
  sandbox:
    profile: unrestricted-local-dev
---
Unrestricted fixture.
`,
      );

      const denied = await runLocalSkill({
        skillPath,
        caller: caller(false),
        receiptDir,
        runxHome: path.join(tempDir, "home-denied"),
        env: process.env,
        adapters: createDefaultSkillAdapters(),
      });
      expect(denied.status).toBe("policy_denied");

      const approved = await runLocalSkill({
        skillPath,
        caller: caller(true),
        receiptDir,
        runxHome: path.join(tempDir, "home-approved"),
        env: process.env,
        adapters: createDefaultSkillAdapters(),
      });
      expect(approved.status).toBe("success");
      if (approved.status !== "success") {
        return;
      }
      expect(approved.execution.stdout).toBe("approved");
      const receiptContents = await readFile(path.join(receiptDir, `${approved.receipt.id}.json`), "utf8");
      expect(receiptContents).toContain('"profile": "unrestricted-local-dev"');
      expect(receiptContents).toContain('"approved": true');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

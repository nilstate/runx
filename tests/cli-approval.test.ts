import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../packages/cli/src/index.js";

describe("CLI approval flow", () => {
  it("prompts interactively and approves an unrestricted sandbox gate", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-approval-approve-"));

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir, "cli-approval-approve");
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      const exitCode = await runCli(
        ["skill", skillPath, "--receipt-dir", path.join(tempDir, "receipts")],
        createIo("yes\n", stdout, stderr),
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).toBe(0);
      expect(stdout.contents()).toContain("approval needed");
      expect(stdout.contents()).toContain("gate    sandbox.cli-approval-approve.unrestricted-local-dev");
      expect(stdout.contents()).toContain("approved");
      expect(stderr.contents()).toBe("");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults interactive approval to deny", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-approval-deny-"));

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir, "cli-approval-deny");
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      const exitCode = await runCli(
        ["skill", skillPath, "--receipt-dir", path.join(tempDir, "receipts")],
        createIo("\n", stdout, stderr),
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).toBe(1);
      expect(stdout.contents()).toContain("approval needed");
      expect(stdout.contents()).toContain("Approve? [y/N]");
      expect(stderr.contents()).toContain("policy denied");
      expect(stderr.contents()).toContain("unrestricted-local-dev sandbox requires explicit caller approval");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured approval_required in non-interactive JSON mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-approval-json-"));

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir, "cli-approval-json");
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      const exitCode = await runCli(
        ["skill", skillPath, "--non-interactive", "--json", "--receipt-dir", path.join(tempDir, "receipts")],
        createIo("", stdout, stderr),
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).toBe(2);
      expect(stderr.contents()).toBe("");
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "approval_required",
        skill: "cli-approval-json",
        approval: {
          gate_id: "sandbox.cli-approval-json.unrestricted-local-dev",
          gate_type: "sandbox",
          decision: "denied",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts structured approval answers in non-interactive mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-approval-answers-"));

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir, "cli-approval-answers");
      const answersPath = path.join(tempDir, "answers.json");
      await writeFile(
        answersPath,
        JSON.stringify({
          approvals: {
            "sandbox.cli-approval-answers.unrestricted-local-dev": true,
          },
        }),
      );
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      const exitCode = await runCli(
        [
          "skill",
          skillPath,
          "--non-interactive",
          "--json",
          "--answers",
          answersPath,
          "--receipt-dir",
          path.join(tempDir, "receipts"),
        ],
        createIo("", stdout, stderr),
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "success",
        execution: {
          stdout: "approved",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeUnrestrictedSkill(tempDir: string, name: string): Promise<string> {
  const skillPath = path.join(tempDir, name);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, "SKILL.md"),
    `---
name: ${name}
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
  return skillPath;
}

function createIo(input: string, stdout = createMemoryStream(), stderr = createMemoryStream()): CliIo {
  return {
    stdin: Readable.from([input]) as NodeJS.ReadStream,
    stdout,
    stderr,
  };
}

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

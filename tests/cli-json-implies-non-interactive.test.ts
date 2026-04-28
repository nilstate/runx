import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../packages/cli/src/index.js";

const SKILL_NAME = "cli-json-implies-non-interactive";

async function writeUnrestrictedSkill(tempDir: string): Promise<string> {
  const skillPath = path.join(tempDir, SKILL_NAME);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, "SKILL.md"),
    `---
name: ${SKILL_NAME}
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write('ok')"
  sandbox:
    profile: unrestricted-local-dev
---
Unrestricted fixture for the json-implies-non-interactive test.
`,
  );
  return skillPath;
}

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    contents(): string {
      return chunks.join("");
    },
    on() { return stream; },
    end() { return stream; },
  };
  return stream as unknown as NodeJS.WriteStream & { contents: () => string };
}

function createIo(input: string, stdout = createMemoryStream(), stderr = createMemoryStream()): CliIo {
  return {
    stdin: Readable.from([input]) as NodeJS.ReadStream,
    stdout,
    stderr,
  };
}

describe("--json implies --non-interactive", () => {
  it("does not write an interactive approval prompt when --json is set", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-json-implies-"));

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir);
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      // No stdin input. With the bug, the CLI would block waiting on
      // "Approve? [y/N]". With the fix, the non-interactive caller
      // routes the approval through structured handling (denial or
      // needs_resolution depending on the gate policy), and no
      // interactive prompt language is ever written to stdout.
      const exitCode = await runCli(
        ["skill", skillPath, "--receipt-dir", path.join(tempDir, "receipts"), "--json"],
        createIo("", stdout, stderr),
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      // Exit must NOT be 0 (no answer given, gate cannot have approved).
      // What matters: no interactive prompt; output is structured JSON.
      expect(exitCode).not.toBe(0);
      const out = stdout.contents();
      expect(out).not.toContain("Approve? [y/N]");
      expect(out).not.toContain("approval needed");
      // Output is parseable JSON.
      expect(() => JSON.parse(out)).not.toThrow();
      const parsed = JSON.parse(out) as { status: string };
      expect(typeof parsed.status).toBe("string");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("--json with explicit --non-interactive still works (idempotent)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-json-implies-explicit-"));

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir);
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      const exitCode = await runCli(
        ["skill", skillPath, "--receipt-dir", path.join(tempDir, "receipts"), "--json", "--non-interactive"],
        createIo("", stdout, stderr),
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).not.toBe(0);
      const out = stdout.contents();
      expect(out).not.toContain("Approve? [y/N]");
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

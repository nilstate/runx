import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async (request) =>
    request.kind === "cognitive_work"
      ? {
          actor: "agent",
          payload: { status: "agent", id: request.id },
        }
      : undefined,
  report: () => undefined,
};

describe("skill package resolution", () => {
  it("runs a folder package through its resolved workspace binding", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-package-folder-"));
    const skillDir = path.join(tempDir, "skills", "package-echo");
    const bindingDir = path.join(tempDir, "bindings", "runx", "package-echo");

    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(bindingDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: package-echo
description: Package echo.
---
Package echo.
`,
      );
      await writeFile(
        path.join(bindingDir, "X.yaml"),
        `skill: package-echo
runners:
  package-echo-cli:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
    inputs:
      message:
        type: string
        required: true
`,
      );

      const result = await runLocalSkill({
        skillPath: skillDir,
        inputs: { message: "from folder" },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toBe("from folder");
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.subject.source_type).toBe("cli-tool");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pairs a direct SKILL.md file with a resolved workspace binding", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-package-skillmd-"));
    const skillDir = path.join(tempDir, "skills", "package-echo");
    const bindingDir = path.join(tempDir, "bindings", "runx", "package-echo");

    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(bindingDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: package-echo
description: Package echo.
---
Package echo.
`,
      );
      await writeFile(
        path.join(bindingDir, "X.yaml"),
        `skill: package-echo
runners:
  package-echo-cli:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
    inputs:
      message:
        type: string
        required: true
`,
      );

      const result = await runLocalSkill({
        skillPath: path.join(skillDir, "SKILL.md"),
        inputs: { message: "from skill md" },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toBe("from skill md");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects flat markdown skill references even when an adjacent binding artifact exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-package-flat-"));
    const skillPath = path.join(tempDir, "flat-echo.md");

    try {
      await writeFile(
        skillPath,
        `---
name: flat-echo
description: Flat echo.
---
Flat echo.
`,
      );
      await writeFile(
        path.join(tempDir, "flat-echo.X.yaml"),
        `skill: flat-echo
runners:
  flat-echo-cli:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
    inputs:
      message:
        type: string
        required: true
`,
      );

      await expect(
        runLocalSkill({
          skillPath,
          inputs: { message: "from flat" },
          caller,
          receiptDir: path.join(tempDir, "receipts"),
          runxHome: path.join(tempDir, "home"),
          env: process.env,
        }),
      ).rejects.toThrow("Flat markdown files are not supported");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs portable folder packages through the agent runner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-package-agent-"));
    const skillDir = path.join(tempDir, "skills", "standard-folder");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: standard-folder
description: Standard folder skill.
---
Standard folder.
`,
      );

      const result = await runLocalSkill({
        skillPath: skillDir,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.subject.source_type).toBe("agent");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

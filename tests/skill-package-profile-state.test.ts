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

describe("skill package profile state", () => {
  it("runs a folder package through hidden .runx profile state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-package-colocated-"));
    const skillDir = path.join(tempDir, "skills", "package-echo");

    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(path.join(skillDir, ".runx"), { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: package-echo
description: Package echo.
---
Package echo.
`,
      );
      const profileDocument = `skill: package-echo
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
`;
      await writeFile(
        path.join(skillDir, ".runx", "profile.json"),
        `${JSON.stringify(
          {
            schema_version: "runx.skill-profile.v1",
            skill: {
              name: "package-echo",
              path: "SKILL.md",
              digest: "fixture-skill-digest",
            },
            profile: {
              document: profileDocument,
              digest: "fixture-profile-digest",
              runner_names: ["package-echo-cli"],
            },
            origin: {
              source: "fixture",
            },
          },
          null,
          2,
        )}\n`,
      );

      const result = await runLocalSkill({
        skillPath: skillDir,
        inputs: { message: "from colocated" },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toBe("from colocated");
      expect(result.receipt.kind).toBe("skill_execution");
      if (result.receipt.kind !== "skill_execution") {
        return;
      }
      expect(result.receipt.subject.source_type).toBe("cli-tool");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

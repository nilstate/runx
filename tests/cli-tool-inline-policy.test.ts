import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseGraphYaml, validateGraph } from "@runxhq/core/parser";
import { runLocalGraph, runLocalSkill, type Caller } from "@runxhq/core/runner-local";

const passiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("strict inline cli-tool workspace policy", () => {
  it("denies inline cli-tool skills when the workspace policy is enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-inline-skill-policy-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "inline-skill");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeWorkspacePolicy(workspaceDir);
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: inline-skill
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write('blocked')"
---
Inline cli-tool fixture.
`,
      );

      const result = await runLocalSkill({
        skillPath: skillDir,
        caller: passiveCaller,
        env: workspaceEnv(workspaceDir),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.reasons).toEqual([
        "cli-tool source 'node' uses inline code via '-e', which is rejected by strict workspace policy; move the program into a checked-in script and invoke that file instead",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("denies inline cli-tool graph steps under the same workspace policy", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-inline-graph-policy-"));
    const workspaceDir = path.join(tempDir, "workspace");

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeWorkspacePolicy(workspaceDir);

      const graph = validateGraph(
        parseGraphYaml(`
name: inline-policy-graph
steps:
  - id: inline
    run:
      type: cli-tool
      command: node
      args:
        - -e
        - "process.stdout.write('blocked')"
`),
      );

      const result = await runLocalGraph({
        graph,
        graphDirectory: workspaceDir,
        caller: passiveCaller,
        env: workspaceEnv(workspaceDir),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.stepId).toBe("inline");
      expect(result.reasons).toContain(
        "cli-tool source 'node' uses inline code via '-e', which is rejected by strict workspace policy; move the program into a checked-in script and invoke that file instead",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps built-in tool steps runnable after the bundled catalog is materialized to scripts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-inline-tool-policy-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeWorkspacePolicy(workspaceDir);
      await writeFile(path.join(workspaceDir, "note.txt"), "strict-mode-ok\n");

      const graph = validateGraph(
        parseGraphYaml(`
name: strict-tool-graph
steps:
  - id: read-note
    tool: fs.read
    inputs:
      path: note.txt
      repo_root: ${JSON.stringify(workspaceDir)}
`),
      );

      const result = await runLocalGraph({
        graph,
        graphDirectory: workspaceDir,
        caller: passiveCaller,
        env: workspaceEnv(workspaceDir),
        receiptDir,
        runxHome,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]?.stdout).toContain("strict-mode-ok");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeWorkspacePolicy(workspaceDir: string): Promise<void> {
  await mkdir(path.join(workspaceDir, ".runx"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, ".runx", "config.json"),
    `${JSON.stringify({ policy: { strict_cli_tool_inline_code: true } }, null, 2)}\n`,
  );
}

function workspaceEnv(workspaceDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNX_CWD: workspaceDir,
    INIT_CWD: workspaceDir,
  };
}

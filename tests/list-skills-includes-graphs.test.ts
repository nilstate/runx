import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { handleListCommand } from "../packages/cli/src/commands/list.js";

const SINGLE_RUNNER_PROFILE = `skill: single-runner-skill
runners:
  default:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write('hello')"
`;

const GRAPH_PROFILE = `skill: graph-skill
runners:
  default:
    default: true
    type: graph
    graph:
      name: graph-skill
      steps:
        - id: only-step
          label: only step
          run:
            type: agent-step
            agent: builder
            task: graph-skill-only-step
            outputs:
              result: string
`;

const writeSkill = async (root: string, name: string, profile: string) => {
  const skillDir = path.join(root, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "X.yaml"), profile);
};

describe("runx list skills surfaces invokable graphs", () => {
  it("listKind=skills returns both single-runner skills and graph skills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-list-skills-"));
    try {
      await writeSkill(tempDir, "single-runner-skill", SINGLE_RUNNER_PROFILE);
      await writeSkill(tempDir, "graph-skill", GRAPH_PROFILE);

      const result = await handleListCommand({ listKind: "skills" }, { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir });
      const names = result.items.map((item) => `${item.kind}:${item.name}`).sort();
      expect(names).toContain("skill:single-runner-skill");
      expect(names).toContain("graph:graph-skill");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("listKind=graphs returns only graph skills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-list-graphs-"));
    try {
      await writeSkill(tempDir, "single-runner-skill", SINGLE_RUNNER_PROFILE);
      await writeSkill(tempDir, "graph-skill", GRAPH_PROFILE);

      const result = await handleListCommand({ listKind: "graphs" }, { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir });
      const names = result.items.map((item) => `${item.kind}:${item.name}`);
      expect(names).toContain("graph:graph-skill");
      expect(names).not.toContain("skill:single-runner-skill");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

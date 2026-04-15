import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRunnableSkillReference, resolveSkillReference } from "../packages/cli/src/index.js";

describe("official skill resolution", () => {
  it("prefers project-local .runx skill packages over official shorthand fallback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-official-resolution-"));
    const projectDir = path.join(tempDir, "project");
    const localSkillDir = path.join(projectDir, ".runx", "skills", "sourcey");
    const env = { ...process.env, RUNX_CWD: projectDir, RUNX_HOME: path.join(tempDir, "home") };

    try {
      await mkdir(localSkillDir, { recursive: true });
      await writeFile(path.join(localSkillDir, "SKILL.md"), "---\nname: sourcey\ndescription: local override\nsource:\n  type: prompt\ninstructions: []\n---\n", "utf8");

      expect(resolveSkillReference("sourcey", env)).toBe(localSkillDir);
      await expect(resolveRunnableSkillReference("sourcey", env)).resolves.toBe(localSkillDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps unknown bare names failing with search guidance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-official-missing-"));

    try {
      const env = { ...process.env, RUNX_CWD: tempDir, RUNX_HOME: path.join(tempDir, "home") };
      await expect(resolveRunnableSkillReference("definitely-not-a-real-skill", env)).rejects.toThrow(
        "Try `runx search definitely-not-a-real-skill`",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

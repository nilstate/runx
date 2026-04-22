import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createFileRegistryStore } from "../packages/registry/src/index.js";
import { materializeRegistrySkill } from "../packages/runner-local/src/registry-resolver.js";
import { parseSkillMarkdown, validateSkill } from "../packages/parser/src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_REGISTRY_ROOT = path.resolve(HERE, "..", "..", "cloud", ".data", "runx-registry");
const REGISTRY_AVAILABLE = existsSync(path.join(REAL_REGISTRY_ROOT, "runx", "scafld"));

// Skipped automatically when the local seeded registry isn't on disk
// (CI nodes, fresh clones without the cloud .data layout, etc.).
const runIfSeeded = REGISTRY_AVAILABLE ? describe : describe.skip;

runIfSeeded("chain registry refs — real seeded registry", () => {
  it("lists seeded runx skills that the homepage catalog expects", async () => {
    const store = createFileRegistryStore(REAL_REGISTRY_ROOT);
    const skills = await store.listSkills();
    const skillIds = skills.map((skill) => skill.skill_id);

    // Homepage buildFeaturedGroups expects at least these
    expect(skillIds).toEqual(expect.arrayContaining([
      "runx/evolve",
      "runx/issue-to-pr",
      "runx/release",
      "runx/skill-lab",
      "runx/work-plan",
      "runx/design-skill",
      "runx/scafld",
      "runx/prior-art",
      "runx/skill-testing",
    ]));
  });

  it("materializes a real seeded skill to disk, parseable as a valid skill", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "runx-real-registry-cache-"));
    try {
      const store = createFileRegistryStore(REAL_REGISTRY_ROOT);
      const materialized = await materializeRegistrySkill({
        ref: "runx/scafld",
        store,
        cacheDir,
      });

      expect(materialized.skillDirectory).toMatch(/runx\/scafld/);
      expect(existsSync(materialized.skillPath)).toBe(true);

      const markdown = await readFile(materialized.skillPath, "utf8");
      expect(markdown).toBe(materialized.resolution.markdown);

      // The materialized SKILL.md has to round-trip through the real parser/validator
      // or the whole pipeline (chain → loadValidatedSkill → executeSkill) would fail.
      const raw = parseSkillMarkdown(markdown);
      const validated = validateSkill(raw, { mode: "strict" });
      expect(validated.name).toBe("scafld");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("is idempotent: second materialization of the same digest is a cache hit", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "runx-real-registry-cache-idem-"));
    try {
      const store = createFileRegistryStore(REAL_REGISTRY_ROOT);

      const first = await materializeRegistrySkill({ ref: "runx/scafld", store, cacheDir });
      const firstMtime = await fileMtime(first.skillPath);

      const second = await materializeRegistrySkill({ ref: "runx/scafld", store, cacheDir });
      const secondMtime = await fileMtime(second.skillPath);

      expect(second.skillDirectory).toBe(first.skillDirectory);
      expect(secondMtime).toBe(firstMtime);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("surfaces a clear error for a ref that is not in the real registry", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "runx-real-registry-missing-"));
    try {
      const store = createFileRegistryStore(REAL_REGISTRY_ROOT);
      await expect(
        materializeRegistrySkill({
          ref: "runx/definitely-not-a-real-skill",
          store,
          cacheDir,
        }),
      ).rejects.toThrow(/not found in registry/);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

async function fileMtime(filePath: string): Promise<number> {
  return (await stat(filePath)).mtimeMs;
}

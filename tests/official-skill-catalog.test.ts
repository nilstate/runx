import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "../packages/harness/src/index.js";
import { parseSkillMarkdown, parseRunnerManifestYaml, validateRunnerManifest, validateSkill } from "../packages/parser/src/index.js";

const officialSkillPackages = [
  "content-pipeline",
  "draft-content",
  "ecosystem-vuln-scan",
  "evolve",
  "request-triage",
  "issue-triage",
  "issue-to-pr",
  "ecosystem-brief",
  "moltbook",
  "work-plan",
  "design-skill",
  "prior-art",
  "write-harness",
  "review-receipt",
  "review-skill",
  "improve-skill",
  "reflect-digest",
  "release",
  "skill-lab",
  "research",
  "scafld",
  "skill-testing",
  "sourcey",
  "vuln-scan",
] as const;

const harnessedShowcasePackages = [
  "content-pipeline",
  "draft-content",
  "ecosystem-vuln-scan",
  "evolve",
  "request-triage",
  "issue-triage",
  "ecosystem-brief",
  "moltbook",
  "work-plan",
  "design-skill",
  "prior-art",
  "write-harness",
  "review-receipt",
  "review-skill",
  "improve-skill",
  "reflect-digest",
  "release",
  "skill-lab",
  "research",
  "scafld",
  "skill-testing",
  "sourcey",
  "vuln-scan",
] as const;

describe("official skill catalog", () => {
  it("ships official skills as portable packages plus checked-in execution profiles", async () => {
    for (const skillName of officialSkillPackages) {
      const skillDir = path.resolve("skills", skillName);
      const skillMarkdownPath = path.join(skillDir, "SKILL.md");
      const manifestPath = path.join(skillDir, "X.yaml");

      expect(existsSync(skillDir)).toBe(true);
      expect(existsSync(skillMarkdownPath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);

      const skill = validateSkill(parseSkillMarkdown(await readFile(skillMarkdownPath, "utf8")));
      const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(manifestPath, "utf8")));

      expect(skill.name).toBe(skillName);
      expect(manifest.catalog).toBeDefined();
      expect(Object.keys(manifest.runners).length).toBeGreaterThan(0);
    }
  });

  it("keeps evaluator-facing packages runnable through inline harness suites", async () => {
    for (const skillName of harnessedShowcasePackages) {
      const result = await runHarnessTarget(path.resolve("skills", skillName));

      expect(result.source).toBe("inline");
      if (!("cases" in result)) {
        throw new Error(`expected inline harness suite for ${skillName}`);
      }
      expect(result.assertionErrors).toEqual([]);
      expect(result.cases.length).toBeGreaterThan(0);
    }
  }, 60_000);
});

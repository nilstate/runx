import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "../packages/harness/src/index.js";
import { parseSkillMarkdown, parseRunnerManifestYaml, validateRunnerManifest, validateSkill } from "../packages/parser/src/index.js";

const officialSkillPackages = [
  "bug-to-pr",
  "content-pipeline",
  "draft-content",
  "ecosystem-vuln-scan",
  "evaluate-skill",
  "evolve",
  "github-triage",
  "harness-author",
  "improve-skill",
  "issue-to-pr",
  "market-intelligence",
  "moltbook",
  "moltbook-presence",
  "objective-decompose",
  "objective-to-skill",
  "open-source-triage",
  "receipt-review",
  "research",
  "scafld",
  "skill-research",
  "skill-testing",
  "sourcey",
  "support-triage",
  "vuln-scan",
] as const;

const harnessedShowcasePackages = [
  "content-pipeline",
  "draft-content",
  "ecosystem-vuln-scan",
  "evaluate-skill",
  "evolve",
  "github-triage",
  "harness-author",
  "improve-skill",
  "market-intelligence",
  "moltbook",
  "moltbook-presence",
  "objective-decompose",
  "objective-to-skill",
  "open-source-triage",
  "receipt-review",
  "research",
  "scafld",
  "skill-research",
  "skill-testing",
  "sourcey",
  "support-triage",
  "vuln-scan",
] as const;

describe("official skill catalog", () => {
  it("ships official skills exclusively as package directories with SKILL.md and x.yaml", async () => {
    for (const skillName of officialSkillPackages) {
      const skillDir = path.resolve("skills", skillName);
      const skillMarkdownPath = path.join(skillDir, "SKILL.md");
      const manifestPath = path.join(skillDir, "x.yaml");

      expect(existsSync(skillDir)).toBe(true);
      expect(existsSync(skillMarkdownPath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);

      const skill = validateSkill(parseSkillMarkdown(await readFile(skillMarkdownPath, "utf8")));
      const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(manifestPath, "utf8")));

      expect(skill.name).toBe(skillName);
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

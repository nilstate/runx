import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateArtifactQuality } from "@runxhq/core/harness";
import { parseSkillMarkdown, validateSkill } from "@runxhq/core/parser";

interface BadArtifactFixture {
  readonly skill: string;
  readonly artifact: unknown;
  readonly expected_codes: readonly string[];
}

describe("quality evaluator", () => {
  it("passes a grounded artifact against the declared profile", async () => {
    const profile = await loadQualityProfile("skill-lab");
    const evaluation = evaluateArtifactQuality({
      qualityProfile: profile,
      artifact: {
        title: "decision-brief",
        thesis: "Maintainers need a decision brief that turns issue memory and prior-art evidence into a bounded recommendation.",
        evidence: [
          "The current catalog already has prior-art, research, draft-content, and issue-triage surfaces.",
          "The skill-lab profile requires a crisp thesis, maintainer pain, boundaries, harness fixtures, and acceptance checks.",
        ],
        boundaries: ["Do not publish without approval.", "Stop when evidence is too thin."],
      },
    });

    expect(evaluation.status).toBe("pass");
    expect(evaluation.findings).toEqual([]);
  });

  it("rejects golden bad artifacts across core content skills", async () => {
    const fixtures = JSON.parse(
      await readFile(path.resolve("fixtures/quality/bad-artifacts.json"), "utf8"),
    ) as readonly BadArtifactFixture[];

    for (const fixture of fixtures) {
      const profile = await loadQualityProfile(fixture.skill);
      const evaluation = evaluateArtifactQuality({
        qualityProfile: profile,
        artifact: fixture.artifact,
      });
      const codes = evaluation.findings.map((finding) => finding.code);

      expect(evaluation.status, fixture.skill).toBe("fail");
      for (const expectedCode of fixture.expected_codes) {
        expect(codes, fixture.skill).toContain(expectedCode);
      }
    }
  });
});

async function loadQualityProfile(skill: string): Promise<string> {
  const markdown = await readFile(path.resolve("skills", skill, "SKILL.md"), "utf8");
  const parsed = validateSkill(parseSkillMarkdown(markdown));
  if (!parsed.qualityProfile) {
    throw new Error(`${skill} is missing Quality Profile`);
  }
  return parsed.qualityProfile.content;
}

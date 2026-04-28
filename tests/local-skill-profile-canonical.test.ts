import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLocalSkillProfile } from "@runxhq/core/config";

const SKILL_MD = `---
name: leaf
description: leaf skill
---
content
`;

const X_YAML_CANONICAL = `skill: leaf
runners:
  default:
    default: true
    type: agent
`;

const X_YAML_STALE_PROFILE_JSON_DOCUMENT = `skill: leaf
runners:
  default:
    default: true
    type: agent
    inputs:
      stale_field:
        type: string
        default: "stale"
`;

describe("resolveLocalSkillProfile treats X.yaml as canonical when both exist", () => {
  it("returns X.yaml content when both X.yaml and profile.json are present", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-profile-canonical-"));
    try {
      await writeFile(path.join(tempDir, "SKILL.md"), SKILL_MD);
      await writeFile(path.join(tempDir, "X.yaml"), X_YAML_CANONICAL);
      await mkdir(path.join(tempDir, ".runx"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".runx", "profile.json"),
        JSON.stringify({
          schema_version: "runx.skill-profile.v1",
          skill: { name: "leaf", path: "SKILL.md", digest: "f".repeat(64) },
          profile: {
            document: X_YAML_STALE_PROFILE_JSON_DOCUMENT,
            digest: "e".repeat(64),
            runner_names: ["default"],
          },
        }),
      );

      const result = await resolveLocalSkillProfile(tempDir, "leaf");
      expect(result.source).toBe("skill-profile");
      expect(result.profileDocument).toBe(X_YAML_CANONICAL);
      expect(result.profileDocument).not.toContain("stale_field");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to profile.json when X.yaml is absent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-profile-fallback-"));
    try {
      await writeFile(path.join(tempDir, "SKILL.md"), SKILL_MD);
      await mkdir(path.join(tempDir, ".runx"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".runx", "profile.json"),
        JSON.stringify({
          schema_version: "runx.skill-profile.v1",
          skill: { name: "leaf", path: "SKILL.md", digest: "f".repeat(64) },
          profile: {
            document: X_YAML_CANONICAL,
            digest: "e".repeat(64),
            runner_names: ["default"],
          },
        }),
      );

      const result = await resolveLocalSkillProfile(tempDir, "leaf");
      expect(result.source).toBe("profile-state");
      expect(result.profileDocument).toBe(X_YAML_CANONICAL);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";

import { buildGitHubRegistrySkillVersion, resolveGitHubSource } from "./github-source.js";

const markdown = `---
name: sourcey
description: Portable authored skill.
source:
  type: agent
---

Portable authored skill.
`;

const profileDocument = `skill: sourcey
runners:
  default:
    default: true
    type: agent-step
    agent: operator
    task: sourcey
`;

describe("github registry source", () => {
  it("uses root X.yaml when present and derives an sha-prefixed version", () => {
    const resolved = resolveGitHubSource({
      owner: "Acme",
      repo: "sourcey",
      defaultBranch: "main",
      ref: "main",
      sha: "1234567890abcdef",
      markdown,
      profileDocument,
      event: "push",
    });

    expect(resolved.profileDocument).toBe(profileDocument);
    expect(resolved.profilePath).toBe("X.yaml");
    expect(resolved.version).toBe("sha-1234567890ab");
  });

  it("respects an explicit skillPath / profilePath for multi-skill repos", () => {
    const resolved = resolveGitHubSource({
      owner: "acme",
      repo: "skills",
      defaultBranch: "main",
      ref: "main",
      sha: "fedcba9876543210",
      markdown,
      profileDocument,
      skillPath: "skills/sourcey/SKILL.md",
      profilePath: "skills/sourcey/X.yaml",
      event: "push",
    });

    expect(resolved.profilePath).toBe("skills/sourcey/X.yaml");
  });

  it("normalizes semver tag releases into immutable versions with source metadata", () => {
    const record = buildGitHubRegistrySkillVersion({
      owner: "acme",
      repo: "sourcey",
      defaultBranch: "main",
      ref: "refs/tags/v1.2.3",
      sha: "abcdef0123456789",
      markdown,
      profileDocument,
      tag: "v1.2.3",
      event: "tag",
      publisherHandle: "@alice",
    });

    expect(record).toMatchObject({
      skill_id: "acme/sourcey",
      version: "1.2.3",
      source_metadata: {
        provider: "github",
        repo: "acme/sourcey",
        ref: "1.2.3",
        immutable: true,
        tag: "1.2.3",
        profile_path: "X.yaml",
        publisher_handle: "@alice",
      },
    });
  });
});

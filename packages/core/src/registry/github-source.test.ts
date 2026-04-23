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
  it("prefers the canonical root X.yaml when both profile locations exist", () => {
    const resolved = resolveGitHubSource({
      owner: "Acme",
      repo: "sourcey",
      defaultBranch: "main",
      ref: "main",
      sha: "1234567890abcdef",
      markdown,
      profileDocument,
      fallbackProfileDocument: "fallback should be ignored",
      event: "push",
    });

    expect(resolved.profileDocument).toBe(profileDocument);
    expect(resolved.profilePath).toBe("X.yaml");
    expect(resolved.version).toBe("sha-1234567890ab");
  });

  it("falls back to .runx/X.yaml only when root X.yaml is absent", () => {
    const resolved = resolveGitHubSource({
      owner: "acme",
      repo: "sourcey",
      defaultBranch: "main",
      ref: "main",
      sha: "fedcba9876543210",
      markdown,
      fallbackProfileDocument: profileDocument,
      event: "push",
    });

    expect(resolved.profileDocument).toBe(profileDocument);
    expect(resolved.profilePath).toBe(".runx/X.yaml");
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

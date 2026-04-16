import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileRegistryStore,
  createRegistrySkillVersion,
  buildRegistrySkillVersion,
  deriveTrustSignals,
  ingestSkillMarkdown,
  resolveRegistrySkill,
  resolveRunxLink,
  searchRegistry,
} from "./index.js";

describe("registry package", () => {
  it("ingests skill markdown and derives registry metadata without executing the skill", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-package-"));

    try {
      const store = createFileRegistryStore(tempDir);
      const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");
      const profileDocument = await readFile(path.resolve("bindings/runx/sourcey/X.yaml"), "utf8");
      const version = await ingestSkillMarkdown(store, markdown, {
        owner: "0state",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
        profileDocument,
      });

      expect(version).toMatchObject({
        skill_id: "0state/sourcey",
        name: "sourcey",
        source_type: "agent",
        version: "1.0.0",
        profile_document: profileDocument,
        runner_names: ["agent", "sourcey"],
      });
      expect(version.profile_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(version.markdown).toBe(markdown);

      const trustSignals = deriveTrustSignals(version);
      expect(trustSignals.map((signal) => signal.id)).toEqual([
        "digest",
        "source_type",
        "publisher",
        "scopes",
        "runtime",
        "runner_metadata",
      ]);
      expect(trustSignals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "runner_metadata", status: "verified" }),
        ]),
      );

      const searchResults = await searchRegistry(store, "sourcey");
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0]).toMatchObject({
        skill_id: "0state/sourcey",
        source: "runx-registry",
        source_label: "runx registry",
        source_type: "agent",
        trust_tier: "runx-derived",
        profile_mode: "profiled",
        runner_names: ["agent", "sourcey"],
        profile_digest: version.profile_digest,
      });

      await expect(resolveRunxLink(store, "0state/sourcey", "1.0.0")).resolves.toMatchObject({
        skill_id: "0state/sourcey",
        version: "1.0.0",
        digest: version.digest,
      });

      await expect(resolveRegistrySkill(store, "registry:sourcey")).resolves.toMatchObject({
        skill_id: "0state/sourcey",
        version: "1.0.0",
        digest: version.digest,
        markdown,
        profile_document: profileDocument,
        profile_digest: version.profile_digest,
        runner_names: ["agent", "sourcey"],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts registry tags from binding runner metadata without requiring runx frontmatter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-x-tags-"));

    try {
      const store = createFileRegistryStore(tempDir);
      const markdown = `---
name: upstream-tagged
description: Upstream portable skill.
---

Portable skill markdown without runx-specific frontmatter.
`;
      const profileDocument = `skill: upstream-tagged
runners:
  default:
    default: true
    type: agent-step
    agent: operator
    task: upstream-tagged
    runx:
      tags:
        - upstream-owned
        - operator
`;
      const version = await ingestSkillMarkdown(store, markdown, {
        owner: "nilstate",
        version: "upstream-abc123",
        profileDocument,
      });

      expect(version.tags).toEqual(["upstream-owned", "operator"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refreshes derived registry metadata for unchanged artifact digests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-derived-refresh-"));

    try {
      const store = createFileRegistryStore(tempDir);
      const markdown = `---
name: upstream-tagged
description: Upstream portable skill.
---

Portable skill markdown without runx-specific frontmatter.
`;
      const profileDocument = `skill: upstream-tagged
runners:
  default:
    default: true
    type: agent-step
    agent: operator
    task: upstream-tagged
    runx:
      tags:
        - upstream-owned
        - operator
`;
      const derived = buildRegistrySkillVersion(markdown, {
        owner: "nilstate",
        version: "upstream-abc123",
        createdAt: "2026-04-10T00:00:00.000Z",
        profileDocument,
      });
      const legacyRecord = {
        ...derived,
        tags: [],
        created_at: "2026-04-01T00:00:00.000Z",
      };
      await mkdir(path.join(tempDir, "nilstate", "upstream-tagged"), { recursive: true });
      await writeFile(
        path.join(tempDir, "nilstate", "upstream-tagged", "upstream-abc123.json"),
        `${JSON.stringify(legacyRecord, null, 2)}\n`,
      );

      const refreshed = await createRegistrySkillVersion(store, markdown, {
        owner: "nilstate",
        version: "upstream-abc123",
        createdAt: "2026-04-10T00:00:00.000Z",
        profileDocument,
      });

      expect(refreshed.created).toBe(false);
      expect(refreshed.record.tags).toEqual(["upstream-owned", "operator"]);
      expect(refreshed.record.created_at).toBe("2026-04-01T00:00:00.000Z");
      await expect(store.getVersion("nilstate/upstream-tagged", "upstream-abc123")).resolves.toMatchObject({
        tags: ["upstream-owned", "operator"],
        created_at: "2026-04-01T00:00:00.000Z",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps portable registry skills compatible without a execution profile", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-portable-"));

    try {
      const store = createFileRegistryStore(tempDir);
      const markdown = await readFile(path.resolve("fixtures/skills/portable/SKILL.md"), "utf8");
      const version = await ingestSkillMarkdown(store, markdown, {
        owner: "0state",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
      });

      expect(version).toMatchObject({
        skill_id: "0state/portable",
        source_type: "agent",
        runner_names: [],
      });
      expect(version.profile_document).toBeUndefined();
      expect(version.profile_digest).toBeUndefined();

      const searchResults = await searchRegistry(store, "portable");
      expect(searchResults).toEqual([
        expect.objectContaining({
          skill_id: "0state/portable",
          profile_mode: "portable",
          runner_names: [],
          profile_digest: undefined,
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

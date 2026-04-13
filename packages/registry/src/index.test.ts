import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileRegistryStore,
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
      const xManifest = await readFile(path.resolve("skills/sourcey/x.yaml"), "utf8");
      const version = await ingestSkillMarkdown(store, markdown, {
        owner: "0state",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
        xManifest,
      });

      expect(version).toMatchObject({
        skill_id: "0state/sourcey",
        name: "sourcey",
        source_type: "agent",
        version: "1.0.0",
        x_manifest: xManifest,
        runner_names: ["agent", "sourcey"],
      });
      expect(version.x_digest).toMatch(/^[a-f0-9]{64}$/);
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
        runner_mode: "x-manifest",
        runner_names: ["agent", "sourcey"],
        x_digest: version.x_digest,
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
        x_manifest: xManifest,
        x_digest: version.x_digest,
        runner_names: ["agent", "sourcey"],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps standard-only registry skills compatible without X metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-standard-only-"));

    try {
      const store = createFileRegistryStore(tempDir);
      const markdown = await readFile(path.resolve("fixtures/skills/standard-only/SKILL.md"), "utf8");
      const version = await ingestSkillMarkdown(store, markdown, {
        owner: "0state",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
      });

      expect(version).toMatchObject({
        skill_id: "0state/standard-only",
        source_type: "agent",
        runner_names: [],
      });
      expect(version.x_manifest).toBeUndefined();
      expect(version.x_digest).toBeUndefined();

      const searchResults = await searchRegistry(store, "standard-only");
      expect(searchResults).toEqual([
        expect.objectContaining({
          skill_id: "0state/standard-only",
          runner_mode: "standard-only",
          runner_names: [],
          x_digest: undefined,
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

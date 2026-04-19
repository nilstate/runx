import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFileRegistryStore, createLocalRegistryClient, publishSkillMarkdown } from "./index.js";

describe("publishSkillMarkdown", () => {
  it("publishes valid markdown and is idempotent for unchanged content", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-publish-"));
    const client = createLocalRegistryClient(createFileRegistryStore(tempDir));
    const markdown = await readFile(path.resolve("fixtures/skills/echo/SKILL.md"), "utf8");

    try {
      const first = await publishSkillMarkdown(client, markdown, {
        owner: "acme",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
        registryUrl: "https://runx.example.test",
      });
      const second = await publishSkillMarkdown(client, markdown, {
        owner: "acme",
        version: "1.0.0",
        registryUrl: "https://runx.example.test",
      });

      expect(first).toMatchObject({
        status: "published",
        skill_id: "acme/echo",
        version: "1.0.0",
        source_type: "cli-tool",
        registry_url: "https://runx.example.test",
      });
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(first.link.install_command).toBe("runx add acme/echo@1.0.0 --registry https://runx.example.test");
      expect(second).toMatchObject({
        status: "unchanged",
        skill_id: "acme/echo",
        version: "1.0.0",
        digest: first.digest,
        runner_names: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes the execution profile as a separate artifact", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-publish-x-"));
    const client = createLocalRegistryClient(createFileRegistryStore(tempDir));
    const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");
    const profileDocument = await readFile(path.resolve("skills/sourcey/X.yaml"), "utf8");

    try {
      const result = await publishSkillMarkdown(client, markdown, {
        owner: "acme",
        version: "1.0.0",
        profileDocument,
      });

      expect(result).toMatchObject({
        status: "published",
        skill_id: "acme/sourcey",
        runner_names: ["agent", "sourcey"],
        record: {
          markdown,
          profile_document: profileDocument,
          runner_names: ["agent", "sourcey"],
        },
      });
      expect(result.profile_digest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate version with different content", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-publish-conflict-"));
    const client = createLocalRegistryClient(createFileRegistryStore(tempDir));
    const markdown = await readFile(path.resolve("fixtures/skills/echo/SKILL.md"), "utf8");
    const changed = markdown.replace("Echo the provided message.", "Echo the changed message.");

    try {
      await publishSkillMarkdown(client, markdown, { owner: "acme", version: "1.0.0" });
      await expect(publishSkillMarkdown(client, changed, { owner: "acme", version: "1.0.0" })).rejects.toThrow(
        "already exists with a different digest",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

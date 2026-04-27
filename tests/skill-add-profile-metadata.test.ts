import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { createFixtureMarketplaceAdapter, type MarketplaceAdapter, type SkillSearchResult } from "@runxhq/core/marketplaces";
import { createFileRegistryStore, ingestSkillMarkdown } from "@runxhq/core/registry";
import { installLocalSkill, runLocalSkill, type Caller } from "@runxhq/runtime-local";

const caller: Caller = {
  resolve: async (request) =>
    request.kind === "cognitive_work"
      ? {
          actor: "agent",
          payload: { status: "agent", id: request.id },
        }
      : undefined,
  report: () => undefined,
};

describe("skill add execution profile", () => {
  it("installs registry execution profile and runs through the installed default runner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-x-registry-"));
    const registryDir = path.join(tempDir, "registry");
    const skillsDir = path.join(tempDir, "skills");
    const markdown = `---
name: package-echo
description: Portable echo package.
---

Echo a message.
`;
    const profileDocument = `skill: package-echo
runners:
  package-echo-cli:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
    inputs:
      message:
        type: string
        required: true
`;

    try {
      const version = await ingestSkillMarkdown(createFileRegistryStore(registryDir), markdown, {
        owner: "acme",
        version: "1.0.0",
        profileDocument,
      });

      const install = await installLocalSkill({
        ref: "acme/package-echo@1.0.0",
        registryStore: createFileRegistryStore(registryDir),
        destinationRoot: skillsDir,
      });

      expect(install).toMatchObject({
        destination: path.join(skillsDir, "acme", "package-echo", "SKILL.md"),
        profileStatePath: path.join(skillsDir, "acme", "package-echo", ".runx", "profile.json"),
        profileDigest: version.profile_digest,
        runnerNames: ["package-echo-cli"],
      });
      const installedProfileState = JSON.parse(
        await readFile(path.join(skillsDir, "acme", "package-echo", ".runx", "profile.json"), "utf8"),
      ) as { profile: { document: string } };
      expect(installedProfileState.profile.document).toBe(profileDocument);

      const run = await runLocalSkill({
        skillPath: path.join(skillsDir, "acme", "package-echo"),
        inputs: { message: "installed x ok" },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: createDefaultSkillAdapters(),
      });

      expect(run.status).toBe("success");
      if (run.status !== "success") {
        return;
      }
      expect(run.execution.stdout).toBe("installed x ok");
      expect(run.receipt.kind).toBe("skill_execution");
      if (run.receipt.kind !== "skill_execution") {
        return;
      }
      expect(run.receipt.source_type).toBe("cli-tool");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs marketplace execution profile when the upstream source provides it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-x-marketplace-"));

    try {
      const install = await installLocalSkill({
        ref: "fixture-marketplace:sourcey-docs",
        registryStore: createFileRegistryStore(path.join(tempDir, "registry")),
        marketplaceAdapters: [createFixtureMarketplaceAdapter()],
        destinationRoot: path.join(tempDir, "skills"),
      });

      expect(install).toMatchObject({
        destination: path.join(tempDir, "skills", "sourcey-docs", "SKILL.md"),
        profileStatePath: path.join(tempDir, "skills", "sourcey-docs", ".runx", "profile.json"),
        runnerNames: ["sourcey-docs-cli"],
        trust_tier: "community",
      });
      await expect(readFile(path.join(tempDir, "skills", "sourcey-docs", ".runx", "profile.json"), "utf8")).resolves.toContain(
        "sourcey-docs-cli",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps portable marketplace skills runnable through the agent runner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-x-standard-"));

    try {
      const install = await installLocalSkill({
        ref: "fixture-marketplace:marketplace-portable",
        registryStore: createFileRegistryStore(path.join(tempDir, "registry")),
        marketplaceAdapters: [createFixtureMarketplaceAdapter()],
        destinationRoot: path.join(tempDir, "skills"),
      });

      expect(install).toMatchObject({
        destination: path.join(tempDir, "skills", "marketplace-portable", "SKILL.md"),
        profileStatePath: undefined,
        runnerNames: [],
      });

      const run = await runLocalSkill({
        skillPath: path.join(tempDir, "skills", "marketplace-portable"),
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(run.status).toBe("success");
      if (run.status !== "success") {
        return;
      }
      expect(run.receipt.kind).toBe("skill_execution");
      if (run.receipt.kind !== "skill_execution") {
        return;
      }
      expect(run.receipt.source_type).toBe("agent");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects marketplace execution profile that does not match the installed skill", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-x-invalid-"));

    try {
      await expect(
        installLocalSkill({
          ref: "invalid-x:portable",
          registryStore: createFileRegistryStore(path.join(tempDir, "registry")),
          marketplaceAdapters: [createInvalidXMarketplaceAdapter()],
          destinationRoot: path.join(tempDir, "skills"),
        }),
      ).rejects.toThrow("does not match skill");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createInvalidXMarketplaceAdapter(): MarketplaceAdapter {
  const markdown = `---
name: portable
description: Portable skill.
---

Portable.
`;
  const profileDocument = `skill: other-skill
runners:
  portable-cli:
    type: cli-tool
    command: node
`;
  const result: SkillSearchResult = {
    skill_id: "invalid-x/portable",
    name: "portable",
    owner: "invalid-x",
    source: "invalid-x",
    source_label: "Invalid X Fixture",
    source_type: "agent",
    trust_tier: "community",
    required_scopes: [],
    tags: [],
    profile_mode: "profiled",
    runner_names: ["portable-cli"],
    add_command: "runx add invalid-x:portable",
    run_command: "runx portable",
  };
  return {
    source: "invalid-x",
    label: "Invalid X Fixture",
    search: async () => [result],
    resolve: async () => ({ markdown, profileDocument, result }),
  };
}

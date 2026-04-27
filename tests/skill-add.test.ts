import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import type { MarketplaceAdapter, SkillSearchResult } from "@runxhq/core/marketplaces";
import { createFileRegistryStore, ingestSkillMarkdown } from "@runxhq/core/registry";
import { installLocalSkill } from "@runxhq/runtime-local";

describe("skill-add", () => {
  it("installs a registry skill as pinned markdown with provenance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-registry-"));
    const registryDir = path.join(tempDir, "registry");
    const skillsDir = path.join(tempDir, "skills");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");

    try {
      const version = await ingestSkillMarkdown(createFileRegistryStore(registryDir), markdown, {
        owner: "acme",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
        profileDocument: await readFile(path.resolve("skills/sourcey/X.yaml"), "utf8"),
      });

      const exitCode = await runCli(
        ["skill", "add", "registry:sourcey", "--to", skillsDir, "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_REGISTRY_DIR: registryDir,
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = JSON.parse(stdout.contents()) as {
        install: {
          status: string;
          destination: string;
          source: string;
          source_label: string;
          version: string;
          digest: string;
          profileDigest: string;
          profileStatePath: string;
          runnerNames: string[];
        };
      };
      expect(report.install).toMatchObject({
        status: "installed",
        destination: path.join(skillsDir, "sourcey", "SKILL.md"),
        source: "runx-registry",
        source_label: "runx registry",
        version: "1.0.0",
        digest: version.digest,
        profileDigest: version.profile_digest,
        profileStatePath: path.join(skillsDir, "sourcey", ".runx", "profile.json"),
        runnerNames: ["agent", "sourcey"],
      });
      await expect(readFile(path.join(skillsDir, "sourcey", "SKILL.md"), "utf8")).resolves.toBe(markdown);
      await expect(readFile(path.join(skillsDir, "sourcey", ".runx", "profile.json"), "utf8")).resolves.toContain("tool: sourcey.build");
      await expect(readFile(path.join(skillsDir, "sourcey", ".runx/profile.json"), "utf8")).resolves.toContain(
        '"source": "runx-registry"',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs a fixture marketplace skill with external attribution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-fixture-"));
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        ["skill", "add", "fixture-marketplace:sourcey-docs", "--to", path.join(tempDir, "skills"), "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_REGISTRY_DIR: path.join(tempDir, "registry"),
          RUNX_ENABLE_FIXTURE_MARKETPLACE: "1",
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = JSON.parse(stdout.contents()) as {
        install: {
          destination: string;
          source: string;
          source_label: string;
          trust_tier: string;
          version: string;
          digest: string;
          profileDigest: string;
          profileStatePath: string;
          runnerNames: string[];
        };
      };
      expect(report.install).toMatchObject({
        destination: path.join(tempDir, "skills", "sourcey-docs", "SKILL.md"),
        source: "fixture-marketplace",
        source_label: "Fixture Marketplace",
        skill_id: "fixture/sourcey-docs",
        trust_tier: "community",
        version: "2026.04.10",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        profileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        profileStatePath: path.join(tempDir, "skills", "sourcey-docs", ".runx", "profile.json"),
        runnerNames: ["sourcey-docs-cli"],
      });
      await expect(readFile(path.join(tempDir, "skills", "sourcey-docs", "SKILL.md"), "utf8")).resolves.toContain(
        "name: sourcey-docs",
      );
      await expect(readFile(path.join(tempDir, "skills", "sourcey-docs", ".runx", "profile.json"), "utf8")).resolves.toContain(
        "sourcey-docs-cli",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs runx links into decoded namespace folder packages", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-link-"));
    const registryDir = path.join(tempDir, "registry");
    const skillsDir = path.join(tempDir, "skills");
    const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");

    try {
      await ingestSkillMarkdown(createFileRegistryStore(registryDir), markdown, {
        owner: "acme",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
        profileDocument: await readFile(path.resolve("skills/sourcey/X.yaml"), "utf8"),
      });

      const install = await installLocalSkill({
        ref: "runx://skill/acme%2Fsourcey@1.0.0",
        registryStore: createFileRegistryStore(registryDir),
        destinationRoot: skillsDir,
      });

      expect(install.destination).toBe(path.join(skillsDir, "acme", "sourcey", "SKILL.md"));
      expect(install.profileStatePath).toBe(path.join(skillsDir, "acme", "sourcey", ".runx", "profile.json"));
      expect(install.runnerNames).toEqual(["agent", "sourcey"]);
      await expect(readFile(path.join(skillsDir, "acme", "sourcey", "SKILL.md"), "utf8")).resolves.toBe(markdown);
      await expect(readFile(path.join(skillsDir, "acme", "sourcey", ".runx", "profile.json"), "utf8")).resolves.toContain("tool: sourcey.build");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails digest mismatch without writing a partial file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-digest-"));
    const registryDir = path.join(tempDir, "registry");
    const skillsDir = path.join(tempDir, "skills");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      await ingestSkillMarkdown(createFileRegistryStore(registryDir), await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"), {
        owner: "acme",
        version: "1.0.0",
      });

      const exitCode = await runCli(
        ["skill", "add", "acme/sourcey@1.0.0", "--to", skillsDir, "--digest", "sha256:0000", "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_REGISTRY_DIR: registryDir,
        },
      );

      expect(exitCode).toBe(1);
      expect(stderr.contents()).toContain("Digest mismatch");
      await expect(stat(path.join(skillsDir, "sourcey", "SKILL.md"))).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails invalid marketplace markdown without writing a partial file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-add-invalid-"));
    const adapter = createInvalidMarketplaceAdapter();

    try {
      await expect(
        installLocalSkill({
          ref: "invalid:sourcey",
          registryStore: createFileRegistryStore(path.join(tempDir, "registry")),
          marketplaceAdapters: [adapter],
          destinationRoot: path.join(tempDir, "skills"),
        }),
      ).rejects.toThrow("Skill markdown must start with YAML frontmatter");
      await expect(readdir(path.join(tempDir, "skills"))).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createInvalidMarketplaceAdapter(): MarketplaceAdapter {
  const result: SkillSearchResult = {
    skill_id: "invalid/sourcey",
    name: "sourcey",
    owner: "invalid",
    source: "invalid",
    source_label: "Invalid Fixture",
    source_type: "cli-tool",
    trust_tier: "community",
    required_scopes: [],
    tags: [],
    profile_mode: "portable",
    runner_names: [],
    add_command: "runx add invalid:sourcey",
    run_command: "runx sourcey",
  };

  return {
    source: "invalid",
    label: "Invalid Fixture",
    search: async () => [result],
    resolve: async () => ({
      markdown: "not a skill",
      result,
    }),
  };
}

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}

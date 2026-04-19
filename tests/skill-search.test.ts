import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { createFileRegistryStore, ingestSkillMarkdown } from "../packages/registry/src/index.js";

describe("skill-search CLI", () => {
  it("returns normalized runx registry results as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-search-"));
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      await ingestSkillMarkdown(createFileRegistryStore(registryDir), await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"), {
        owner: "acme",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
      });

      const exitCode = await runCli(
        ["skill", "search", "sourcey", "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_REGISTRY_DIR: registryDir,
          RUNX_REGISTRY_URL: "https://runx.example.test",
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = JSON.parse(stdout.contents()) as {
        status: string;
        query: string;
        results: {
          skill_id: string;
          source: string;
          source_label: string;
          trust_tier: string;
          add_command: string;
          profile_mode: string;
          runner_names: string[];
          profile_digest?: string;
        }[];
      };
      expect(report).toMatchObject({
        status: "success",
        query: "sourcey",
      });
      expect(report.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skill_id: "acme/sourcey",
            source: "runx-registry",
            source_label: "runx registry",
            trust_tier: "runx-derived",
            profile_mode: "portable",
            runner_names: [],
            add_command: "runx add acme/sourcey@1.0.0 --registry https://runx.example.test",
          }),
        ]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps fixture marketplace results externally attributed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-search-marketplace-"));
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        ["skill", "search", "sourcey", "--source", "fixture-marketplace", "--json"],
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
        results: {
          skill_id: string;
          source: string;
          source_label: string;
          trust_tier: string;
          profile_mode: string;
          runner_names: string[];
        }[];
      };
      expect(report.results).toEqual([
        expect.objectContaining({
          skill_id: "fixture/sourcey-docs",
          source: "fixture-marketplace",
          source_label: "Fixture Marketplace",
          trust_tier: "external-unverified",
          profile_mode: "profiled",
          runner_names: ["sourcey-docs-cli"],
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

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

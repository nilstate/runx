import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRunnableSkillReference } from "../packages/cli/src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("official skill fetch", () => {
  it("acquires, caches, and reruns an official skill offline from cache", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-official-fetch-"));
    const projectDir = path.join(tempDir, "project");
    const globalHomeDir = path.join(tempDir, "home");
    const env = {
      ...process.env,
      RUNX_CWD: projectDir,
      RUNX_HOME: globalHomeDir,
      RUNX_REGISTRY_URL: "https://runx.example.test",
    };
    const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");
    const xManifest = await readFile(path.resolve("skills/sourcey/x.yaml"), "utf8");

    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
        status: "success",
        install_count: 1,
        acquisition: {
          skill_id: "runx/sourcey",
          owner: "runx",
          name: "sourcey",
          version: "sha-19586564c28e",
          digest: "19586564c28e0cc5bc8affa207362ddc1e590a419a515196fe1653beece1ceea",
          markdown,
          x_manifest: xManifest,
          x_digest: "stub-x-digest",
          runner_names: ["agent", "sourcey"],
        },
      }), { status: 200 })) as typeof fetch;

      const firstPath = await resolveRunnableSkillReference("sourcey", env);
      expect(firstPath).toBe(path.join(globalHomeDir, "official-skills", "runx", "sourcey", "sha-19586564c28e"));
      expect((await stat(path.join(globalHomeDir, "install.json"))).isFile()).toBe(true);
      expect((await stat(path.join(firstPath, "SKILL.md"))).isFile()).toBe(true);

      globalThis.fetch = vi.fn(async () => {
        throw new Error("network should not be used");
      }) as typeof fetch;

      const secondPath = await resolveRunnableSkillReference("sourcey", env);
      expect(secondPath).toBe(firstPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an official acquisition with a digest mismatch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-official-fetch-digest-"));
    const env = {
      ...process.env,
      RUNX_CWD: path.join(tempDir, "project"),
      RUNX_HOME: path.join(tempDir, "home"),
      RUNX_REGISTRY_URL: "https://runx.example.test",
    };

    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
        status: "success",
        install_count: 1,
        acquisition: {
          skill_id: "runx/sourcey",
          owner: "runx",
          name: "sourcey",
          version: "sha-19586564c28e",
          digest: "19586564c28e0cc5bc8affa207362ddc1e590a419a515196fe1653beece1ceea",
          markdown: "---\nname: sourcey\ndescription: wrong\nsource:\n  type: prompt\ninstructions: []\n---\n",
          runner_names: [],
        },
      }), { status: 200 })) as typeof fetch;

      await expect(resolveRunnableSkillReference("sourcey", env)).rejects.toThrow("Official skill verification failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("copies packaged runtime helpers into the cached official skill directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-official-fetch-runtime-"));
    const env = {
      ...process.env,
      RUNX_CWD: path.join(tempDir, "project"),
      RUNX_HOME: path.join(tempDir, "home"),
      RUNX_REGISTRY_URL: "https://runx.example.test",
    };
    const markdown = await readFile(path.resolve("skills/scafld/SKILL.md"), "utf8");
    const xManifest = await readFile(path.resolve("skills/scafld/x.yaml"), "utf8");
    const officialLock = JSON.parse(
      await readFile(path.resolve("packages/cli/src/official-skills.lock.json"), "utf8"),
    ) as ReadonlyArray<{
      readonly skill_id: string;
      readonly version: string;
      readonly digest: string;
    }>;
    const lockEntry = officialLock.find((entry) => entry.skill_id === "runx/scafld");
    if (!lockEntry) {
      throw new Error("Missing runx/scafld entry in official-skills.lock.json.");
    }

    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
        status: "success",
        install_count: 1,
        acquisition: {
          skill_id: "runx/scafld",
          owner: "runx",
          name: "scafld",
          version: lockEntry.version,
          digest: lockEntry.digest,
          markdown,
          x_manifest: xManifest,
          runner_names: ["agent", "scafld-cli"],
        },
      }), { status: 200 })) as typeof fetch;

      const skillPath = await resolveRunnableSkillReference("scafld", env);
      expect((await stat(path.join(skillPath, "run.mjs"))).isFile()).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

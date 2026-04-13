import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { createFileRegistryStore } from "../packages/registry/src/index.js";

describe("skill-publish CLI", () => {
  it("publishes valid skill markdown to a local registry path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-"));
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        [
          "skill",
          "publish",
          "fixtures/skills/echo",
          "--owner",
          "0state",
          "--version",
          "1.0.0",
          "--registry",
          registryDir,
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = JSON.parse(stdout.contents()) as {
        publish: {
          status: string;
          skill_id: string;
          version: string;
          digest: string;
          registry_url: string;
          link: {
            install_command: string;
          };
        };
      };
      expect(report.publish).toMatchObject({
        status: "published",
        skill_id: "0state/echo",
        version: "1.0.0",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        registry_url: registryDir,
      });
      expect(report.publish.link.install_command).toBe(`runx add 0state/echo@1.0.0 --registry ${registryDir}`);
      await expect(createFileRegistryStore(registryDir).getVersion("0state/echo", "1.0.0")).resolves.toMatchObject({
        markdown: await readFile(path.resolve("fixtures/skills/echo/SKILL.md"), "utf8"),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes standard-only skill markdown with the agent runner as the portable fallback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-standard-"));
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        [
          "skill",
          "publish",
          "fixtures/skills/standard-only",
          "--owner",
          "0state",
          "--version",
          "1.0.0",
          "--registry",
          registryDir,
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      await expect(createFileRegistryStore(registryDir).getVersion("0state/standard-only", "1.0.0")).resolves.toMatchObject({
        source_type: "agent",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes folder package X metadata separately from portable SKILL.md", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-x-"));
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        [
          "skill",
          "publish",
          "skills/sourcey",
          "--owner",
          "0state",
          "--version",
          "1.0.0",
          "--registry",
          registryDir,
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = JSON.parse(stdout.contents()) as {
        publish: {
          runner_names: string[];
          x_digest: string;
        };
      };
      expect(report.publish.runner_names).toEqual(["agent", "sourcey"]);
      expect(report.publish.x_digest).toMatch(/^[a-f0-9]{64}$/);
      await expect(createFileRegistryStore(registryDir).getVersion("0state/sourcey", "1.0.0")).resolves.toMatchObject({
        markdown: await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"),
        x_manifest: await readFile(path.resolve("skills/sourcey/x.yaml"), "utf8"),
        runner_names: ["agent", "sourcey"],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid skill markdown before creating a registry version", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-invalid-"));
    const registryDir = path.join(tempDir, "registry");
    const invalidDir = path.join(tempDir, "invalid-skill");
    const invalidPath = path.join(invalidDir, "SKILL.md");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      await mkdir(invalidDir, { recursive: true });
      await writeFile(invalidPath, "not a skill\n");
      const exitCode = await runCli(
        ["skill", "publish", invalidDir, "--registry", registryDir, "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(1);
      expect(stderr.contents()).toContain("Skill markdown must start with YAML frontmatter");
      await expect(createFileRegistryStore(registryDir).listSkills()).resolves.toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("republishing unchanged content is idempotent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-idempotent-"));
    const registryDir = path.join(tempDir, "registry");

    try {
      const first = createMemoryStream();
      const second = createMemoryStream();
      const stderr = createMemoryStream();
      const args = [
        "skill",
        "publish",
        "fixtures/skills/echo",
        "--owner",
        "0state",
        "--version",
        "1.0.0",
        "--registry",
        registryDir,
        "--json",
      ];

      await expect(
        runCli(args, { stdin: process.stdin, stdout: first, stderr }, { ...process.env, RUNX_CWD: process.cwd() }),
      ).resolves.toBe(0);
      await expect(
        runCli(args, { stdin: process.stdin, stdout: second, stderr }, { ...process.env, RUNX_CWD: process.cwd() }),
      ).resolves.toBe(0);

      expect(JSON.parse(first.contents()).publish.status).toBe("published");
      expect(JSON.parse(second.contents()).publish.status).toBe("unchanged");
      const versions = await createFileRegistryStore(registryDir).listVersions("0state/echo");
      expect(versions).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not pretend to publish to a remote registry without a local-backed transport", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "publish", "fixtures/skills/echo", "--registry", "https://runx.example.test", "--json"],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_REGISTRY_DIR: undefined,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain("Remote registry transport is not implemented in CE");
    expect(stdout.contents()).toBe("");
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

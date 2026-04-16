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
        harness: {
          status: "not_declared",
          case_count: 0,
        },
      });
      expect(report.publish.link.install_command).toBe(`runx add 0state/echo@1.0.0 --registry ${registryDir}`);
      await expect(createFileRegistryStore(registryDir).getVersion("0state/echo", "1.0.0")).resolves.toMatchObject({
        markdown: await readFile(path.resolve("fixtures/skills/echo/SKILL.md"), "utf8"),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes portable skill markdown with the agent runner as the portable fallback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-standard-"));
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        [
          "skill",
          "publish",
          "fixtures/skills/portable",
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
      await expect(createFileRegistryStore(registryDir).getVersion("0state/portable", "1.0.0")).resolves.toMatchObject({
        source_type: "agent",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes folder package execution profile separately from portable SKILL.md", async () => {
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
          profile_digest: string;
          harness: {
            status: string;
            case_count: number;
          };
        };
      };
      expect(report.publish.runner_names).toEqual(["agent", "sourcey"]);
      expect(report.publish.profile_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(report.publish.harness).toMatchObject({
        status: "passed",
        case_count: 1,
      });
      await expect(createFileRegistryStore(registryDir).getVersion("0state/sourcey", "1.0.0")).resolves.toMatchObject({
        markdown: await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"),
        profile_document: await readFile(path.resolve("skills/sourcey/X.yaml"), "utf8"),
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

  it("rejects registry publish when inline harness assertions fail", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-skill-publish-harness-fail-"));
    const registryDir = path.join(tempDir, "registry");
    const skillDir = path.join(tempDir, "broken-skill");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(path.join(skillDir, ".runx"), { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: broken-skill
description: Broken publish harness.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - process.stdout.write("ok")
---

Broken skill.
`,
      );
      const profileDocument = `skill: broken-skill
runners:
  default:
    default: true
    source:
      type: cli-tool
      command: node
      args:
        - -e
        - process.stdout.write("ok")
harness:
  cases:
    - name: fails-on-purpose
      inputs: {}
      env: {}
      caller: {}
      expect:
        status: failure
`;
      await writeFile(
        path.join(skillDir, ".runx/profile.json"),
        `${JSON.stringify(
          {
            schema_version: "runx.skill-profile.v1",
            skill: {
              name: "broken-skill",
              path: "SKILL.md",
              digest: "fixture-skill-digest",
            },
            profile: {
              document: profileDocument,
              digest: "fixture-profile-digest",
              runner_names: ["default"],
            },
            origin: {
              source: "fixture",
            },
          },
          null,
          2,
        )}\n`,
      );

      const exitCode = await runCli(
        ["skill", "publish", skillDir, "--owner", "0state", "--registry", registryDir, "--json"],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout.contents()).toBe("");
      expect(stderr.contents()).toContain("Harness failed");
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
    expect(stderr.contents()).toContain("Remote registry publish is not supported from the OSS CLI");
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

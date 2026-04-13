import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, parseArgs } from "./index.js";
import { createFileRegistryStore, ingestSkillMarkdown } from "../../registry/src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("parseArgs", () => {
  it("preserves unknown skill input keys", () => {
    expect(parseArgs(["skill", "skills/example", "--project-url", "https://example.com"]).inputs).toEqual({
      "project-url": "https://example.com",
    });
  });

  it("maps kebab-case CLI flags onto declared snake_case skill inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-kebab-input-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "task-boundary");
    const answersPath = path.join(tempDir, "answers.json");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: task-boundary
description: Temporary fixture that echoes a task id through an agent boundary.
source:
  type: agent-step
  agent: codex
  task: task-boundary
  outputs:
    echoed_task: string
inputs:
  task_id:
    type: string
    required: true
---
Return the provided task id.
`,
    );
    await writeFile(
      answersPath,
      `${JSON.stringify(
        {
          answers: {
            "agent_step.task-boundary.output": {
              echoed_task: "abc-123",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      [skillDir, "--task-id", "abc-123", "--answers", answersPath, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "success",
      inputs: {
        task_id: "abc-123",
      },
    });
  });

  it("treats top-level commands outside the builtin set as skill invocations", () => {
    const parsed = parseArgs(["sourcey", "--project", "."]);

    expect(parsed.command).toBe("sourcey");
    expect(parsed.skillPath).toBe("sourcey");
    expect(parsed.inputs).toEqual({ project: "." });
  });

  it("normalizes known CLI flags without passing them as inputs", () => {
    const parsed = parseArgs([
      "skill",
      "skills/example",
      "--non-interactive",
      "--receipt-dir",
      "/tmp/receipts",
    ]);

    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.receiptDir).toBe("/tmp/receipts");
    expect(parsed.inputs).toEqual({});
  });

  it("returns a CLI error when an answers file cannot be read", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["skill", "fixtures/skills/agent-step", "--answers", "/tmp/runx-missing-answers.json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain("no such file or directory");
  });

  it("renders human-friendly needs-agent guidance for interactive sourcey runs", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const fakeBinDir = await createFakeAgentBin(["claude", "codex"]);

    const exitCode = await runCli(
      ["skill", "skills/sourcey", "--project", "fixtures/sourcey/incomplete"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), PATH: fakeBinDir },
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("waiting for discovery report");
    expect(stdout.contents()).toContain("discover");
    expect(stdout.contents()).toContain("needs discovery report");
    expect(stdout.contents()).toContain("Detected here: Claude Code, Codex");
    expect(stdout.contents()).toContain("needs discovery report before it can continue");
    expect(stdout.contents()).not.toContain("Resolution requested");
    expect(stdout.contents()).not.toContain("request   agent_step");
  });

  it("supports top-level skill invocation aliases", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const fakeBinDir = await createFakeAgentBin(["claude", "codex"]);

    const exitCode = await runCli(
      ["sourcey", "--project", "fixtures/sourcey/incomplete"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), PATH: fakeBinDir },
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("waiting for discovery report");
    expect(stdout.contents()).toContain("runx resume");
  });

  it("uses the current directory automatically for project-root questions", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "skills/sourcey"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).not.toContain("input needed");
    expect(stdout.contents()).toContain("waiting for discovery report");
  });

  it("keeps --json output machine-readable without progress lines", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "skills/sourcey", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents().trimStart().startsWith("{")).toBe(true);
    expect(stdout.contents()).not.toContain("Resolution requested");
    expect(stdout.contents()).not.toContain("needs caller result");
  });

  it("renders a success summary for simple skill runs", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "fixtures/skills/echo", "--message", "hello"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("success");
    expect(stdout.contents()).toContain("receipt");
    expect(stdout.contents()).toContain("output");
    expect(stdout.contents()).toContain("hello");
  });

  it("renders flattened human-readable config output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-config-"));
    tempDirs.push(tempDir);
    const runxHome = path.join(tempDir, ".runx");
    const env = { ...process.env, RUNX_HOME: runxHome };
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    await expect(runCli(["config", "set", "agent.provider", "openai", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
    await expect(runCli(["config", "set", "agent.model", "gpt-test", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
    await expect(runCli(["config", "set", "agent.api_key", "sk-secret-test", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
    stdout.clear();
    stderr.clear();

    const exitCode = await runCli(["config", "list"], { stdin: process.stdin, stdout, stderr }, env);

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("config");
    expect(stdout.contents()).toContain("agent.provider");
    expect(stdout.contents()).toContain("openai");
    expect(stdout.contents()).toContain("agent.model");
    expect(stdout.contents()).toContain("gpt-test");
    expect(stdout.contents()).toContain("agent.api_key");
    expect(stdout.contents()).toContain("[encrypted]");
    expect(stdout.contents()).not.toContain("sk-secret-test");
  });

  it("renders search results with run and add commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-search-"));
    tempDirs.push(tempDir);
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    await ingestSkillMarkdown(createFileRegistryStore(registryDir), await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"), {
      owner: "0state",
      version: "1.0.0",
      createdAt: "2026-04-10T00:00:00.000Z",
    });

    const exitCode = await runCli(
      ["skill", "search", "sourcey"],
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
    expect(stdout.contents()).toContain("0state/sourcey");
    expect(stdout.contents()).toContain("runx registry");
    expect(stdout.contents()).toContain("runx add 0state/sourcey@1.0.0 --registry https://runx.example.test");
    expect(stdout.contents()).toContain("runx sourcey");
  });

  it("renders connect results as human-readable summaries", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const connect = {
      list: async () => ({
        grants: [
          {
            grant_id: "grant_github_1",
            provider: "github",
            scopes: ["repo:read", "user:read"],
            status: "active",
          },
        ],
      }),
      preprovision: async (provider: string, scopes: readonly string[]) => ({
        status: "created" as const,
        grant: {
          grant_id: `grant_${provider}_1`,
          provider,
          scopes,
          status: "active",
        },
      }),
      revoke: async (grantId: string) => ({
        status: "revoked" as const,
        grant: {
          grant_id: grantId,
          provider: "github",
          scopes: ["repo:read"],
          status: "revoked",
        },
      }),
    };

    const listExit = await runCli(["connect", "list"], { stdin: process.stdin, stdout, stderr }, process.env, { connect });
    expect(listExit).toBe(0);
    expect(stdout.contents()).toContain("connections");
    expect(stdout.contents()).toContain("github");
    expect(stdout.contents()).toContain("repo:read, user:read");
    stdout.clear();
    stderr.clear();

    const preprovisionExit = await runCli(
      ["connect", "github", "--scope", "repo:read"],
      { stdin: process.stdin, stdout, stderr },
      process.env,
      { connect },
    );
    expect(preprovisionExit).toBe(0);
    expect(stdout.contents()).toContain("connection ready");
    expect(stdout.contents()).toContain("grant_github_1");
    stdout.clear();
    stderr.clear();

    const revokeExit = await runCli(
      ["connect", "revoke", "grant_github_1"],
      { stdin: process.stdin, stdout, stderr },
      process.env,
      { connect },
    );
    expect(revokeExit).toBe(0);
    expect(stdout.contents()).toContain("connection revoked");
    expect(stdout.contents()).toContain("grant_github_1");
  });

  it("rejects flat markdown skill references with a clear error", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "fixtures/skills/echo.md", "--message", "hello"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("Flat markdown files are not supported");
  });

  it("supports resuming a paused run by run id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-resume-"));
    tempDirs.push(tempDir);
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const firstExit = await runCli(
      ["sourcey", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), RUNX_RECEIPT_DIR: tempDir },
    );

    expect(firstExit).toBe(2);
    const first = JSON.parse(stdout.contents()) as { status: string; run_id: string; skill: string };
    expect(first.status).toBe("needs_resolution");
    expect(first.skill).toBe("sourcey");

    stdout.clear();
    stderr.clear();

    const resumeExit = await runCli(
      ["resume", first.run_id, "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), RUNX_RECEIPT_DIR: tempDir },
    );

    expect(resumeExit).toBe(2);
    const resumed = JSON.parse(stdout.contents()) as { status: string; run_id: string; skill: string };
    expect(resumed.status).toBe("needs_resolution");
    expect(resumed.run_id).toBe(first.run_id);
    expect(resumed.skill).toBe("sourcey");
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string; clear: () => void } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
    clear: () => {
      buffer = "";
    },
  } as NodeJS.WriteStream & { contents: () => string; clear: () => void };
}

async function createFakeAgentBin(commands: readonly string[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runx-cli-agents-"));
  tempDirs.push(directory);
  await Promise.all(
    commands.map(async (command) => {
      const filePath = path.join(directory, command);
      await writeFile(filePath, "#!/bin/sh\nexit 0\n");
      await chmod(filePath, 0o755);
    }),
  );
  return directory;
}

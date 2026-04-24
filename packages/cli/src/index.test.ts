import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateDevReportContract,
  validateDoctorReportContract,
  validateRunxListReportContract,
} from "@runxhq/contracts";
import { runCli, parseArgs, resolveSkillReference } from "./index.js";
import { hashString } from "@runxhq/core/receipts";
import { createFileRegistryStore, ingestSkillMarkdown } from "@runxhq/core/registry";
import { readCliDependencyVersion } from "./metadata.js";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
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

  it("preserves canonical delegated inputs across resume for wrapper skills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-delegated-resume-"));
    tempDirs.push(tempDir);
    const childDir = path.join(tempDir, "child-task");
    const wrapperDir = path.join(tempDir, "wrapper-task");
    const answersPath = path.join(tempDir, "answers.json");
    const receiptDir = path.join(tempDir, "receipts");

    await mkdir(childDir, { recursive: true });
    await mkdir(wrapperDir, { recursive: true });
    await mkdir(path.join(wrapperDir, ".runx"), { recursive: true });

    await writeFile(
      path.join(childDir, "SKILL.md"),
      `---
name: child-task
description: Temporary delegated fixture that echoes a task id through an agent boundary.
source:
  type: agent-step
  agent: codex
  task: child-task
  outputs:
    echoed_task: string
inputs:
  task_id:
    type: string
    required: false
    default: default-task
---
Return the provided task id.
`,
    );
    await writeFile(
      path.join(wrapperDir, "SKILL.md"),
      `---
name: wrapper-task
description: Compatibility wrapper that delegates to child-task.
---
Delegate to child-task.
`,
    );
    const profileDocument = `skill: wrapper-task

runners:
  wrapper-task:
    default: true
    type: chain
    inputs:
      task_id:
        type: string
        required: false
        default: default-task
    chain:
      name: wrapper-task
      owner: test
      steps:
        - id: delegate
          label: delegate task
          skill: ../child-task/SKILL.md
          mutation: false
`;
    await writeFile(
      path.join(wrapperDir, ".runx/profile.json"),
      `${JSON.stringify(
        {
          schema_version: "runx.skill-profile.v1",
          skill: {
            name: "wrapper-task",
            path: "SKILL.md",
            digest: "fixture-skill-digest",
          },
          profile: {
            document: profileDocument,
            digest: "fixture-profile-digest",
            runner_names: ["wrapper-task"],
          },
          origin: {
            source: "fixture",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      answersPath,
      `${JSON.stringify(
        {
          answers: {
            "agent_step.child-task.output": {
              echoed_task: "abc-123",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const firstStdout = createMemoryStream();
    const firstStderr = createMemoryStream();
    const firstExitCode = await runCli(
      [wrapperDir, "--task-id", "abc-123", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout: firstStdout, stderr: firstStderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(firstExitCode).toBe(2);
    expect(firstStderr.contents()).toBe("");
    const firstJson = JSON.parse(firstStdout.contents());
    expect(firstJson).toMatchObject({
      status: "needs_resolution",
      requests: [
        {
          id: "agent_step.child-task.output",
        },
      ],
    });

    const secondStdout = createMemoryStream();
    const secondStderr = createMemoryStream();
    const secondExitCode = await runCli(
      ["resume", firstJson.run_id, "--answers", answersPath, "--receipt-dir", receiptDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout: secondStdout, stderr: secondStderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(secondExitCode).toBe(0);
    expect(secondStderr.contents()).toBe("");
    expect(JSON.parse(secondStdout.contents())).toMatchObject({
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

  it("resolves top-level skill names to local workspace skill packages before any official fallback", () => {
    expect(resolveSkillReference("issue-to-pr", { ...process.env, RUNX_CWD: process.cwd() })).toBe(
      path.resolve("skills/issue-to-pr"),
    );
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

  it("parses trainable export filters without leaking them into skill inputs", () => {
    const parsed = parseArgs([
      "export-receipts",
      "--trainable",
      "--receipt-dir",
      "/tmp/runx-receipts",
      "--since",
      "2026-04-01T00:00:00Z",
      "--until",
      "2026-04-30T23:59:59Z",
      "--status",
      "complete",
      "--source",
      "cli-tool",
    ]);

    expect(parsed.command).toBe("export-receipts");
    expect(parsed.exportAction).toBe("trainable");
    expect(parsed.receiptDir).toBe("/tmp/runx-receipts");
    expect(parsed.exportSince).toBe("2026-04-01T00:00:00Z");
    expect(parsed.exportUntil).toBe("2026-04-30T23:59:59Z");
    expect(parsed.exportStatus).toBe("complete");
    expect(parsed.exportSource).toBe("cli-tool");
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
    expect(stdout.contents()).toContain("planning docs site");
    expect(stdout.contents()).toContain("discover");
    expect(stdout.contents()).toContain("needs docs plan");
    expect(stdout.contents()).toContain("Detected here: Claude Code, Codex");
    expect(stdout.contents()).toContain("inspect this repo and draft one bounded docs plan");
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
    expect(stdout.contents()).toContain("planning docs site");
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
    expect(stdout.contents()).toContain("planning docs site");
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
    expect(stdout.contents()).toContain("inspect");
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

  it("auto-resolves structured agent-step runs through the configured OpenAI managed adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-agent-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: process.cwd() };
    await configureOpenAiAgent(env, "gpt-test");

    let requestCount = 0;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestCount += 1;
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        tools: Array<{ name: string }>;
      };
      expect(body.model).toBe("gpt-test");
      expect(body.tools.map((tool) => tool.name)).toContain("submit_result");

      return new Response(JSON.stringify({
        output: [
          {
            type: "function_call",
            call_id: `call_${requestCount}`,
            name: "submit_result",
            arguments: JSON.stringify({ verdict: "pass" }),
          },
        ],
      }), { status: 200 });
    }) as typeof fetch;

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["skill", "fixtures/skills/agent-step", "--prompt", "review this", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      status: string;
      execution: { stdout: string };
      receipt: { metadata?: { agent_hook?: { route?: string } } };
    };
    expect(result.status).toBe("success");
    expect(JSON.parse(result.execution.stdout)).toEqual({ verdict: "pass" });
    expect(result.receipt.metadata?.agent_hook?.route).toBe("native");
    expect(requestCount).toBe(1);
  });

  it("auto-resolves structured agent-step runs through the configured Anthropic managed adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-agent-anthropic-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: process.cwd() };
    await configureAnthropicAgent(env, "claude-test");

    let requestCount = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      requestCount += 1;
      expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        tools: Array<{ name: string }>;
      };
      expect(body.model).toBe("claude-test");
      expect(body.tools.map((tool) => tool.name)).toContain("submit_result");

      return new Response(JSON.stringify({
        content: [
          {
            type: "tool_use",
            id: `tool_${requestCount}`,
            name: "submit_result",
            input: { verdict: "pass" },
          },
        ],
      }), { status: 200 });
    }) as typeof fetch;

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["skill", "fixtures/skills/agent-step", "--prompt", "review this", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      status: string;
      execution: { stdout: string };
      receipt: { metadata?: { agent_hook?: { route?: string } } };
    };
    expect(result.status).toBe("success");
    expect(JSON.parse(result.execution.stdout)).toEqual({ verdict: "pass" });
    expect(result.receipt.metadata?.agent_hook?.route).toBe("native");
    expect(requestCount).toBe(1);
  });

  it("lets the managed runtime use declared runx tools before submitting a result", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-tool-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: tempDir };
    await configureOpenAiAgent(env, "gpt-tool-test");

    const skillDir = path.join(tempDir, "file-summary");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(tempDir, "note.txt"), "tool grounded note\n");
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: file-summary
description: Summarize a file using the automatic CLI runtime.
source:
  type: agent-step
  agent: codex
  task: summarize-file
  outputs:
    summary: string
runx:
  allowed_tools:
    - fs.read
inputs:
  repo_root:
    type: string
    required: true
---
Read note.txt and produce a grounded summary.
`,
    );

    let requestCount = 0;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        input: Array<Record<string, unknown>>;
        tools: Array<{ name: string }>;
      };
      if (requestCount === 1) {
        expect(body.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["fs_read", "submit_result"]));
        return new Response(JSON.stringify({
          output: [
            {
              type: "function_call",
              call_id: "call_fs",
              name: "fs_read",
              arguments: JSON.stringify({
                path: "note.txt",
                repo_root: tempDir,
              }),
            },
          ],
        }), { status: 200 });
      }

      const toolOutput = body.input.find((item) => item.type === "function_call_output") as
        | { output?: string }
        | undefined;
      expect(toolOutput?.output).toContain("tool grounded note");
      return new Response(JSON.stringify({
        output: [
          {
            type: "function_call",
            call_id: "call_submit",
            name: "submit_result",
            arguments: JSON.stringify({ summary: "grounded from fs.read" }),
          },
        ],
      }), { status: 200 });
    }) as typeof fetch;

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      [skillDir, "--repo-root", tempDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as { execution: { stdout: string } };
    expect(JSON.parse(result.execution.stdout)).toEqual({ summary: "grounded from fs.read" });
    expect(requestCount).toBe(2);
  });

  it("auto-resolves plain-text agent runs when no structured outputs are declared", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-agent-text-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: tempDir };
    await configureOpenAiAgent(env, "gpt-text-test");

    const skillDir = path.join(tempDir, "plain-agent");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: plain-agent
description: Plain-text automatic agent fixture.
source:
  type: agent
inputs:
  prompt:
    type: string
    required: true
---
Answer the prompt directly.
`,
    );

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "plain agent answer",
            },
          ],
        },
      ],
    }), { status: 200 })) as typeof fetch;

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      [skillDir, "--prompt", "hello", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as { execution: { stdout: string } };
    expect(result.execution.stdout).toBe("plain agent answer");
  });

  it("renders search results with run and add commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-search-"));
    tempDirs.push(tempDir);
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    await ingestSkillMarkdown(createFileRegistryStore(registryDir), await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"), {
      owner: "acme",
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
    expect(stdout.contents()).toContain("acme/sourcey");
    expect(stdout.contents()).toContain("runx registry");
    expect(stdout.contents()).toContain("run  ");
    expect(stdout.contents()).toContain("add  ");
    expect(stdout.contents()).toContain("runx add acme/sourcey@1.0.0 --registry https://runx.example.test");
    expect(stdout.contents()).toContain("runx sourcey");
  });

  it("installs registry skills from the hosted public registry", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-remote-add-"));
    tempDirs.push(tempDir);
    const installDir = path.join(tempDir, "skills");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");
    const profileDocument = await readFile(path.resolve("skills/sourcey/X.yaml"), "utf8");
    const digest = hashString(markdown);
    const profileDigest = hashString(profileDocument);

    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://runx.example.test/v1/skills/acme/sourcey/acquire");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({
        status: "success",
        install_count: 1,
        acquisition: {
          skill_id: "acme/sourcey",
          owner: "acme",
          name: "sourcey",
          version: "1.0.0",
          digest,
          markdown,
          profile_document: profileDocument,
          profile_digest: profileDigest,
          trust_tier: "community",
          publisher: {
            id: "acme",
            kind: "publisher",
            handle: "acme",
          },
          attestations: [
            {
              kind: "publisher",
              id: "publisher:acme",
              status: "declared",
              summary: "acme",
            },
          ],
          runner_names: ["agent", "sourcey"],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const exitCode = await runCli(
      ["add", "acme/sourcey@1.0.0", "--registry", "https://runx.example.test", "--to", installDir],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_HOME: path.join(tempDir, "home"),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain(path.join(installDir, "acme", "sourcey", "SKILL.md"));
    await expect(readFile(path.join(installDir, "acme", "sourcey", "SKILL.md"), "utf8")).resolves.toBe(markdown);
    const installedProfileState = JSON.parse(
      await readFile(path.join(installDir, "acme", "sourcey", ".runx", "profile.json"), "utf8"),
    ) as { profile: { document: string } };
    expect(installedProfileState.profile.document).toBe(profileDocument);
  });

  it("renders top-level help with starter flows and admin commands", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(["--help"], { stdin: process.stdin, stdout, stderr }, { ...process.env, RUNX_CWD: process.cwd() });

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("Core Flow:");
    expect(stdout.contents()).toContain("runx search docs");
    expect(stdout.contents()).toContain("runx <skill> --project .");
    expect(stdout.contents()).toContain("runx evolve");
    expect(stdout.contents()).toContain("runx inspect <receipt-id>");
    expect(stdout.contents()).toContain("runx export-receipts --trainable");
    expect(stdout.contents()).toContain("Manage Skills:");
    expect(stdout.contents()).toContain("runx skill publish");
  });

  it("renders a neutral empty history state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-history-"));
    tempDirs.push(tempDir);
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(["history", "--receipt-dir", receiptDir], { stdin: process.stdin, stdout, stderr }, { ...process.env, RUNX_CWD: process.cwd() });

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("No receipts yet. Try a run first:");
    expect(stdout.contents()).toContain("runx evolve");
    expect(stdout.contents()).toContain("runx search docs");
    expect(stdout.contents()).not.toContain("runx search sourcey");
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
            scope_family: "github_repo",
            authority_kind: "read_only",
            target_repo: "runxhq/aster",
            status: "active",
          },
        ],
      }),
      preprovision: async (request: {
        readonly provider: string;
        readonly scopes: readonly string[];
        readonly scope_family?: string;
        readonly authority_kind?: "read_only" | "constructive" | "destructive";
        readonly target_repo?: string;
      }) => ({
        status: "created" as const,
        grant: {
          grant_id: `grant_${request.provider}_1`,
          provider: request.provider,
          scopes: request.scopes,
          scope_family: request.scope_family,
          authority_kind: request.authority_kind,
          target_repo: request.target_repo,
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
    expect(stdout.contents()).toContain("runxhq/aster");
    stdout.clear();
    stderr.clear();

    const preprovisionExit = await runCli(
      ["connect", "github", "--scope", "repo:read", "--scope-family", "github_repo", "--authority-kind", "read_only", "--target-repo", "runxhq/aster"],
      { stdin: process.stdin, stdout, stderr },
      process.env,
      { connect },
    );
    expect(preprovisionExit).toBe(0);
    expect(stdout.contents()).toContain("connection ready");
    expect(stdout.contents()).toContain("grant_github_1");
    expect(stdout.contents()).toContain("github_repo");
    expect(stdout.contents()).toContain("runxhq/aster");
    expect(stdout.contents()).toContain("runx connect list");
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
    expect(stdout.contents()).toContain("runx connect github");
  });

  it("renders a guided empty connect state", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const connect = {
      list: async () => ({ grants: [] }),
      preprovision: async () => ({ status: "created" as const, grant: undefined }),
      revoke: async () => ({ status: "revoked" as const, grant: undefined }),
    };

    const exitCode = await runCli(["connect", "list"], { stdin: process.stdin, stdout, stderr }, process.env, { connect });

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("No connections yet.");
    expect(stdout.contents()).toContain("runx connect github");
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

describe("runx list", () => {
  it("discovers local tools and skills without executing them", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-list-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "echo");
    const skillDir = path.join(tempDir, "skills", "demo-skill");
    await mkdir(toolDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.echo",
        description: "Echo fixture.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {
          message: {
            type: "string",
            required: true,
          },
        },
        scopes: ["demo.echo"],
        runx: {
          artifacts: {
            wrap_as: "echoed",
          },
        },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(skillDir, "X.yaml"),
      `skill: demo-skill
runners:
  default:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write('{}')"
harness:
  cases:
    - name: demo-smoke
      inputs: {}
      expect:
        status: success
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["list", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const report = validateRunxListReportContract(JSON.parse(stdout.contents()));
    expect(report.schema).toBe("runx.list.v1");
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", name: "demo.echo", path: "tools/demo/echo/manifest.json" }),
      expect.objectContaining({ kind: "skill", name: "demo-skill", path: "skills/demo-skill/X.yaml", harness_cases: 1 }),
    ]));
  });
});

describe("runx tool", () => {
  it("builds manifests with the current authoring toolkit version", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-tool-build-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "echo");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      path.join(toolDir, "run.mjs"),
      `process.stdout.write(JSON.stringify({ ok: true }));\n`,
    );
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.echo",
        version: "0.1.0",
        description: "Echo fixture.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        runtime: {
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {},
        output: {},
        scopes: [],
      }, null, 2)}\n`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["tool", "build", "--all", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      schema: "runx.tool.build.v1",
      status: "success",
      built: [
        expect.objectContaining({
          path: "tools/demo/echo",
          manifest: "tools/demo/echo/manifest.json",
        }),
      ],
    });

    const manifest = JSON.parse(await readFile(path.join(toolDir, "manifest.json"), "utf8")) as {
      readonly toolkit_version?: string;
    };
    expect(manifest.toolkit_version).toBe(readCliDependencyVersion("@runxhq/authoring"));
  });
});

describe("runx doctor", () => {
  it("emits machine-actionable diagnostics for legacy tool.yaml files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "legacy");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      path.join(toolDir, "tool.yaml"),
      `name: demo.legacy
description: Legacy tool fixture.
source:
  type: cli-tool
  command: node
  args:
    - ./run.mjs
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    const report = validateDoctorReportContract(JSON.parse(stdout.contents()));
    expect(report.schema).toBe("runx.doctor.v1");
    expect(report.status).toBe("failure");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        id: "runx.tool.manifest.legacy_format",
        instance_id: expect.stringMatching(/^sha256:/),
        repairs: [expect.objectContaining({ id: "migrate_to_define_tool", risk: "medium" })],
      }),
    ]);
  });

  it("validates chain context paths through artifact packet metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-packets-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "skills", "chain"), { recursive: true });
    await mkdir(path.join(tempDir, "dist", "packets"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({
        name: "packet-chain",
        version: "0.1.0",
        type: "module",
        runx: {
          packets: ["./dist/packets/*.schema.json"],
        },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "dist", "packets", "profile.v1.schema.json"),
      `${JSON.stringify({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.runx.dev/packet-chain/profile/v1.json",
        "x-runx-packet-id": "packet-chain.profile.v1",
        type: "object",
        properties: {
          profile: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "skills", "chain", "X.yaml"),
      `skill: chain
runners:
  default:
    default: true
    type: chain
    chain:
      name: chain
      steps:
        - id: produce
          run:
            type: agent-step
            agent: builder
            task: produce
            outputs:
              profile: object
          artifacts:
            named_emits:
              profile_packet: profile
            packets:
              profile_packet: packet-chain.profile.v1
        - id: consume
          run:
            type: agent-step
            agent: builder
            task: consume
            outputs:
              ok: string
          context:
            brand_name: produce.profile_packet.data.profile.name
harness:
  cases:
    - name: chain-smoke
      inputs: {}
      caller:
        answers:
          agent_step.produce.output:
            profile:
              name: Acme
          agent_step.consume.output:
            ok: yes
      expect:
        status: success
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      schema: "runx.doctor.v1",
      status: "success",
      summary: {
        errors: 0,
        warnings: 0,
      },
      diagnostics: [],
    });
  });

  it("requires runx-extended skills to declare harness coverage", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-harness-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "skills", "uncovered"), { recursive: true });
    await writeFile(
      path.join(tempDir, "skills", "uncovered", "X.yaml"),
      `skill: uncovered
runners:
  default:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write('{}')"
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "failure",
      diagnostics: [
        expect.objectContaining({
          id: "runx.skill.fixture.missing",
          severity: "error",
          evidence: {
            fixture_count: 0,
            harness_case_count: 0,
          },
        }),
      ],
    });
  });

  it("requires manifest-backed tools to declare deterministic fixtures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-tool-fixture-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "echo");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.echo",
        description: "Echo fixture.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {},
        scopes: [],
      }, null, 2)}\n`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "failure",
      diagnostics: [
        expect.objectContaining({
          id: "runx.tool.fixture.missing",
          severity: "error",
          target: {
            kind: "tool",
            ref: "demo.echo",
          },
        }),
      ],
    });
  });

  it("fails when the official skills lock is stale", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-lock-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "skills", "demo-skill");
    const lockPath = path.join(tempDir, "packages", "cli", "src", "official-skills.lock.json");
    await mkdir(skillDir, { recursive: true });
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: Demo skill fixture.
---
Return success.
`,
    );
    await writeFile(
      path.join(skillDir, "X.yaml"),
      `skill: demo-skill
runners:
  default:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write('{}')"
harness:
  cases:
    - name: demo-smoke
      inputs: {}
      expect:
        status: success
`,
    );
    await writeFile(lockPath, "[]\n");

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "failure",
      diagnostics: [
        expect.objectContaining({
          id: "runx.skill.lock.stale",
          severity: "error",
          repairs: [
            expect.objectContaining({
              id: "refresh_official_skills_lock",
              kind: "replace_file",
            }),
          ],
        }),
      ],
    });
  });

  it("fails when a designated monolith file exceeds its budget", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-budget-"));
    tempDirs.push(tempDir);
    const oversizedPath = path.join(tempDir, "packages", "cli", "src", "index.ts");
    await mkdir(path.dirname(oversizedPath), { recursive: true });
    await writeFile(
      oversizedPath,
      `${Array.from({ length: 3001 }, (_, index) => `line_${index}`).join("\n")}\n`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "failure",
      diagnostics: [
        expect.objectContaining({
          id: "runx.structure.file_budget.exceeded",
          severity: "error",
          evidence: {
            line_count: 3001,
            max_lines: 1000,
          },
          location: {
            path: "packages/cli/src/index.ts",
          },
        }),
      ],
    });
  });

  it("fails on forbidden cross-package src reach-ins", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-reach-in-"));
    tempDirs.push(tempDir);
    const cliSourcePath = path.join(tempDir, "packages", "cli", "src", "index.ts");
    const coreSourcePath = path.join(tempDir, "packages", "core", "src", "index.ts");
    await mkdir(path.dirname(cliSourcePath), { recursive: true });
    await mkdir(path.dirname(coreSourcePath), { recursive: true });
    await writeFile(cliSourcePath, `import "../../core/src/index.js";\n`);
    await writeFile(coreSourcePath, "export const core = true;\n");

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    const report = JSON.parse(stdout.contents()) as {
      readonly status: string;
      readonly diagnostics: readonly {
        readonly id: string;
        readonly severity: string;
        readonly evidence?: Readonly<Record<string, unknown>>;
        readonly location: { readonly path: string };
      }[];
    };
    expect(report.status).toBe("failure");
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "runx.structure.cross_package_reach_in",
        severity: "error",
        evidence: expect.objectContaining({
          specifier: "../../core/src/index.js",
          source_package: "cli",
          target_package: "core",
        }),
        location: expect.objectContaining({
          path: "packages/cli/src/index.ts",
        }),
      }),
    ]));
  });
});

describe("runx dev", () => {
  it("runs deterministic tool fixtures inside a disposable workspace", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dev-tool-workspace-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "read");
    await mkdir(path.join(toolDir, "fixtures"), { recursive: true });
    await writeFile(
      path.join(toolDir, "run.mjs"),
      `import { readFile } from "node:fs/promises";
import path from "node:path";
const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const contents = await readFile(path.join(inputs.repo_root, inputs.path), "utf8");
process.stdout.write(JSON.stringify({ path: inputs.path, contents, repo_root: inputs.repo_root }));
`,
    );
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.read",
        description: "Read a fixture file.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {
          path: { type: "string", required: true },
          repo_root: { type: "string", required: true },
        },
        scopes: ["demo.read"],
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(toolDir, "fixtures", "read.yaml"),
      `name: read-sandbox
lane: deterministic
target:
  kind: tool
  ref: demo.read
workspace:
  files:
    docs/readme.md: |
      hello from sandbox
inputs:
  repo_root: $RUNX_FIXTURE_ROOT
  path: docs/readme.md
expect:
  status: success
  output:
    subset:
      path: docs/readme.md
      contents: |
        hello from sandbox
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["dev", "--lane", "deterministic", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "success",
      fixtures: [
        expect.objectContaining({
          name: "read-sandbox",
          status: "success",
        }),
      ],
      receipt_id: expect.stringMatching(/^rx_/),
    });
  });

  it("runs repo-integration fixtures against a prepared fixture repository", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dev-repo-integration-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "repo_probe");
    await mkdir(path.join(toolDir, "fixtures"), { recursive: true });
    await writeFile(
      path.join(toolDir, "run.mjs"),
      `import fs from "node:fs";
import path from "node:path";
process.stdout.write(JSON.stringify({
  repo_root: process.env.RUNX_REPO_ROOT,
  fixture_root: process.env.RUNX_FIXTURE_ROOT,
  same_root: process.env.RUNX_REPO_ROOT === process.env.RUNX_FIXTURE_ROOT,
  git_dir_exists: fs.existsSync(path.join(process.env.RUNX_REPO_ROOT || "", ".git")),
}));
`,
    );
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.repo_probe",
        description: "Probe repo-integration fixture roots.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        runtime: {
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {},
        output: {},
        scopes: ["demo.read"],
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(toolDir, "fixtures", "repo.yaml"),
      `name: repo-probe
lane: repo-integration
target:
  kind: tool
  ref: demo.repo_probe
repo:
  files:
    README.md: |
      # Fixture repo
  git:
    dirty_files:
      README.md: |
        # Fixture repo
        dirty
expect:
  status: success
  output:
    subset:
      same_root: true
      git_dir_exists: true
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["dev", "--lane", "repo-integration", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "success",
      fixtures: [
        expect.objectContaining({
          name: "repo-probe",
          status: "success",
          output: expect.objectContaining({
            same_root: true,
            git_dir_exists: true,
          }),
        }),
      ],
      receipt_id: expect.stringMatching(/^rx_/),
    });
  });

  it("unwraps packet data for subset expectations when matches_packet is declared", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dev-packet-subset-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "emit_packet");
    await mkdir(path.join(toolDir, "fixtures"), { recursive: true });
    await mkdir(path.join(tempDir, "dist", "packets"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({
        name: "packet-demo",
        version: "0.1.0",
        type: "module",
        runx: {
          packets: ["./dist/packets/*.schema.json"],
        },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "dist", "packets", "echo.v1.schema.json"),
      `${JSON.stringify({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.runx.dev/packet-demo/echo/v1.json",
        "x-runx-packet-id": "packet-demo.echo.v1",
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
        additionalProperties: false,
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(toolDir, "run.mjs"),
      `process.stdout.write(JSON.stringify({
  schema: "packet-demo.echo.v1",
  data: { message: "hello" },
}));
`,
    );
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.emit_packet",
        description: "Emit a packet-wrapped result.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {},
        output: {
          packet: "packet-demo.echo.v1",
        },
        scopes: ["demo.read"],
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(toolDir, "fixtures", "emit.yaml"),
      `name: emit-packet
lane: deterministic
target:
  kind: tool
  ref: demo.emit_packet
expect:
  status: success
  output:
    matches_packet: packet-demo.echo.v1
    subset:
      message: hello
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["dev", "--lane", "deterministic", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "success",
      fixtures: [
        expect.objectContaining({
          name: "emit-packet",
          status: "success",
          output: {
            schema: "packet-demo.echo.v1",
            data: {
              message: "hello",
            },
          },
        }),
      ],
      receipt_id: expect.stringMatching(/^rx_/),
    });
  });

  it("validates agent replay cassettes against packet schemas", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dev-replay-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "fixtures"), { recursive: true });
    await mkdir(path.join(tempDir, "dist", "packets"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({
        name: "replay-demo",
        version: "0.1.0",
        type: "module",
        runx: {
          packets: ["./dist/packets/*.schema.json"],
        },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "dist", "packets", "echo.v1.schema.json"),
      `${JSON.stringify({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.runx.dev/replay-demo/echo/v1.json",
        "x-runx-packet-id": "replay-demo.echo.v1",
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
        additionalProperties: false,
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "fixtures", "agent.yaml"),
      `name: replay-basic
lane: agent
target:
  kind: skill
  ref: .
inputs:
  message: hello
agent:
  mode: replay
expect:
  status: success
  outputs:
    echo_packet:
      matches_packet: replay-demo.echo.v1
`,
    );
    await writeFile(
      path.join(tempDir, "fixtures", "agent.replay.json"),
      `${JSON.stringify({
        schema: "runx.replay.v1",
        fixture: "replay-basic",
        status: "success",
        outputs: {
          echo_packet: {
            schema: "replay-demo.echo.v1",
            data: {
              message: "hello",
            },
          },
        },
      }, null, 2)}\n`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const receiptDir = path.join(tempDir, "receipts");
    const exitCode = await runCli(
      ["dev", "--lane", "agent", "--receipt-dir", receiptDir, "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir, RUNX_RECEIPT_DIR: receiptDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const report = validateDevReportContract(JSON.parse(stdout.contents()));
    expect(report).toMatchObject({
      schema: "runx.dev.v1",
      status: "success",
      fixtures: [
        {
          name: "replay-basic",
          status: "success",
          replay_path: "fixtures/agent.replay.json",
        },
      ],
    });
    expect(report.receipt_id).toMatch(/^rx_/);

    stdout.clear();
    stderr.clear();
    const inspectExitCode = await runCli(
      ["inspect", report.receipt_id ?? "", "--receipt-dir", receiptDir, "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: tempDir },
    );
    expect(inspectExitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      verification: {
        status: "verified",
      },
      summary: {
        id: report.receipt_id,
        name: "runx.dev",
        status: "success",
      },
    });
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

async function configureOpenAiAgent(env: NodeJS.ProcessEnv, model: string): Promise<void> {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  await expect(runCli(["config", "set", "agent.provider", "openai", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
  await expect(runCli(["config", "set", "agent.model", model, "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
  await expect(runCli(["config", "set", "agent.api_key", "sk-test-secret", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
}

async function configureAnthropicAgent(env: NodeJS.ProcessEnv, model: string): Promise<void> {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  await expect(runCli(["config", "set", "agent.provider", "anthropic", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
  await expect(runCli(["config", "set", "agent.model", model, "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
  await expect(runCli(["config", "set", "agent.api_key", "anthropic-test-secret", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
}

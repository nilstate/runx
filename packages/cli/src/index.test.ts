import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  validateDevReportContract,
  validateDoctorReportContract,
  validateRunxListReportContract,
} from "@runxhq/contracts";
import { runCli, parseArgs, resolveSkillReference } from "./index.js";
import { readCliDependencyVersion } from "./metadata.js";
import { resolveRunxBinary } from "../../../tests/runx-binary.js";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const testRunxBinary = resolveRunxBinary();

beforeAll(() => {
  process.env.RUNX_DEV_RUST_CLI_BIN ??= testRunxBinary;
  process.env.RUNX_RECEIPT_SIGN_KID ??= "cli-package-test-key";
  process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64 ??= "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
  process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE ??= "hosted";
});

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

  it("parses structured JSON skill input values", () => {
    expect(parseArgs(["skill", "skills/example", "--thread", "{\"thread_locator\":\"local://fixture\"}"]).inputs).toEqual({
      thread: {
        thread_locator: "local://fixture",
      },
    });
  });

  it("maps kebab-case CLI flags onto declared native snake_case skill inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-kebab-input-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "task-boundary");
    await writeNativeCliToolSkill(skillDir, {
      name: "task-boundary",
      inputs: {
        task_id: {
          type: "string",
          required: true,
        },
      },
      script: "const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || \"{}\");\nprocess.stdout.write(JSON.stringify(inputs));\n",
    });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: task-boundary
description: Temporary native fixture that echoes a task id.
---
Return the provided task id.
`,
    );

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const receiptDir = path.join(tempDir, "receipts");
    const exitCode = await runCli(
      ["skill", skillDir, "--task-id", "abc-123", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), RUNX_RECEIPT_DIR: receiptDir },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as { status: string; execution: { stdout: string }; payload?: unknown };
    expect(result).toMatchObject({
      status: "sealed",
      payload: {
        task_id: "abc-123",
      },
    });
    expect(JSON.parse(result.execution.stdout)).toEqual({ task_id: "abc-123" });
  }, 15000);

  it("continues native agent-task runs with canonical snake_case inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-delegated-continuation-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "child-task");
    const answersPath = path.join(tempDir, "answers.json");
    const receiptDir = path.join(tempDir, "receipts");

    await writeNativeAgentStepSkill(skillDir, {
      name: "child-task",
      task: "child-task",
      outputs: {
        echoed_task: "string",
      },
      inputs: {
        task_id: {
          type: "string",
          required: false,
          default: "default-task",
        },
      },
    });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: child-task
description: Temporary native fixture that echoes a task id through an agent boundary.
---
Return the provided task id.
`,
    );
    await writeFile(
      answersPath,
      `${JSON.stringify(
        {
          answers: {
            "agent_task.child-task.output": {
              echoed_task: "abc-123",
              closure: {
                disposition: "closed",
                reason_code: "test_answer",
                summary: "test answer supplied by caller",
              },
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
      ["skill", skillDir, "--task-id", "abc-123", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout: firstStdout, stderr: firstStderr },
      hostDrivenAgentEnv(tempDir),
    );

    expect(firstExitCode).toBe(2);
    expect(firstStderr.contents()).toBe("");
    const firstJson = JSON.parse(firstStdout.contents());
    expect(firstJson).toMatchObject({
      status: "needs_agent",
      requests: [
        {
          id: "agent_task.child-task.output",
          invocation: {
            envelope: {
              inputs: {
                task_id: "abc-123",
              },
            },
          },
        },
      ],
    });

    const secondStdout = createMemoryStream();
    const secondStderr = createMemoryStream();
    const secondExitCode = await runCli(
      ["resume", firstJson.run_id, answersPath, "--receipt-dir", receiptDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout: secondStdout, stderr: secondStderr },
      hostDrivenAgentEnv(tempDir),
    );

    expect(secondExitCode, secondStdout.contents() + secondStderr.contents()).toBe(0);
    expect(secondStderr.contents()).toBe("");
    const secondJson = JSON.parse(secondStdout.contents()) as { execution: { stdout: string }; status: string };
    expect(secondJson).toMatchObject({
      status: "sealed",
    });
    expect(JSON.parse(secondJson.execution.stdout)).toMatchObject({ echoed_task: "abc-123" });
  });

  it("does not treat arbitrary top-level commands as skill invocations", () => {
    const parsed = parseArgs(["sourcey", "--project", "."]);

    expect(parsed.command).toBe("sourcey");
    expect(parsed.skillPath).toBeUndefined();
    expect(parsed.inputs).toEqual({ project: "." });
  });

  it("resolves workspace skill package names before any official fallback", () => {
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

  it("parses resume as the canonical continuation command", () => {
    const parsed = parseArgs(["resume", "rx_123", "answers.json", "--receipt-dir", "/tmp/receipts", "--json"]);

    expect(parsed.command).toBe("resume");
    expect(parsed.runId).toBe("rx_123");
    expect(parsed.answersPath).toBe("answers.json");
    expect(parsed.receiptDir).toBe("/tmp/receipts");
    expect(parsed.json).toBe(true);
    expect(parsed.inputs).toEqual({});
  });

  it("parses top-level add flags without leaking them as inputs", () => {
    const parsed = parseArgs([
      "add",
      "acme/sourcey",
      "--version",
      "1.0.0",
      "--registry",
      "https://runx.example.test",
      "--to",
      "skills",
      "--digest",
      "sha256:abc123",
    ]);

    expect(parsed.command).toBe("add");
    expect(parsed.addRef).toBe("acme/sourcey");
    expect(parsed.addVersion).toBe("1.0.0");
    expect(parsed.addTo).toBe("skills");
    expect(parsed.registryUrl).toBe("https://runx.example.test");
    expect(parsed.expectedDigest).toBe("abc123");
    expect(parsed.inputs).toEqual({});
  });

  it("parses GitHub add refs through --ref instead of skill-add state", () => {
    const parsed = parseArgs([
      "add",
      "github.com/kam/skills",
      "--ref",
      "main",
      "--api-base-url",
      "https://api.runx.test",
    ]);

    expect(parsed.command).toBe("add");
    expect(parsed.addRef).toBe("github.com/kam/skills");
    expect(parsed.addGitRef).toBe("main");
    expect(parsed.addApiBaseUrl).toBe("https://api.runx.test");
    expect(parsed.skillAction).toBeUndefined();
    expect(parsed.skillPath).toBeUndefined();
    expect(parsed.inputs).toEqual({});
  });

  it("marks legacy skill add without treating it as a direct skill run", () => {
    const parsed = parseArgs(["skill", "add", "acme/sourcey@1.0.0"]);

    expect(parsed.retiredSkillAdd).toBe(true);
    expect(parsed.skillAction).toBeUndefined();
    expect(parsed.skillPath).toBeUndefined();
    expect(parsed.addRef).toBeUndefined();
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

  it("parses policy commands without leaking flags into skill inputs", () => {
    const parsed = parseArgs(["policy", "inspect", "policy.json", "--json"]);

    expect(parsed.command).toBe("policy");
    expect(parsed.policyAction).toBe("inspect");
    expect(parsed.policyPath).toBe("policy.json");
    expect(parsed.inputs).toEqual({});
  });

  it("rejects legacy skill continuation flags with resume guidance", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["skill", "fixtures/skills/agent-task", "--answers", "/tmp/runx-missing-answers.json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("runx skill continuation flags are no longer supported");
    expect(stderr.contents()).toContain("runx resume <run-id> <answers.json>");
  });

  it("renders human-friendly needs-agent guidance for native agent-task runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-native-agent-guidance-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "agent-task");
    await writeNativeAgentStepSkill(skillDir, {
      name: "agent-task",
      task: "review",
      outputs: {
        verdict: "string",
      },
      inputs: {
        prompt: {
          type: "string",
          required: true,
        },
      },
    });
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const fakeBinDir = await createFakeAgentBin(["claude", "codex"]);

    const exitCode = await runCli(
      ["skill", skillDir, "--prompt", "review this", "--non-interactive"],
      { stdin: process.stdin, stdout, stderr },
      hostDrivenAgentEnv(tempDir, { PATH: fakeBinDir }),
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("waiting for verdict");
    expect(stdout.contents()).toContain("task      review");
    expect(stdout.contents()).toContain("Detected here: Claude Code, Codex");
    expect(stdout.contents()).toContain("runx resume run_agent_task-review-output answers.json");
    expect(stdout.contents()).not.toContain("Resolution requested");
    expect(stdout.contents()).not.toContain("request   agent_task");
  });

  it("rejects top-level skill invocation", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const fakeBinDir = await createFakeAgentBin(["claude", "codex"]);

    const exitCode = await runCli(
      ["sourcey", "--project", "fixtures/sourcey/incomplete"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), PATH: fakeBinDir },
    );

    expect(exitCode).toBe(64);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("Usage:");
    expect(stderr.contents()).toContain("Native help is authoritative:");
    expect(stderr.contents()).toContain("runx <command> --help");
  });

  it("routes sourcey through the native graph runner without TS fallback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sourcey-native-"));
    tempDirs.push(tempDir);
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "skills/sourcey", "--run", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), RUNX_RECEIPT_DIR: tempDir },
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "needs_agent",
      requests: [
        {
          id: "graph.required-inputs",
          kind: "graph.required_inputs",
        },
      ],
    });
  });

  it("keeps native needs-agent --json output machine-readable without progress lines", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-native-agent-json-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "agent-task");
    await writeNativeAgentStepSkill(skillDir, {
      name: "agent-task",
      task: "review",
      outputs: {
        verdict: "string",
      },
      inputs: {
        prompt: {
          type: "string",
          required: true,
        },
      },
    });
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", skillDir, "--prompt", "review this", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      hostDrivenAgentEnv(tempDir),
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents().trimStart().startsWith("{")).toBe(true);
    expect(stdout.contents()).not.toContain("Resolution requested");
    expect(stdout.contents()).not.toContain("needs caller result");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "needs_agent",
      run_id: "run_agent_task-review-output",
      requests: [
        {
          id: "agent_task.review.output",
          kind: "agent_act",
        },
      ],
    });
  });

  it("renders a sealed summary for simple skill runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-sealed-summary-"));
    tempDirs.push(tempDir);
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "fixtures/skills/echo", "--message", "hello"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), RUNX_RECEIPT_DIR: path.join(tempDir, "receipts") },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("sealed");
    expect(stdout.contents()).toContain("receipt");
    expect(stdout.contents()).toContain("history");
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

  it("inspects operational policy without exposing raw source locators", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["policy", "inspect", "fixtures/operational-policy/provider-like.json", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      status: string;
      policy: {
        policy_id: string;
        sources: Array<{ locator_count: number }>;
      };
    };
    expect(result.status).toBe("success");
    expect(result.policy.policy_id).toBe("provider-issue-flow");
    expect(result.policy.sources[0]?.locator_count).toBe(1);
    expect(stdout.contents()).not.toContain(process.cwd());
    expect(stdout.contents()).not.toContain("slack://example/C0APFMY0V8Q");
    expect(stdout.contents()).not.toContain("sentry://example/production");
  });

  it("fails policy lint when target actions have no available runner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-policy-"));
    tempDirs.push(tempDir);
    const policyPath = path.join(tempDir, "policy.json");
    const policy = await readFixturePolicy();
    policy.runners[0].state = "maintenance";
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["policy", "lint", policyPath, "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      status: string;
      findings: Array<{ code: string }>;
    };
    expect(result.status).toBe("failure");
    expect(result.findings.map((finding) => finding.code)).toContain("target_action_without_runner");
  });

  it("does not route native agent-task runs through the TS OpenAI managed adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-agent-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: process.cwd() };
    await configureOpenAiAgent(env, "gpt-test");
    const skillDir = path.join(tempDir, "agent-task");
    await writeNativeAgentStepSkill(skillDir, {
      name: "agent-task",
      task: "review",
      outputs: {
        verdict: "string",
      },
      inputs: {
        prompt: {
          type: "string",
          required: true,
        },
      },
    });

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
      ["skill", skillDir, "--prompt", "review this", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      status: string;
      requests: Array<{ id: string; kind: string }>;
    };
    expect(result.status).toBe("needs_agent");
    expect(result.requests).toEqual([
      expect.objectContaining({
        id: "agent_task.review.output",
        kind: "agent_act",
      }),
    ]);
    expect(requestCount).toBe(0);
  });

  it("does not route native agent-task runs through the TS Anthropic managed adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-agent-anthropic-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: process.cwd() };
    await configureAnthropicAgentWithoutKey(env, "claude-test");
    const skillDir = path.join(tempDir, "agent-task");
    await writeNativeAgentStepSkill(skillDir, {
      name: "agent-task",
      task: "review",
      outputs: {
        verdict: "string",
      },
      inputs: {
        prompt: {
          type: "string",
          required: true,
        },
      },
    });

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
      ["skill", skillDir, "--prompt", "review this", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      status: string;
      requests: Array<{ id: string; kind: string }>;
    };
    expect(result.status).toBe("needs_agent");
    expect(result.requests).toEqual([
      expect.objectContaining({
        id: "agent_task.review.output",
        kind: "agent_act",
      }),
    ]);
    expect(requestCount).toBe(0);
  });

  it("does not invoke the TS managed tool loop for native agent-task runs with declared tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-tool-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: tempDir };
    await configureOpenAiAgent(env, "gpt-tool-test");

    const skillDir = path.join(tempDir, "file-summary");
    await writeNativeAgentStepSkill(skillDir, {
      name: "file-summary",
      task: "summarize-file",
      outputs: {
        summary: "string",
      },
      inputs: {
        repo_root: {
          type: "string",
          required: true,
        },
      },
      allowedTools: ["fs.read"],
    });
    await writeFile(path.join(tempDir, "note.txt"), "tool grounded note\n");
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: file-summary
description: Summarize a file using the automatic CLI runtime.
source:
  type: agent-task
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
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    }) as typeof fetch;

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["skill", skillDir, "--repo-root", tempDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as {
      requests: Array<{
        invocation?: {
          envelope?: {
            inputs?: Record<string, unknown>;
          };
        };
      }>;
    };
    expect(result.requests[0]?.invocation?.envelope?.inputs).toMatchObject({
      repo_root: tempDir,
    });
    expect(requestCount).toBe(0);
  });

  it("continues native agent-task runs with caller answers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-managed-tool-pause-"));
    tempDirs.push(tempDir);
    const receiptDir = path.join(tempDir, "receipts");
    const answersPath = path.join(tempDir, "answers.json");
    const workspaceDir = path.join(tempDir, "workspace");
    const env = {
      ...process.env,
      RUNX_HOME: path.join(tempDir, ".runx"),
      RUNX_CWD: workspaceDir,
      RUNX_RECEIPT_DIR: receiptDir,
    };
    await configureOpenAiAgent(env, "gpt-tool-pause-test");

    const skillDir = path.join(workspaceDir, "native-agent");
    await writeNativeAgentStepSkill(skillDir, {
      name: "native-agent",
      task: "summarize-label",
      outputs: {
        summary: "string",
      },
      inputs: {
        prompt: {
          type: "string",
          required: true,
        },
      },
    });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: file-summary
description: Resolve a native agent-task through same-skill continuation.
---
Return the grounded label.
`,
    );

    let requestCount = 0;
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    }) as typeof fetch;

    const firstStdout = createMemoryStream();
    const firstStderr = createMemoryStream();
    const firstExit = await runCli(
      ["skill", skillDir, "--prompt", "hello", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout: firstStdout, stderr: firstStderr },
      env,
    );

    expect(firstExit).toBe(2);
    expect(firstStderr.contents()).toBe("");
    const first = JSON.parse(firstStdout.contents()) as {
      status: string;
      run_id: string;
      requests: Array<{ id: string; kind: string }>;
    };
    expect(first.status).toBe("needs_agent");
    expect(first.requests[0]).toMatchObject({
      id: "agent_task.summarize-label.output",
      kind: "agent_act",
    });

    await writeFile(
      answersPath,
      `${JSON.stringify(
        {
          answers: {
            "agent_task.summarize-label.output": {
              summary: "grounded from caller answer",
              closure: {
                disposition: "closed",
                reason_code: "test_answer",
                summary: "test answer supplied by caller",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const continuedStdout = createMemoryStream();
    const continuedStderr = createMemoryStream();
    const continuedExit = await runCli(
      ["resume", first.run_id, answersPath, "--receipt-dir", receiptDir, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout: continuedStdout, stderr: continuedStderr },
      env,
    );

    expect(continuedExit, continuedStdout.contents() + continuedStderr.contents()).toBe(0);
    expect(continuedStderr.contents()).toBe("");
    const continued = JSON.parse(continuedStdout.contents()) as { execution: { stdout: string } };
    expect(JSON.parse(continued.execution.stdout)).toMatchObject({ summary: "grounded from caller answer" });
    expect(requestCount).toBe(0);
  });

  it("pauses native plain-text agent runs when no structured outputs are declared", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-auto-agent-text-"));
    tempDirs.push(tempDir);
    const env = { ...process.env, RUNX_HOME: path.join(tempDir, ".runx"), RUNX_CWD: tempDir };
    await configureOpenAiAgent(env, "gpt-text-test");

    const skillDir = path.join(tempDir, "plain-agent");
    await writeNativeAgentSkill(skillDir, {
      name: "plain-agent",
      inputs: {
        prompt: {
          type: "string",
          required: true,
        },
      },
    });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: plain-agent
description: Plain-text native agent fixture.
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
      ["skill", skillDir, "--prompt", "hello", "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      env,
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");
    const result = JSON.parse(stdout.contents()) as { status: string; requests: Array<{ id: string; kind: string }> };
    expect(result).toMatchObject({
      status: "needs_agent",
      requests: [
        {
          id: "agent.default.output",
          kind: "agent_act",
        },
      ],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("renders search results with run and add commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-search-"));
    tempDirs.push(tempDir);
    const registryDir = path.join(tempDir, "registry");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const publishStdout = createMemoryStream();
    const publishStderr = createMemoryStream();
    await expect(
      runCli(
        ["skill", "publish", "skills/receipt-auditor", "--owner", "acme", "--version", "1.0.0", "--registry", registryDir, "--json"],
        { stdin: process.stdin, stdout: publishStdout, stderr: publishStderr },
        { ...process.env, RUNX_CWD: process.cwd() },
      ),
    ).resolves.toBe(0);
    expect(publishStderr.contents()).toBe("");

    const exitCode = await runCli(
      ["skill", "search", "receipt-auditor"],
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
    expect(stdout.contents()).toContain("acme/receipt-auditor");
    expect(stdout.contents()).toContain("runx registry");
    expect(stdout.contents()).toContain("run  ");
    expect(stdout.contents()).toContain("add  ");
    expect(stdout.contents()).toContain("runx add acme/receipt-auditor@1.0.0 --registry https://runx.example.test");
    expect(stdout.contents()).toContain("runx skill acme/receipt-auditor@1.0.0 --registry https://runx.example.test");
  });

  it("routes hosted registry installs to the native subprocess", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-remote-add-"));
    tempDirs.push(tempDir);
    const installDir = path.join(tempDir, "skills");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    globalThis.fetch = vi.fn(async (input, init) => {
      expect(input).toBeDefined();
      expect(init).toBeDefined();
      return new Response(JSON.stringify({
        status: "success",
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

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    const output = JSON.parse(stdout.contents()) as { readonly error?: { readonly message?: string } };
    expect(output.error?.message).toContain("runtime HTTP transport failed");
    expect(output.error?.message).toContain("https://runx.example.test/v1/skills/acme/sourcey%401%2E0%2E0/acquire");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await expect(readFile(path.join(installDir, "acme", "sourcey", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("delegates registry add without installation identity flags", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-add-no-installation-id-"));
    tempDirs.push(tempDir);
    const nativeBin = path.join(tempDir, "fake-runx.js");
    await writeFile(
      nativeBin,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n",
    );
    await chmod(nativeBin, 0o755);

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      [
        "add",
        "acme/sourcey@1.0.0",
        "--registry",
        "https://runx.example.test",
        "--to",
        path.join(tempDir, "skills"),
        "--json",
      ],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_HOME: path.join(tempDir, "home"),
        RUNX_DEV_RUST_CLI_BIN: nativeBin,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const argv = JSON.parse(stdout.contents()).argv as string[];
    expect(argv).toEqual(expect.arrayContaining(["registry", "install", "acme/sourcey@1.0.0"]));
    expect(argv).not.toContain("--installation-id");
  });

  it("rejects removed add installation identity flags", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ["add", "acme/sourcey@1.0.0", "--installation-id", "inst_user"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(64);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("unknown add flag --installation-id");
  });

  it("forwards receipt publish to the native subprocess", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-publish-"));
    tempDirs.push(tempDir);
    const nativeBin = path.join(tempDir, "fake-runx.js");
    const receiptPath = path.join(tempDir, "receipt.json");
    await writeFile(receiptPath, "{\"id\":\"receipt_1\"}\n");
    await writeFile(
      nativeBin,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n",
    );
    await chmod(nativeBin, 0o755);

    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      [
        "publish",
        receiptPath,
        "--api-base-url",
        "https://runx.example.test",
        "--token",
        "rxk_test",
        "--allow-local-api",
        "--json",
      ],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_DEV_RUST_CLI_BIN: nativeBin,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    const argv = JSON.parse(stdout.contents()).argv as string[];
    expect(argv).toEqual([
      "publish",
      receiptPath,
      "--api-base-url",
      "https://runx.example.test",
      "--token",
      "rxk_test",
      "--allow-local-api",
      "--json",
    ]);
  });

  it("indexes GitHub URL adds through the configured API endpoint", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    let capturedBody: unknown;

    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({
        status: "success",
        listings: [
          {
            owner: "kam",
            name: "echo",
            skill_id: "kam/echo",
            version: "sha-abc",
            permalink: "https://runx.example.test/x/kam/echo",
            trust_tier: "community",
            skill_path: "SKILL.md",
            digest_unchanged: false,
          },
        ],
        warnings: [],
        repo: { owner: "kam", repo: "skills", ref: "main", sha: "a".repeat(40) },
      }), { status: 200 });
    }) as typeof fetch;

    const exitCode = await runCli(
      ["add", "github.com/kam/skills", "--ref", "main", "--api-base-url", "https://api.runx.test", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.runx.test/v1/index",
      expect.objectContaining({ method: "POST" }),
    );
    expect(capturedBody).toEqual({ repo_url: "github.com/kam/skills", ref: "main" });
    expect(JSON.parse(stdout.contents())).toMatchObject({ status: "success" });
  });

  it("rejects install-only flags for GitHub URL add without calling the API", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    globalThis.fetch = vi.fn() as typeof fetch;

    const exitCode = await runCli(
      ["add", "github.com/kam/skills", "--to", "skills"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("does not support --to or --digest");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects --registry for GitHub URL add with api-base-url guidance", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    globalThis.fetch = vi.fn() as typeof fetch;

    const exitCode = await runCli(
      ["add", "github.com/kam/skills", "--registry", "https://api.runx.test"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("uses --api-base-url");
    expect(stderr.contents()).toContain("not --registry");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("renders add validation failures as JSON when requested", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    globalThis.fetch = vi.fn() as typeof fetch;

    const exitCode = await runCli(
      ["add", "github.com/kam/skills", "--registry", "https://api.runx.test", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "failure",
      error: {
        code: "invalid_args",
        message: expect.stringContaining("uses --api-base-url"),
      },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects --version for GitHub URL add with --ref guidance", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    globalThis.fetch = vi.fn() as typeof fetch;

    const exitCode = await runCli(
      ["add", "github.com/kam/skills", "--version", "main"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("uses --ref <git-ref>, not --version");
    expect(stderr.contents()).toContain("runx add <github-url> --ref <git-ref>");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("renders top-level help as a native grammar launcher", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(["--help"], { stdin: process.stdin, stdout, stderr }, { ...process.env, RUNX_CWD: process.cwd() });

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).toContain("Native help is authoritative:");
    expect(stdout.contents()).toContain("runx --help");
    expect(stdout.contents()).toContain("runx <command> --help");
    expect(stdout.contents()).toContain("command grammar lives in the Rust binary");
    expect(stdout.contents()).not.toContain("Commands:");
    expect(stdout.contents()).not.toContain("runx history [query]");
    expect(stdout.contents()).not.toContain("runx add <skill-ref>");
    expect(stdout.contents()).not.toContain("runx mcp serve <skill-ref>");
  });

  it("rejects retired command aliases and TS-only history helpers", async () => {
    for (const argv of [
      ["search", "docs"],
      ["inspect", "rx_123"],
      ["skill", "inspect", "rx_123"],
      ["replay", "rx_123"],
      ["diff", "rx_left", "rx_right"],
    ]) {
      const stdout = createMemoryStream();
      const stderr = createMemoryStream();

      const exitCode = await runCli(argv, { stdin: process.stdin, stdout, stderr }, { ...process.env, RUNX_CWD: process.cwd() });

      expect(exitCode).toBe(64);
      expect(stdout.contents()).toBe("");
      expect(stderr.contents()).toContain("Usage:");
    }
  });

  it("rejects legacy skill add with canonical add guidance", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ["skill", "add", "acme/sourcey@1.0.0"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(64);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toContain("runx skill add is no longer supported");
    expect(stderr.contents()).toContain("runx add <skill-ref|github-url>");
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
    expect(stdout.contents()).toContain("runx skill <skill-dir> --json");
    expect(stdout.contents()).toContain("runx list skills");
    expect(stdout.contents()).not.toContain("runx evolve");
    expect(stdout.contents()).not.toContain("runx skill search docs");
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

  it("surfaces native graph runner needs-agent output instead of continuing sourcey through TS", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-continuation-"));
    tempDirs.push(tempDir);
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const firstExit = await runCli(
      ["skill", "sourcey", "--run", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd(), RUNX_RECEIPT_DIR: tempDir },
    );

    expect(firstExit).toBe(2);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "needs_agent",
      requests: [
        {
          id: "graph.required-inputs",
          kind: "graph.required_inputs",
        },
      ],
    });
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
        status: sealed
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
  it("treats local tool helper changes as stale manifest source", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-tool-helper-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "with_helper");
    await mkdir(path.join(toolDir, "src"), { recursive: true });
    await mkdir(path.join(toolDir, "fixtures"), { recursive: true });
    await writeFile(
      path.join(tempDir, "tools", "demo", "helper.ts"),
      `export const suffix = "one";\n`,
    );
    await writeFile(
      path.join(toolDir, "src", "index.ts"),
      `import { suffix } from "../../helper.js";\nexport const helperSuffix = suffix;\n`,
    );
    await writeFile(
      path.join(toolDir, "run.mjs"),
      `process.stdout.write(JSON.stringify({ ok: true }));\n`,
    );
    await writeFile(
      path.join(toolDir, "fixtures", "basic.yaml"),
      `target:\n  kind: tool\n`,
    );
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.with_helper",
        description: "Tool with namespace helper.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        inputs: {},
        output: {},
        scopes: [],
      }, null, 2)}\n`,
    );

    const buildStdout = createMemoryStream();
    const buildStderr = createMemoryStream();
    const buildExitCode = await runCli(
      ["tool", "build", "tools/demo/with_helper", "--json"],
      { stdin: process.stdin, stdout: buildStdout, stderr: buildStderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(buildExitCode).toBe(0);
    expect(buildStderr.contents()).toBe("");
    expect(JSON.parse(buildStdout.contents())).toMatchObject({ status: "success" });

    await writeFile(
      path.join(tempDir, "tools", "demo", "helper.ts"),
      `export const suffix = "two";\n`,
    );

    const doctorStdout = createMemoryStream();
    const doctorStderr = createMemoryStream();
    const doctorExitCode = await runCli(
      ["doctor", "--json"],
      { stdin: process.stdin, stdout: doctorStdout, stderr: doctorStderr },
      { ...process.env, RUNX_CWD: tempDir },
    );

    expect(doctorExitCode).toBe(1);
    expect(doctorStderr.contents()).toBe("");
    expect(JSON.parse(doctorStdout.contents())).toMatchObject({
      status: "failure",
      diagnostics: [
        expect.objectContaining({
          id: "runx.tool.manifest.stale",
          location: {
            path: "tools/demo/with_helper/manifest.json",
            json_pointer: "/source_hash",
          },
        }),
      ],
    });
  });

  it("emits machine-actionable diagnostics for removed tool.yaml files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-"));
    tempDirs.push(tempDir);
    const toolDir = path.join(tempDir, "tools", "demo", "removed");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      path.join(toolDir, "tool.yaml"),
      `name: demo.removed
description: Removed tool fixture.
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
        id: "runx.tool.manifest.removed_format",
        instance_id: expect.stringMatching(/^sha256:/),
        repairs: [expect.objectContaining({ id: "replace_removed_tool_manifest", kind: "manual", risk: "medium" })],
      }),
    ]);
  });

  it("validates graph context paths through artifact packet metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-doctor-packets-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "skills", "graph"), { recursive: true });
    await mkdir(path.join(tempDir, "dist", "packets"), { recursive: true });
    await mkdir(path.join(tempDir, "tools", "demo", "profile", "fixtures"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({
        name: "packet-graph",
        version: "0.1.0",
        type: "module",
        runx: {
          packets: ["./dist/packets/*.schema.json"],
        },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "tools", "demo", "profile", "manifest.json"),
      `${JSON.stringify({
        schema: "runx.tool.manifest.v1",
        name: "demo.profile",
        description: "Emit a demo profile packet.",
        source: {
          type: "cli-tool",
          command: "node",
          args: ["./run.mjs"],
        },
        output: {
          packet: "packet-graph.profile.v1",
          wrap_as: "profile_packet",
        },
        runx: {
          artifacts: {
            wrap_as: "profile_packet",
          },
        },
        runtime: {
          command: "node",
          args: ["./run.mjs"],
        },
      }, null, 2)}\n`,
    );
    await writeFile(path.join(tempDir, "tools", "demo", "profile", "fixtures", "basic.yaml"), "target:\n  kind: tool\n");
    await writeFile(
      path.join(tempDir, "dist", "packets", "profile.v1.schema.json"),
      `${JSON.stringify({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.runx.dev/packet-graph/profile/v1.json",
        "x-runx-packet-id": "packet-graph.profile.v1",
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
      path.join(tempDir, "skills", "graph", "X.yaml"),
      `skill: graph
runners:
  default:
    default: true
    type: graph
    graph:
      name: graph
      steps:
        - id: produce
          run:
            type: agent-task
            agent: builder
            task: produce
            outputs:
              profile: object
          artifacts:
            named_emits:
              profile_packet: profile
            packets:
              profile_packet: packet-graph.profile.v1
        - id: tool-produce
          tool: demo.profile
        - id: consume
          run:
            type: agent-task
            agent: builder
            task: consume
            outputs:
              ok: string
          context:
            brand_name: produce.profile_packet.data.profile.name
            tool_brand_name: tool-produce.profile_packet.data.profile.name
harness:
  cases:
    - name: graph-smoke
      inputs: {}
      caller:
        answers:
          agent_task.produce.output:
            profile:
              name: Acme
          agent_task.consume.output:
            ok: yes
      expect:
        status: sealed
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
        status: sealed
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
    const contractsSourcePath = path.join(tempDir, "packages", "contracts", "src", "index.ts");
    await mkdir(path.dirname(cliSourcePath), { recursive: true });
    await mkdir(path.dirname(contractsSourcePath), { recursive: true });
    await writeFile(cliSourcePath, `import "../../contracts/src/index.js";\n`);
    await writeFile(contractsSourcePath, "export const contracts = true;\n");

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
          specifier: "../../contracts/src/index.js",
          source_package: "cli",
          target_package: "contracts",
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
    });
  });

  it("runs repo-integration fixtures against the native prepared workspace root", async () => {
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
            git_dir_exists: expect.any(Boolean),
          }),
        }),
      ],
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
    });
  });

  it("reports native agent replay fixtures as skipped until Rust supports the lane", async () => {
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
      status: "skipped",
      fixtures: [
        {
          name: "replay-basic",
          status: "skipped",
        },
      ],
    });
    expect(report.receipt_id).toBeUndefined();
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

type NativeInputSchema = Record<string, {
  readonly type: string;
  readonly required?: boolean;
  readonly default?: string;
}>;

async function writeNativeCliToolSkill(directory: string, options: {
  readonly name: string;
  readonly inputs?: NativeInputSchema;
  readonly script: string;
}): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "run.mjs"), options.script);
  await writeFile(
    path.join(directory, "X.yaml"),
    `skill: ${options.name}
runners:
  default:
    default: true
    type: cli-tool
    command: node
    args:
      - ./run.mjs
${renderNativeInputs(options.inputs, 4)}`,
  );
}

async function writeNativeAgentSkill(directory: string, options: {
  readonly name: string;
  readonly inputs?: NativeInputSchema;
}): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "X.yaml"),
    `skill: ${options.name}
runners:
  default:
    default: true
    type: agent
${renderNativeInputs(options.inputs, 4)}`,
  );
}

async function writeNativeAgentStepSkill(directory: string, options: {
  readonly name: string;
  readonly task: string;
  readonly outputs: Record<string, string>;
  readonly inputs?: NativeInputSchema;
  readonly allowedTools?: readonly string[];
}): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "X.yaml"),
    `skill: ${options.name}
runners:
  default:
    default: true
    type: agent-task
    agent: codex
    task: ${options.task}
${renderNativeOutputs(options.outputs, 4)}${renderNativeInputs(options.inputs, 4)}${renderAllowedTools(options.allowedTools, 4)}`,
  );
}

function renderNativeInputs(inputs: NativeInputSchema | undefined, indent: number): string {
  if (!inputs || Object.keys(inputs).length === 0) {
    return "";
  }
  const prefix = " ".repeat(indent);
  const lines = [`${prefix}inputs:`];
  for (const [name, schema] of Object.entries(inputs)) {
    lines.push(`${prefix}  ${name}:`);
    lines.push(`${prefix}    type: ${schema.type}`);
    if (schema.required !== undefined) {
      lines.push(`${prefix}    required: ${schema.required ? "true" : "false"}`);
    }
    if (schema.default !== undefined) {
      lines.push(`${prefix}    default: ${schema.default}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderNativeOutputs(outputs: Record<string, string>, indent: number): string {
  const prefix = " ".repeat(indent);
  const lines = [`${prefix}outputs:`];
  for (const [name, type] of Object.entries(outputs)) {
    lines.push(`${prefix}  ${name}: ${type}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderAllowedTools(allowedTools: readonly string[] | undefined, indent: number): string {
  if (!allowedTools || allowedTools.length === 0) {
    return "";
  }
  const prefix = " ".repeat(indent);
  return `${prefix}allowed_tools:\n${allowedTools.map((tool) => `${prefix}  - ${tool}`).join("\n")}\n`;
}

interface MutablePolicyFixture extends Record<string, unknown> {
  runners: Array<{ state: string }>;
}

async function readFixturePolicy(): Promise<MutablePolicyFixture> {
  return JSON.parse(await readFile("fixtures/operational-policy/provider-like.json", "utf8")) as MutablePolicyFixture;
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

function hostDrivenAgentEnv(tempDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUNX_HOME: path.join(tempDir, ".runx"),
    RUNX_CWD: process.cwd(),
    ...overrides,
  };
  delete env.RUNX_AGENT_PROVIDER;
  delete env.RUNX_AGENT_MODEL;
  delete env.RUNX_AGENT_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
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

async function configureAnthropicAgentWithoutKey(env: NodeJS.ProcessEnv, model: string): Promise<void> {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  await expect(runCli(["config", "set", "agent.provider", "anthropic", "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
  await expect(runCli(["config", "set", "agent.model", model, "--json"], { stdin: process.stdin, stdout, stderr }, env)).resolves.toBe(0);
  stdout.clear();
  stderr.clear();
}

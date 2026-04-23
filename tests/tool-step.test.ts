import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseGraphYaml, validateGraph } from "@runxhq/core/parser";
import { runLocalGraph, type Caller } from "@runxhq/core/runner-local";

describe("tool steps", () => {
  it("resolves builtin tool manifests and carries allowed_tools into agent steps", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-tool-step-"));
    const receiptDir = path.join(tempDir, "receipts");
    const notePath = path.join(tempDir, "note.txt");
    await writeFile(notePath, "tool output");

    const chain = validateGraph(
      parseGraphYaml(`
name: tool-aware
steps:
  - id: read_note
    tool: fs.read
    inputs:
      path: note.txt
      repo_root: ${JSON.stringify(tempDir)}
  - id: plan
    run:
      type: agent-step
      agent: builder
      task: summarize-note
      outputs:
        summary: object
    allowed_tools:
      - fs.read
      - git.status
    context:
      note: read_note.file_read.data
    artifacts:
      named_emits:
        summary: summary
`),
    );

    const caller: Caller = {
      resolve: async (request) => {
        if (request.kind !== "cognitive_work") {
          return undefined;
        }
        expect(request.work.envelope.allowed_tools).toEqual(["fs.read", "git.status"]);
        expect(request.work.envelope.current_context.map((artifact) => artifact.type)).toEqual(["file_read"]);
        expect(request.work.envelope.provenance).toEqual([
          expect.objectContaining({
            input: "note",
            from_step: "read_note",
            output: "file_read.data",
          }),
        ]);
        return {
          actor: "agent",
          payload: {
            summary: {
              verdict: "read",
              observed: request.work.envelope.inputs.note,
            },
          },
        };
      },
      report: () => undefined,
    };

    try {
      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps.map((step) => step.skill)).toEqual(["fs.read", "run:agent-step"]);
      expect(result.steps[0]?.runner).toBe("tool");
      expect(result.steps[1]?.runner).toBe("agent-step");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves project-local tools before builtin tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-local-tool-"));
    const receiptDir = path.join(tempDir, "receipts");
    const toolDir = path.join(tempDir, ".runx", "tools", "demo", "echo");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      path.join(toolDir, "manifest.json"),
      `${JSON.stringify({
        name: "demo.echo",
        description: "Echo a local tool payload.",
        source: {
          type: "cli-tool",
          command: "node",
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ message: process.env.RUNX_INPUT_MESSAGE || '' }))",
          ],
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

    const chain = validateGraph(
      parseGraphYaml(`
name: local-tool
steps:
  - id: echo
    tool: demo.echo
    inputs:
      message: local-first
`),
    );

    const caller: Caller = {
      resolve: async () => undefined,
      report: () => undefined,
    };

    try {
      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps[0]?.skill).toBe("demo.echo");
      expect(result.steps[0]?.stdout).toContain("local-first");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes structured JSON deterministically through fs.write_json", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-write-json-tool-"));
    const receiptDir = path.join(tempDir, "receipts");

    const chain = validateGraph(
      parseGraphYaml(`
name: write-json
steps:
  - id: write_config
    tool: fs.write_json
    inputs:
      path: config/output.json
      data:
        feature: docs
        enabled: true
  - id: read_back
    tool: fs.read
    inputs:
      path: config/output.json
      repo_root: ${JSON.stringify(tempDir)}
`),
    );

    const caller: Caller = {
      resolve: async () => undefined,
      report: () => undefined,
    };

    try {
      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      expect(JSON.parse(await readFile(path.join(tempDir, "config", "output.json"), "utf8"))).toEqual({
        feature: "docs",
        enabled: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes a file deterministically through fs.delete", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-delete-tool-"));
    const receiptDir = path.join(tempDir, "receipts");
    await writeFile(path.join(tempDir, "stale.txt"), "remove me\n");

    const chain = validateGraph(
      parseGraphYaml(`
name: delete-file
steps:
  - id: delete_stale
    tool: fs.delete
    inputs:
      path: stale.txt
      repo_root: ${JSON.stringify(tempDir)}
`),
    );

    const caller: Caller = {
      resolve: async () => undefined,
      report: () => undefined,
    };

    try {
      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps[0]?.skill).toBe("fs.delete");
      expect(await readFile(path.join(tempDir, "stale.txt"), "utf8").catch(() => null)).toBeNull();
      expect(JSON.parse(result.steps[0]?.stdout ?? "")).toMatchObject({
        path: "stale.txt",
        existed: true,
        deleted: true,
        kind: "file",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads git branch and changed file names through deterministic git tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-git-tools-"));
    const receiptDir = path.join(tempDir, "receipts");
    const caller: Caller = {
      resolve: async () => undefined,
      report: () => undefined,
    };

    try {
      await writeFile(path.join(tempDir, "tracked.txt"), "base\n");
      const git = (args: readonly string[]) => {
        const result = spawnSync("git", ["-C", tempDir, ...args], { encoding: "utf8" });
        if (result.status !== 0) {
          throw new Error(result.stderr || result.stdout);
        }
      };
      git(["init", "-b", "main"]);
      git(["config", "user.email", "tool@test.local"]);
      git(["config", "user.name", "Tool Test"]);
      git(["add", "tracked.txt"]);
      git(["commit", "-m", "init"]);
      await writeFile(path.join(tempDir, "tracked.txt"), "changed\n");

      const chain = validateGraph(
        parseGraphYaml(`
name: git-tools
steps:
  - id: branch
    tool: git.current_branch
    inputs:
      repo_root: ${JSON.stringify(tempDir)}
  - id: diff
    tool: git.diff_name_only
    inputs:
      repo_root: ${JSON.stringify(tempDir)}
      base: HEAD
`),
      );

      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]?.stdout).toContain("\"branch\":\"main\"");
      expect(result.steps[1]?.stdout).toContain("tracked.txt");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("captures CLI help output through cli.capture_help", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-help-tool-"));
    const receiptDir = path.join(tempDir, "receipts");
    const caller: Caller = {
      resolve: async () => undefined,
      report: () => undefined,
    };

    const chain = validateGraph(
      parseGraphYaml(`
name: capture-help
steps:
  - id: help
    tool: cli.capture_help
    inputs:
      command: node
`),
    );

    try {
      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]?.stdout).toContain("Usage:");
      expect(result.steps[0]?.skill).toBe("cli.capture_help");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads spec-declared file contents before bounded fix authoring", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-read-declared-files-"));
    const receiptDir = path.join(tempDir, "receipts");
    const specPath = path.join(tempDir, ".ai", "specs", "active", "task.yaml");
    await mkdir(path.dirname(specPath), { recursive: true });
    await mkdir(path.join(tempDir, "docs"), { recursive: true });
    await writeFile(path.join(tempDir, "docs", "flows.md"), "live flow\n");
    await writeFile(
      specPath,
      `spec_version: "1.1"
task_id: "task"
task:
  title: "Fixture"
  summary: "Read declared files"
  size: "micro"
  risk_level: "low"
  context:
    files_impacted:
      - "docs/flows.md"
phases:
  - id: "phase1"
    name: "Fixture"
    objective: "Read the declared file set"
    changes:
      - file: ".ai/specs/in_progress/task.yaml"
        action: "update"
      - file: "docs/flows.md"
        action: "update"
`,
    );

    const chain = validateGraph(
      parseGraphYaml(`
name: read-declared-files
steps:
  - id: read_spec
    tool: fs.read
    inputs:
      path: .ai/specs/active/task.yaml
      repo_root: ${JSON.stringify(tempDir)}
  - id: load_declared
    tool: spec.read_declared_files
    inputs:
      repo_root: ${JSON.stringify(tempDir)}
    context:
      spec_contents: read_spec.file_read.data.contents
`),
    );

    const caller: Caller = {
      resolve: async () => undefined,
      report: () => undefined,
    };

    try {
      const result = await runLocalGraph({
        graph: chain,
        graphDirectory: tempDir,
        caller,
        env: { ...process.env, RUNX_CWD: tempDir },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const declaredContext = JSON.parse(result.steps[1]?.stdout ?? "") as {
        declared_count: number;
        files: Array<{
          path: string;
          exists: boolean;
          kind: string;
          declared_in: string[];
          contents: string | null;
        }>;
      };
      expect(declaredContext).toMatchObject({
        declared_count: 2,
      });
      expect(declaredContext.files).toEqual([
        {
          path: ".ai/specs/in_progress/task.yaml",
          exists: false,
          kind: "governance_artifact",
          declared_in: ["phases[].changes[].file"],
          contents: null,
        },
        {
          path: "docs/flows.md",
          exists: true,
          kind: "repo_file",
          declared_in: ["phases[].changes[].file", "task.context.files_impacted"],
          contents: "live flow\n",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves structured stdout when harness-backed tools fail", () => {
    const result = spawnSync(process.execPath, [path.resolve("tools/shell/exec/run.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNX_INPUTS_JSON: JSON.stringify({
          command: process.execPath,
          args: ["-e", "process.stderr.write('boom'); process.exit(7)"],
          cwd: process.cwd(),
        }),
      },
      shell: false,
    });

    expect(result.status).toBe(7);
    expect(result.stderr).toBe("boom\n");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: process.execPath,
      stderr: "boom",
      exit_code: 7,
    });
  });
});

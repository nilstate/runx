import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultLocalSkillRuntime } from "../packages/adapters/src/runtime.js";
import { parseRunnerManifestYaml, validateRunnerManifest } from "@runxhq/core/parser";
import { runLocalSkill, type Caller } from "@runxhq/core/runner-local";
import { fetchGitHubIssueThread } from "../tools/thread/github_adapter.mjs";

const scafldBin = process.env.SCAFLD_BIN ?? "/home/kam/dev/scafld/cli/scafld";
const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("issue-to-PR composite skill", () => {
  it("models authored content around native scafld lifecycle, branch, sync, and projection surfaces", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/issue-to-pr/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("chain");
    if (!runner || runner.source.type !== "chain" || !runner.source.chain) {
      throw new Error("issue-to-pr runner must declare an inline chain.");
    }
    const chain = runner.source.chain;

    expect(chain.steps.map((step) => step.id)).toEqual([
      "scafld-init",
      "scafld-new",
      "author-spec",
      "write-spec",
      "read-draft-spec",
      "scafld-validate",
      "scafld-approve",
      "scafld-start",
      "scafld-branch",
      "read-active-spec",
      "read-declared-files",
      "author-fix",
      "write-fix",
      "scafld-exec",
      "scafld-status",
      "scafld-audit",
      "scafld-review-open",
      "read-review-template",
      "reviewer-boundary",
      "write-review",
      "scafld-complete",
      "scafld-summary",
      "scafld-checks",
      "scafld-pr-body",
      "package-pull-request",
      "push-pull-request",
    ]);
    expect(chain.steps.find((step) => step.id === "write-spec")).toMatchObject({
      tool: "fs.write",
      context: {
        path: "scafld-new.state.file",
        contents: "author-spec.spec_contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-draft-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-new.state.file",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-spec")).toMatchObject({
      context: {
        draft_spec_path: "scafld-new.state.file",
        scafld_new_stdout: "scafld-new.stdout",
      },
    });
    expect(runner.inputs.repo_snapshot_path).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.thread_title).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.thread_body).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.thread_locator).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.thread).toMatchObject({
      type: "json",
      required: false,
    });
    expect(runner.inputs.outbox_entry).toMatchObject({
      type: "json",
      required: false,
    });
    expect(runner.inputs.name).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.base).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.bind_current).toMatchObject({
      type: "boolean",
      required: false,
    });
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("repo_snapshot_path");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("thread_title");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("thread_locator");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Never author acceptance criteria that depend on git history");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("HEAD~1");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Never write an exhaustive whole-tree assertion");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain(".ai/reviews/<task_id>.md");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("anchor on the exact expected text");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Do not declare any `.ai/specs/drafts/<task_id>.yaml`");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("do not declare scafld-managed control-plane artifacts");
    expect(chain.steps.find((step) => step.id === "scafld-branch")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "branch",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-active-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-start.result.transition.to",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-declared-files")).toMatchObject({
      tool: "spec.read_declared_files",
      context: {
        spec_contents: "read-active-spec.file_read.data.contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "write-fix")).toMatchObject({
      tool: "fs.write_bundle",
      context: {
        files: "author-fix.fix_bundle.data.files",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-fix")).toMatchObject({
      context: {
        spec_path: "scafld-start.result.transition.to",
        spec_file: "read-active-spec.file_read.data",
        spec_contents: "read-active-spec.file_read.data.contents",
        branch_binding: "scafld-branch.result.origin.git",
        sync_state: "scafld-branch.result.sync",
        declared_file_context: "read-declared-files.declared_file_context.data",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("fix_bundle.files");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("repo_snapshot_path");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("declared_file_context");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("branch_binding and sync_state");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("fix_bundle.status: blocked");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("do not recreate or hand-edit the");
    expect(chain.steps.find((step) => step.id === "scafld-status")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "status",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-review-template")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-review-open.result.review_file",
      },
    });
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-review",
      },
      context: {
        review_file: "scafld-review-open.result.review_file",
        review_prompt: "scafld-review-open.result.review_prompt",
        review_required_sections: "scafld-review-open.result.required_sections",
        review_file_contents: "read-review-template.file_read.data.contents",
        fix_bundle: "author-fix.fix_bundle.data",
        written_files: "write-fix.file_bundle_write.data.files",
        spec_contents: "read-active-spec.file_read.data.contents",
        status_snapshot: "scafld-status.result",
      },
    });
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("fix_bundle.files");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("schema_version: 3");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("reviewed_at");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("reviewed_head");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("pass_with_issues");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("review_file_contents");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("status snapshot");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("## Review N — <timestamp>");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("Do not rename");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("write the literal `None.`");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("Do not write placeholder bullets");
    expect(chain.steps.find((step) => step.id === "write-review")).toMatchObject({
      tool: "fs.write",
      context: {
        path: "scafld-review-open.result.review_file",
        contents: "reviewer-boundary.review_contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "scafld-summary")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "summary",
      },
    });
    expect(chain.steps.find((step) => step.id === "scafld-checks")).toMatchObject({
      tool: "scafld.capture_checks",
    });
    expect(chain.steps.find((step) => step.id === "scafld-pr-body")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "pr-body",
      },
    });
    expect(chain.steps.find((step) => step.id === "package-pull-request")).toMatchObject({
      tool: "outbox.build_pull_request",
      context: {
        summary_projection: "scafld-summary.result",
        checks_projection: "scafld-checks.result",
        pr_body_projection: "scafld-pr-body.result",
        completion_result: "scafld-complete.result",
        completion_state: "scafld-complete.state",
        status_snapshot: "scafld-status.result",
      },
    });
    expect(chain.steps.find((step) => step.id === "push-pull-request")).toMatchObject({
      tool: "thread.push_outbox",
      context: {
        outbox_entry: "package-pull-request.outbox_entry.data",
        draft_pull_request: "package-pull-request.draft_pull_request.data",
      },
      inputs: {
        next_status: "draft",
      },
    });
    expect(chain.policy?.transitions).toEqual([
      {
        to: "write-fix",
        field: "author-fix.fix_bundle.data.files",
        notEquals: [],
      },
    ]);
  });

  it.skipIf(!existsSync(scafldBin))("completes the canonical issue-to-pr lane through authored spec, fix, and review outputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-skill-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-skill-fixture";
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload: await answerForIssueToPrStep(tempDir, taskId, request),
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "github://example/repo/issues/123",
          target_repo: "fixtures/repo",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: `.ai/specs/drafts/${taskId}.yaml`,
          scafld_bin: scafldBin,
        },
        caller,
        adapters: runtime.adapters,
        env: runtime.env,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      if (result.status !== "success") {
        throw new Error(JSON.stringify(result, null, 2));
      }
      expect(result.status).toBe("success");
      expect(result.receipt.kind).toBe("graph_execution");
      if (result.receipt.kind !== "graph_execution") {
        return;
      }
      expect(result.receipt.graph_name).toBe("issue-to-pr");
      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        outbox_entry: {
          kind: "pull_request",
          status: "proposed",
          entry_id: `pull_request:${taskId}`,
          metadata: {
            action: "create",
            repo: "fixtures/repo",
            branch: taskId,
            base: "main",
            review_verdict: "pass",
            check_status: "failure",
            push_ready: false,
          },
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: false,
          task_id: taskId,
          target: {
            repo: "fixtures/repo",
            branch: taskId,
            base: "main",
          },
          pull_request: {
            title: "Fixture thread-driven change",
            body_markdown: expect.stringContaining("# Fixture thread-driven change"),
            is_draft: true,
          },
          governance: {
            review_verdict: "pass",
            blocking_count: 0,
            non_blocking_count: 0,
            sync_status: "drift",
          },
        },
        push: {
          status: "skipped",
          reason: "thread not provided",
        },
      });
      expect(result.receipt.steps.map((step) => [step.step_id, step.status])).toEqual([
        ["scafld-init", "success"],
        ["scafld-new", "success"],
        ["author-spec", "success"],
        ["write-spec", "success"],
        ["read-draft-spec", "success"],
        ["scafld-validate", "success"],
        ["scafld-approve", "success"],
        ["scafld-start", "success"],
        ["scafld-branch", "success"],
        ["read-active-spec", "success"],
        ["read-declared-files", "success"],
        ["author-fix", "success"],
        ["write-fix", "success"],
        ["scafld-exec", "success"],
        ["scafld-status", "success"],
        ["scafld-audit", "success"],
        ["scafld-review-open", "success"],
        ["read-review-template", "success"],
        ["reviewer-boundary", "success"],
        ["write-review", "success"],
        ["scafld-complete", "success"],
        ["scafld-summary", "success"],
        ["scafld-checks", "success"],
        ["scafld-pr-body", "success"],
        ["package-pull-request", "success"],
        ["push-pull-request", "success"],
      ]);
      expect(existsSync(path.join(tempDir, ".ai", "specs", "active", `${taskId}.yaml`))).toBe(false);
      expect(existsSync(path.join(tempDir, ".ai", "specs", "archive", "2026-04", `${taskId}.yaml`))).toBe(true);
      expect(runChecked("git", ["branch", "--show-current"], tempDir)).toBe(taskId);
      expect(await readFile(path.join(tempDir, "app.txt"), "utf8")).toBe("fixed\n");
      expect(await readFile(path.join(tempDir, "notes.md"), "utf8")).toBe("governed\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!existsSync(scafldBin))("pushes the packaged pull_request outbox entry through a file-backed thread adapter and rehydrates provider state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-provider-loop-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-provider-loop-fixture";
    const statePath = path.join(runtime.paths.root, "provider", "thread.json");
    const fileBackedThread = {
      kind: "runx.thread.v1",
      adapter: {
        type: "file",
        adapter_ref: statePath,
      },
      thread_kind: "work_item",
      thread_locator: "local://provider/issues/123",
      canonical_uri: "https://example.test/issues/123",
      entries: [],
      decisions: [],
      outbox: [],
      source_refs: [],
    };
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload: await answerForIssueToPrStep(tempDir, taskId, request),
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify(fileBackedThread, null, 2)}\n`);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "local://provider/issues/123",
          target_repo: "fixtures/repo",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: `.ai/specs/drafts/${taskId}.yaml`,
          scafld_bin: scafldBin,
          thread: fileBackedThread,
        },
        caller,
        adapters: runtime.adapters,
        env: runtime.env,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        outbox_entry: {
          kind: "pull_request",
          entry_id: `pull_request:${taskId}`,
          status: "draft",
          thread_locator: "local://provider/issues/123",
          locator: expect.stringContaining("#outbox/pull_request%3A"),
        },
        draft_pull_request: {
          action: "create",
          task_id: taskId,
        },
        thread: {
          adapter: {
            type: "file",
            adapter_ref: statePath,
          },
          thread_locator: "local://provider/issues/123",
          outbox: [
            {
              entry_id: `pull_request:${taskId}`,
              kind: "pull_request",
              status: "draft",
              thread_locator: "local://provider/issues/123",
            },
          ],
        },
        push: {
          status: "pushed",
          adapter: {
            type: "file",
            adapter_ref: statePath,
          },
        },
      });
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        outbox: [
          {
            entry_id: `pull_request:${taskId}`,
            kind: "pull_request",
            status: "draft",
            thread_locator: "local://provider/issues/123",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!existsSync(scafldBin))("pushes the governed lane upstream through a GitHub-backed thread adapter and rehydrates the provider thread for the next run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-github-loop-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-github-loop-fixture";
    const remote = path.join(runtime.paths.root, "remote.git");
    const fakeGh = path.join(runtime.paths.root, "fake-gh.mjs");
    const fakeState = path.join(runtime.paths.root, "fake-gh-state.json");
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload: await answerForIssueToPrStep(tempDir, taskId, request),
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      await initGitHubRemote(tempDir, remote);
      await writeFakeGitHubState(fakeState, {
        issue: {
          number: 123,
          title: "Fixture thread-driven change",
          body: "Apply a bounded fixture docs update.",
          url: "https://github.com/example/repo/issues/123",
          state: "OPEN",
          createdAt: "2026-04-22T00:00:00Z",
          updatedAt: "2026-04-22T00:00:00Z",
          author: {
            login: "auscaster",
          },
          comments: [],
          labels: [],
          closedByPullRequestsReferences: [],
        },
        pulls: [],
        nextPullNumber: 77,
      });
      await writeFakeGhScript(fakeGh);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "github://example/repo/issues/123",
          target_repo: "example/repo",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: `.ai/specs/drafts/${taskId}.yaml`,
          scafld_bin: scafldBin,
          thread: {
            kind: "runx.thread.v1",
            adapter: {
              type: "github",
              adapter_ref: "example/repo#issue/123",
            },
            thread_kind: "work_item",
            thread_locator: "github://example/repo/issues/123",
            canonical_uri: "https://github.com/example/repo/issues/123",
            entries: [],
            decisions: [],
            outbox: [],
            source_refs: [],
          },
        },
        caller,
        adapters: runtime.adapters,
        env: {
          ...runtime.env,
          RUNX_GH_BIN: fakeGh,
          RUNX_FAKE_GH_STATE: fakeState,
        },
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        outbox_entry: {
          entry_id: "pr-77",
          kind: "pull_request",
          locator: "https://github.com/example/repo/pull/77",
          status: "draft",
          thread_locator: "github://example/repo/issues/123",
        },
        thread: {
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          outbox: [
            {
              entry_id: "pr-77",
              locator: "https://github.com/example/repo/pull/77",
              status: "draft",
            },
          ],
        },
        push: {
          status: "pushed",
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          pull_request: {
            number: "77",
            url: "https://github.com/example/repo/pull/77",
          },
        },
      });
      expect(runChecked("git", ["--git-dir", remote, "branch", "--list", taskId], runtime.paths.root)).toContain(taskId);
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        pulls: [
          {
            number: 77,
            title: "Fixture thread-driven change",
            url: "https://github.com/example/repo/pull/77",
            body: expect.stringContaining("Source issue: https://github.com/example/repo/issues/123"),
            headRefName: taskId,
            baseRefName: "main",
            isDraft: true,
            state: "OPEN",
          },
        ],
      });

      const rehydratedState = fetchGitHubIssueThread({
        adapterRef: "example/repo#issue/123",
        env: {
          ...process.env,
          RUNX_GH_BIN: fakeGh,
          RUNX_FAKE_GH_STATE: fakeState,
        },
        cwd: tempDir,
      });
      expect(rehydratedState.outbox).toEqual([
        expect.objectContaining({
          entry_id: "pr-77",
          locator: "https://github.com/example/repo/pull/77",
          status: "draft",
          thread_locator: "github://example/repo/issues/123",
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!existsSync(scafldBin))("refreshes an existing pull_request outbox entry from thread through the full issue-to-pr lane", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-refresh-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-refresh-fixture";
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload: await answerForIssueToPrStep(tempDir, taskId, request),
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "github://example/repo/issues/123",
          target_repo: "fixtures/repo",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: `.ai/specs/drafts/${taskId}.yaml`,
          scafld_bin: scafldBin,
          thread: {
            kind: "runx.thread.v1",
            adapter: {
              type: "github",
            },
            thread_kind: "work_item",
            thread_locator: "github://example/repo/issues/123",
            canonical_uri: "https://github.com/example/repo/issues/123",
            entries: [],
            decisions: [],
            outbox: [
              {
                entry_id: "pr-77",
                kind: "pull_request",
                locator: "https://github.com/example/repo/pull/77",
                status: "draft",
                thread_locator: "github://example/repo/issues/123",
              },
            ],
            source_refs: [],
          },
        },
        caller,
        adapters: runtime.adapters,
        env: runtime.env,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        outbox_entry: {
          entry_id: "pr-77",
          kind: "pull_request",
          locator: "https://github.com/example/repo/pull/77",
          status: "draft",
          thread_locator: "github://example/repo/issues/123",
          metadata: {
            action: "refresh",
            repo: "fixtures/repo",
            branch: taskId,
            base: "main",
            check_status: "failure",
            push_ready: false,
          },
        },
        draft_pull_request: {
          action: "refresh",
          push_ready: false,
          thread: {
            thread_locator: "github://example/repo/issues/123",
            canonical_uri: "https://github.com/example/repo/issues/123",
          },
          target: {
            repo: "fixtures/repo",
            branch: taskId,
            base: "main",
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!existsSync(scafldBin))("halts before write-fix when author-fix explicitly reports blocked after declared-file preload", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-blocked-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-blocked-fixture";
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload:
                request.id === "agent_step.issue-to-pr-author-spec.output"
                  ? {
                      spec_contents: buildIssueToPrSpec(taskId),
                    }
                  : request.id === "agent_step.issue-to-pr-apply-fix.output"
                    ? {
                        fix_bundle: {
                          status: "blocked",
                          reason: "Need one more grounded read before editing.",
                          files: [],
                        },
                      }
                    : undefined,
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Blocked fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "github://example/repo/issues/456",
          target_repo: "fixtures/repo",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: `.ai/specs/drafts/${taskId}.yaml`,
          scafld_bin: scafldBin,
        },
        caller,
        adapters: runtime.adapters,
        env: runtime.env,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }

      expect(result.reasons).toEqual([
        "transition policy blocked step 'write-fix': expected author-fix.fix_bundle.data.files != []",
      ]);
      expect(result.receipt).toBeUndefined();
      expect(await readFile(path.join(tempDir, "app.txt"), "utf8")).toBe("base\n");
      expect(await readFile(path.join(tempDir, "notes.md"), "utf8")).toBe("draft\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!existsSync(scafldBin))("opens a native scafld review payload, accepts a caller-filled review file, and completes from native JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-json-fixture";

    try {
      await initScafldRepo(tempDir);
      await writeActiveSpec(tempDir, taskId);

      const reviewResult = await runScafldSkill(tempDir, runtime, {
        command: "review",
        task_id: taskId,
      });
      expect(reviewResult.status).toBe("success");
      if (reviewResult.status !== "success") {
        return;
      }

      const reviewOpen = JSON.parse(reviewResult.execution.stdout) as {
        command: string;
        state: {
          status: string;
          review_round: number;
        };
        result: {
          review_file: string;
          review_prompt: string;
        };
      };
      expect(reviewOpen).toMatchObject({
        command: "review",
        state: {
          status: "in_progress",
          review_round: 1,
        },
        result: {
          review_file: `.ai/reviews/${taskId}.md`,
        },
      });
      expect(reviewOpen.result.review_prompt).toContain("ADVERSARIAL REVIEW");

      await writePassingReviewFile(path.join(tempDir, reviewOpen.result.review_file), taskId);

      const completeResult = await runScafldSkill(tempDir, runtime, {
        command: "complete",
        task_id: taskId,
      });
      expect(completeResult.status).toBe("success");
      if (completeResult.status !== "success") {
        return;
      }

      expect(JSON.parse(completeResult.execution.stdout)).toMatchObject({
        command: "complete",
        task_id: taskId,
        state: {
          status: "completed",
          review_verdict: "pass",
        },
        result: {
          archive_path: `.ai/specs/archive/2026-04/${taskId}.yaml`,
          blocking_count: 0,
          non_blocking_count: 0,
          review_file: `.ai/reviews/${taskId}.md`,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runScafldSkill(
  fixture: string,
  runtime: Awaited<ReturnType<typeof createExternalRuntime>>,
  inputs: Readonly<Record<string, unknown>>,
) {
  return await runLocalSkill({
    skillPath: path.resolve("skills/scafld"),
    runner: "scafld-cli",
    inputs: {
      ...inputs,
      fixture,
      scafld_bin: scafldBin,
    },
    caller,
    adapters: runtime.adapters,
    env: runtime.env,
    receiptDir: runtime.paths.receiptDir,
    runxHome: runtime.paths.runxHome,
  });
}

async function initScafldRepo(repo: string): Promise<void> {
  runChecked("git", ["init", "-b", "main"], repo);
  runChecked("git", ["config", "user.email", "smoke@example.com"], repo);
  runChecked("git", ["config", "user.name", "Smoke Test"], repo);
  runChecked(scafldBin, ["init"], repo);
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await writeFile(path.join(repo, "notes.md"), "draft\n");
  runChecked("git", ["add", "."], repo);
  runChecked("git", ["commit", "-m", "init"], repo);
}

async function initGitHubRemote(repo: string, remotePath: string): Promise<void> {
  runChecked("git", ["init", "--bare", remotePath], path.dirname(remotePath));
  runChecked("git", ["remote", "add", "origin", remotePath], repo);
}

async function writeFakeGitHubState(statePath: string, state: Readonly<Record<string, unknown>>): Promise<void> {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeFakeGhScript(scriptPath: string): Promise<void> {
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.RUNX_FAKE_GH_STATE;
if (!statePath) {
  throw new Error("RUNX_FAKE_GH_STATE is required.");
}

const state = JSON.parse(readFileSync(statePath, "utf8"));

if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify(state.issue));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(state.pulls));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const repo = readFlag(args, "--repo");
  const head = readFlag(args, "--head");
  const base = readFlag(args, "--base");
  const title = readFlag(args, "--title");
  const body = readFlag(args, "--body");
  const number = state.nextPullNumber++;
  const pull = {
    number,
    repo,
    title,
    body,
    url: \`https://github.com/\${repo}/pull/\${number}\`,
    state: "OPEN",
    isDraft: true,
    headRefName: head,
    baseRefName: base,
    updatedAt: "2026-04-22T01:00:00Z",
  };
  state.pulls.push(pull);
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stdout.write(\`\${pull.url}\\n\`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "edit") {
  const pull = findPull(state.pulls, args[2]);
  pull.title = readFlag(args, "--title");
  pull.body = readFlag(args, "--body");
  pull.baseRefName = readFlag(args, "--base") || pull.baseRefName;
  pull.updatedAt = "2026-04-22T01:00:00Z";
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const pull = findPull(state.pulls, args[2]);
  process.stdout.write(JSON.stringify(pull));
  process.exit(0);
}

throw new Error(\`unsupported fake gh command: \${args.join(" ")}\`);

function findPull(pulls, ref) {
  const number = String(ref).match(/(\\d+)/)?.[1];
  const pull = pulls.find((candidate) => String(candidate.number) === number || candidate.url === ref);
  if (!pull) {
    throw new Error(\`unknown pull request: \${ref}\`);
  }
  return pull;
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : "";
}
`,
    { mode: 0o755 },
  );
}

async function writeActiveSpec(repo: string, taskId: string): Promise<void> {
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await mkdir(path.join(repo, ".ai", "specs", "active"), { recursive: true });
  await writeFile(
    path.join(repo, ".ai", "specs", "active", `${taskId}.yaml`),
    `spec_version: "1.1"
task_id: "${taskId}"
created: "2026-04-10T00:00:00Z"
updated: "2026-04-10T00:00:00Z"
status: "in_progress"

task:
  title: "Issue to PR JSON Fixture"
  summary: "Fixture for runx scafld review handoff"
  size: "small"
  risk_level: "low"

phases:
  - id: "phase1"
    name: "Fixture"
    objective: "Provide one passing acceptance criterion"
    changes:
      - file: "app.txt"
        action: "update"
        content_spec: "Fixture file exists"
    acceptance_criteria:
      - id: "ac1_1"
        type: "custom"
        description: "app.txt exists"
        command: "test -f app.txt"
        expected: "exit code 0"
        result: "pass"

planning_log:
  - timestamp: "2026-04-10T00:00:00Z"
    actor: "test"
    summary: "Fixture spec"
`,
  );
}

async function createExternalRuntime(prefix: string) {
  return await createDefaultLocalSkillRuntime({
    prefix,
    env: process.env,
  });
}

async function answerForIssueToPrStep(
  repo: string,
  taskId: string,
  request: Parameters<Caller["resolve"]>[0],
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const requestId = request.id;
  const requestInputs = request.kind === "cognitive_work"
    ? (request.work.envelope.inputs as Readonly<Record<string, unknown>>)
    : {};
  if (requestId === "agent_step.issue-to-pr-author-spec.output") {
    return {
      spec_contents: buildIssueToPrSpec(taskId),
    };
  }
  if (requestId === "agent_step.issue-to-pr-apply-fix.output") {
    return {
      fix_bundle: {
        summary: "Apply the bounded fixture fix declared in the spec across both tracked files.",
        files: [
          {
            path: "app.txt",
            contents: "fixed\n",
          },
          {
            path: "notes.md",
            contents: "governed\n",
          },
        ],
      },
    };
  }
  if (requestId === "agent_step.issue-to-pr-review.output") {
    const reviewFile = String(requestInputs.review_file ?? `.ai/reviews/${taskId}.md`);
    const reviewFileContents = typeof requestInputs.review_file_contents === "string"
      ? requestInputs.review_file_contents
      : await readFile(path.join(repo, reviewFile), "utf8");
    return {
      review_contents: buildPassingReviewContents(reviewFileContents, taskId),
    };
  }
  return undefined;
}

function buildIssueToPrSpec(taskId: string): string {
  return `spec_version: "1.1"
task_id: "${taskId}"
created: "2026-04-10T00:00:00Z"
updated: "2026-04-10T00:00:00Z"
status: "draft"

task:
  title: "Fixture thread-driven change"
  summary: "Apply one bounded fixture fix and archive the completed review."
  size: "micro"
  risk_level: "low"
  context:
    packages:
      - "fixture"
    invariants:
      - "bounded_scope"
  objectives:
    - "Replace the fixture app contents with the fixed output."
    - "Update the companion notes file so the bounded fixture change stays consistent."
  touchpoints:
    - area: "fixture"
      description: "Update the tracked fixture files and keep the scafld spec declared."
  acceptance:
    definition_of_done:
      - id: "dod1"
        description: "app.txt contains the fixed output"
        status: "pending"
      - id: "dod2"
        description: "notes.md contains the governed output"
        status: "pending"
    validation:
      - id: "v1"
        type: "test"
        description: "app.txt contains the fixed output"
        command: "grep -q '^fixed$' app.txt"
        expected: "exit code 0"
      - id: "v2"
        type: "test"
        description: "notes.md contains the governed output"
        command: "grep -q '^governed$' notes.md"
        expected: "exit code 0"

planning_log:
  - timestamp: "2026-04-10T00:00:00Z"
    actor: "test"
    summary: "Fixture spec authored by the issue-to-pr lane"

phases:
  - id: "phase1"
    name: "Apply fixture fix"
    objective: "Write the bounded file change and validate it"
    changes:
      - file: "app.txt"
        action: "update"
        content_spec: |
          Replace the fixture contents with the fixed output.
      - file: "notes.md"
        action: "update"
        content_spec: |
          Keep the companion notes file aligned with the bounded fixture fix.
    acceptance_criteria:
      - id: "ac1_1"
        type: "test"
        description: "app.txt contains the fixed output"
        command: "grep -q '^fixed$' app.txt"
        expected: "exit code 0"
      - id: "ac1_2"
        type: "test"
        description: "notes.md contains the governed output"
        command: "grep -q '^governed$' notes.md"
        expected: "exit code 0"
    status: "pending"

rollback:
  strategy: "per_phase"
  commands:
    phase1: "git checkout HEAD -- app.txt notes.md"
`;
}

async function writePassingReviewFile(reviewPath: string, taskId: string): Promise<void> {
  const scaffold = await readFile(reviewPath, "utf8");
  await writeFile(reviewPath, buildPassingReviewContents(scaffold, taskId));
}

function buildPassingReviewContents(scaffold: string, taskId: string): string {
  const metadataMatch = scaffold.match(/### Metadata\s+```json\s+([\s\S]*?)\s+```/);
  if (!metadataMatch) {
    throw new Error(`missing metadata scaffold for ${taskId}`);
  }
  const metadata = JSON.parse(metadataMatch[1]!) as {
    round_status?: string;
    reviewer_mode?: string;
    reviewer_session?: string;
    reviewed_at?: string;
    override_reason?: string | null;
    pass_results?: Record<string, string>;
  };
  metadata.round_status = "completed";
  metadata.reviewer_mode = "executor";
  metadata.reviewer_session = "";
  metadata.reviewed_at = "2026-04-10T00:00:00Z";
  metadata.override_reason = null;
  metadata.pass_results = {
    ...(metadata.pass_results ?? {}),
    spec_compliance: "pass",
    scope_drift: "pass",
    regression_hunt: "pass",
    convention_check: "pass",
    dark_patterns: "pass",
  };

  const roundHeadingMatch = scaffold.match(/(^## Review \d+ — [^\n]+$)/m);
  if (!roundHeadingMatch) {
    throw new Error(`missing review round heading for ${taskId}`);
  }
  const prefix = scaffold.slice(0, scaffold.indexOf(roundHeadingMatch[1]!)).trimEnd();

  return `${prefix}

${roundHeadingMatch[1]}

### Metadata
\`\`\`json
${JSON.stringify(metadata, null, 2)}
\`\`\`

### Pass Results
- spec_compliance: PASS
- scope_drift: PASS
- regression_hunt: PASS
- convention_check: PASS
- dark_patterns: PASS

### Regression Hunt

No issues found. Checked app.txt:1 and notes.md:1 for bounded fixture behavior.

### Convention Check

No issues found. Reviewed the fixture lane against the declared scafld workflow contract.

### Dark Patterns

No issues found. Checked the bounded fixture paths for hidden state or undeclared writes.

### Blocking

None.

### Non-blocking

None.

### Verdict

pass
`;
}

function runChecked(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

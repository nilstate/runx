import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const toolPath = path.resolve("tools/outbox/build_pull_request/run.mjs");

describe("outbox.build_pull_request tool", () => {
  it("packages native scafld v2 handoff surfaces into a proposed pull_request outbox entry", () => {
    const result = runTool({
      task_id: "fixture-task",
      thread_title: "Fix fixture behavior",
      thread_locator: "github://example/repo/issues/123",
      target_repo: "example/repo",
      harness_context: {
        harness: {
          schema: "runx.harness.v1",
          harness_id: "harness_fixture_123",
          state: "running",
        },
        signal: {
          schema: "runx.signal.v1",
          signal_id: "sig_fixture_123",
          signal_type: "operator_note",
          fingerprint: {
            value: "sha256:fixture-123",
          },
        },
        decision: {
          schema: "runx.decision.v1",
          decision_id: "dec_fixture_123",
          choice: "open",
        },
      },
      handoff_markdown: "# Handoff: Fix fixture behavior\n\nStatus: completed\nNext: none\n",
      thread_body: "Fix the runtime behavior and add focused regression coverage.",
      build_result: {
        status: "review",
        passed: 2,
        failed: 0,
      },
      review_result: {
        verdict: "pass_with_issues",
        findings: [
          {
            id: "non-blocking-fixture",
            severity: "low",
            blocks_completion: false,
          },
        ],
      },
      completion_result: {
        status: "completed",
        title: "Fix fixture behavior",
        review: {
          verdict: "pass_with_issues",
        },
      },
      current_branch: {
        branch: "main",
      },
      branch: "fixture-task",
      fix_bundle: {
        files: [
          { path: "app.rb", contents: "fixed\n" },
          { path: "spec/app_spec.rb", contents: "expect(app).to be_fixed\n" },
          { path: "notes.md", contents: "governed\n" },
        ],
      },
      base: "main",
      status_snapshot: {
        status: "completed",
        session_ok: true,
      },
    });

    expect(result.outbox_entry).toMatchObject({
      entry_id: "pull_request:fixture-task",
      kind: "pull_request",
      status: "proposed",
      thread_locator: "github://example/repo/issues/123",
      title: "Fix fixture behavior",
      metadata: {
        action: "create",
        repo: "example/repo",
        branch: "fixture-task",
        base: "main",
        harness_context: {
          harness_id: "harness_fixture_123",
          state: "running",
        },
        review_verdict: "pass_with_issues",
        check_status: "success",
        push_ready: true,
        changed_files: ["app.rb", "spec/app_spec.rb", "notes.md"],
        quality_gate: {
          status: "passed",
          required_regression_coverage: true,
          validation_check_count: 2,
        },
        dedupe: {
          strategy: "branch",
          key: "example/repo:fixture-task",
          result: "created",
        },
        source_thread: {
          required: true,
          publish_mode: "reply",
          missing_behavior: "fail_closed",
          thread_locator: "github://example/repo/issues/123",
        },
        story_milestones: [
          "accepted",
          "triaged",
          "spec_ready",
          "build_started",
          "review_requested",
          "change_request_created",
          "human_gate",
          "final_outcome",
        ],
      },
    });
    expect(result.draft_pull_request).toMatchObject({
      schema_version: "runx.pull-request-draft.v1",
      action: "create",
      push_ready: true,
      task_id: "fixture-task",
      target: {
        repo: "example/repo",
        branch: "fixture-task",
        base: "main",
      },
      harness_context: {
        harness_id: "harness_fixture_123",
        state: "running",
        decision: {
          choice: "open",
        },
      },
      pull_request: {
        title: "Fix fixture behavior",
        body_markdown: expect.stringContaining("## Human Merge Gate"),
        is_draft: true,
      },
      governance: {
        review_verdict: "pass_with_issues",
        blocking_count: 0,
        non_blocking_count: 1,
        sync_status: "ok",
        build_passed: 2,
        build_failed: 0,
        changed_files: ["app.rb", "spec/app_spec.rb", "notes.md"],
        quality_gate: {
          required_regression_coverage: true,
          test_file_count: 1,
        },
      },
      thread: {
        thread_locator: "github://example/repo/issues/123",
      },
    });
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Source Thread");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Source Context");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Changed Files");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("spec/app_spec.rb");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## scafld Handoff");
    expect(result.outbox_entry.metadata).toMatchObject({
      human_merge_gate: "required",
      provider_outcome_observation: "provider_state_update",
    });
  });

  it("refreshes an existing pull_request outbox entry from thread", () => {
    const result = runTool({
      task_id: "fixture-task",
      target_repo: "example/repo",
      handoff_markdown: "# Handoff: Refresh fixture behavior\n\nStatus: completed\nNext: none\n",
      build_result: {
        passed: 1,
        failed: 0,
      },
      review_result: {
        verdict: "pass",
      },
      completion_result: {
        status: "completed",
        title: "Refresh fixture behavior",
        review: {
          verdict: "pass",
        },
      },
      current_branch: {
        branch: "fixture-task",
      },
      base: "main",
      thread: {
        kind: "runx.thread.v1",
        adapter: {
          type: "github",
        },
        thread_kind: "signal",
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
    });

    expect(result.outbox_entry).toMatchObject({
      entry_id: "pr-77",
      kind: "pull_request",
      locator: "https://github.com/example/repo/pull/77",
      status: "draft",
      thread_locator: "github://example/repo/issues/123",
      metadata: {
        action: "refresh",
        push_ready: true,
        dedupe: {
          strategy: "branch",
          key: "example/repo:fixture-task",
          result: "reused",
          existing_entry_id: "pr-77",
          existing_locator: "https://github.com/example/repo/pull/77",
        },
      },
    });
    expect(result.draft_pull_request).toMatchObject({
      action: "refresh",
      target: {
        branch: "fixture-task",
        base: "main",
      },
      thread: {
        thread_locator: "github://example/repo/issues/123",
      },
    });
  });

  it("redacts local paths from reviewer pull request bodies", () => {
    const result = runTool({
      task_id: "fixture-task",
      thread_title: "Fix fixture behavior",
      thread_locator: "github://example/repo/issues/123",
      target_repo: "example/repo",
      handoff_markdown: "RUNX_BIN=/Users/kam/dev/runx/dist/index.js\n\nChanged /tmp/workspace/app.txt",
      build_result: {
        passed: 1,
        failed: 0,
      },
      review_result: {
        verdict: "pass",
      },
      completion_result: {
        status: "completed",
        title: "Fix fixture behavior",
      },
      current_branch: {
        branch: "fixture-task",
      },
      base: "main",
    });

    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("/Users/kam");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("/tmp/workspace");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("RUNX_BIN=");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Detailed handoff omitted from public markdown");
  });

  it("rejects unsafe changed-file metadata before packet creation", () => {
    const fakeGithubTokenPath = `docs/${["ghp", "123456789012345678901234567890123456"].join("_")}.txt`;
    for (const filePath of [
      "/Users/kam/dev/runx/workspace/app.txt",
      fakeGithubTokenPath,
    ]) {
      const result = runToolRaw({
        ...minimalPullRequestInputs(),
        fix_bundle: {
          files: [
            {
              path: filePath,
              contents: "unsafe metadata should not be emitted\n",
            },
          ],
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(filePath);
      expect(result.stdout).not.toContain(filePath);
      if (filePath.startsWith("/")) {
        expect(result.stderr).toContain("changed_files must not contain local filesystem paths");
      } else {
        expect(result.stderr).toContain("changed_files must not contain secret material");
      }
    }
  });

  it("fails closed when requested coverage is missing from a code PR", () => {
    const result = runToolRaw({
      ...minimalPullRequestInputs(),
      thread_body: "Fix the bug and add focused request/service coverage.",
      build_result: {
        passed: 1,
        failed: 0,
      },
      fix_bundle: {
        files: [
          {
            path: "app/controllers/api/v1/my/subscription_controller.rb",
            contents: "class Api::V1::My::SubscriptionController; end\n",
          },
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requested regression coverage");
    expect(result.stderr).not.toContain("/tmp/");
  });

  it("fails closed when a code PR has neither scafld validation checks nor tests", () => {
    const result = runToolRaw({
      ...minimalPullRequestInputs(),
      build_result: {
        passed: 0,
        failed: 0,
      },
      fix_bundle: {
        files: [
          {
            path: "app/controllers/api/v1/my/subscription_controller.rb",
            contents: "class Api::V1::My::SubscriptionController; end\n",
          },
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("either scafld validation evidence or a test/spec file");
  });

  it("allows tested code PRs when scafld validation counts are unavailable", () => {
    const result = runTool({
      ...minimalPullRequestInputs(),
      build_result: {
        passed: 0,
        failed: 0,
      },
      fix_bundle: {
        files: [
          {
            path: "app/controllers/api/v1/my/subscription_controller.rb",
            contents: "class Api::V1::My::SubscriptionController; end\n",
          },
          {
            path: "spec/requests/api/v1/my/subscription_spec.rb",
            contents: "RSpec.describe 'subscription checkout' do\nend\n",
          },
        ],
      },
    });

    expect(result.draft_pull_request.governance.quality_gate).toMatchObject({
      status: "passed",
      test_file_count: 1,
      validation_check_count: 0,
      scafld_validation_check_count: 0,
      validation_source: "test_file",
    });
    expect(result.draft_pull_request.governance.quality_gate.summary).toContain("scafld validation count unavailable");
    expect(result.draft_pull_request.governance.quality_gate.summary).toContain("1 test/spec file");
  });

  it("admits PR packaging through operational policy before producing packets", () => {
    const result = runTool({
      ...minimalPullRequestInputs(),
      operational_policy: readPolicyFixture("minimal-single-repo.json"),
      source_id: "github-issues",
      runner_id: "local-review",
      source_thread_locator: "github://example/project/issues/42",
      target_repo: "example/project",
    });

    expect(result.draft_pull_request).toMatchObject({
      operational_policy: {
        policy_id: "single-repo-review-flow",
        source_id: "github-issues",
        target_repo: "example/project",
        runner_id: "local-review",
        owner_route_id: "maintainers",
        source_thread_required: true,
      },
    });
    expect(result.outbox_entry.metadata.operational_policy).toMatchObject({
      policy_id: "single-repo-review-flow",
      dedupe_strategy: "source_fingerprint",
      outcome_close_mode: "when_verified",
    });
  });

  it("fails closed before PR packet creation when operational policy denies admission", () => {
    const result = runToolRaw({
      ...minimalPullRequestInputs(),
      operational_policy: readPolicyFixture("minimal-single-repo.json"),
      source_id: "github-issues",
      runner_id: "local-review",
      target_repo: "example/unknown",
      source_thread_locator: "github://example/project/issues/42",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("operational policy denied pull request packaging");
    expect(result.stderr).toContain("unknown_target_repo");
  });
});

function runTool(inputs: Readonly<Record<string, unknown>>) {
  const result = runToolRaw(inputs);
  expect(result.status).toBe(0);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "tool failed");
  }
  return JSON.parse(result.stdout);
}

function runToolRaw(inputs: Readonly<Record<string, unknown>>) {
  const result = spawnSync("node", [toolPath], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      RUNX_INPUTS_JSON: JSON.stringify(inputs),
    },
  });
  return result;
}

function minimalPullRequestInputs(): Readonly<Record<string, unknown>> {
  return {
    task_id: "fixture-task",
    thread_title: "Fix fixture behavior",
    thread_locator: "github://example/project/issues/42",
    target_repo: "example/project",
    handoff_markdown: "# Handoff: Fix fixture behavior\n\nStatus: completed\nNext: none\n",
    build_result: {
      passed: 1,
      failed: 0,
    },
    review_result: {
      verdict: "pass",
    },
    completion_result: {
      status: "completed",
      title: "Fix fixture behavior",
    },
    current_branch: {
      branch: "fixture-task",
    },
    branch: "fixture-task",
    base: "main",
  };
}

function readPolicyFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve("fixtures/operational-policy", name), "utf8")) as unknown;
}

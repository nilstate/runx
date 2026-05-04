import { spawnSync } from "node:child_process";
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
      handoff_markdown: "# Handoff: Fix fixture behavior\n\nStatus: completed\nNext: none\n",
      build_result: {
        Status: "review",
        Passed: 2,
        Failed: 0,
      },
      review_result: {
        Verdict: "pass_with_issues",
        BlockingCount: 0,
        NonBlockingCount: 1,
      },
      completion_result: {
        Status: "completed",
        Title: "Fix fixture behavior",
        Review: {
          Verdict: "pass_with_issues",
        },
      },
      current_branch: {
        branch: "fixture-task",
      },
      base: "main",
      status_snapshot: {
        Status: "completed",
        SessionOK: true,
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
        review_verdict: "pass_with_issues",
        check_status: "success",
        push_ready: true,
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
      pull_request: {
        title: "Fix fixture behavior",
        body_markdown: "# Handoff: Fix fixture behavior\n\nStatus: completed\nNext: none\n",
        is_draft: true,
      },
      governance: {
        review_verdict: "pass_with_issues",
        blocking_count: 0,
        non_blocking_count: 1,
        sync_status: "ok",
        build_passed: 2,
        build_failed: 0,
      },
      thread: {
        thread_locator: "github://example/repo/issues/123",
      },
    });
  });

  it("refreshes an existing pull_request outbox entry from thread", () => {
    const result = runTool({
      task_id: "fixture-task",
      target_repo: "example/repo",
      handoff_markdown: "# Handoff: Refresh fixture behavior\n\nStatus: completed\nNext: none\n",
      build_result: {
        Passed: 1,
        Failed: 0,
      },
      review_result: {
        Verdict: "pass",
      },
      completion_result: {
        Status: "completed",
        Title: "Refresh fixture behavior",
        Review: {
          Verdict: "pass",
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
});

function runTool(inputs: Readonly<Record<string, unknown>>) {
  const result = spawnSync("node", [toolPath], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      RUNX_INPUTS_JSON: JSON.stringify(inputs),
    },
  });
  expect(result.status).toBe(0);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "tool failed");
  }
  return JSON.parse(result.stdout);
}

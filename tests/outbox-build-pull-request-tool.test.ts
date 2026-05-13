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
      handoff_markdown: [
        "# Handoff: Fix fixture behavior",
        "",
        "Status: completed",
        "Next: none",
        "",
        "## Summary",
        "Fixes the fixture behavior reported in the source issue.",
        "",
        "## Context",
        "The source issue reports a bounded fixture regression in the public workflow.",
        "receipt_id: rx_hidden",
        "",
        "## Scope",
        "- Update the fixture behavior implementation.",
        "- Preserve the existing public contract.",
        "",
        "## Validation",
        "- Targeted test passed.",
        "",
        "## Acceptance",
        "- Source event: entry-8",
        "- Last attempt: entry-9",
        "- Checked at: 2026-05-14T00:00:00Z",
        "- Workflow acceptance passed.",
        "```",
        "private log output should not appear",
        "```",
        "",
        "## Review",
        "Review found one non-blocking follow-up.",
        "",
        "## Rollback",
        "Revert the fixture behavior change.",
        "",
      ].join("\n"),
      build_result: {
        status: "review",
        passed: 2,
        failed: 0,
      },
      review_result: {
        verdict: "pass_with_issues",
        blocking_count: 0,
        non_blocking_count: 1,
      },
      completion_result: {
        status: "completed",
        title: "Fix fixture behavior",
        review: {
          verdict: "pass_with_issues",
        },
      },
      current_branch: {
        branch: "fixture-task",
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
        body_markdown: expect.stringContaining("## Human Merge Gate"),
        is_draft: true,
      },
      engineering_summary_markdown: expect.stringContaining("# Handoff: Fix fixture behavior"),
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
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Review Packet");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Source Context");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("bounded fixture regression");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Scope");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Preserve the existing public contract");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Validation");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Targeted test passed");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Workflow acceptance passed");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Review Context");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Review found one non-blocking follow-up");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("## Rollback");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Target: `example/repo`");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Branch: `fixture-task` -> `main`");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Review: `pass_with_issues`");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("Merge manually");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("rx_hidden");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("Source event");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("Last attempt");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("Checked at");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("entry-9");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toContain("private log output");
    expect(result.draft_pull_request.pull_request.body_markdown).not.toBe(result.draft_pull_request.engineering_summary_markdown);
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

  it("counts native scafld review findings by blocks_completion", () => {
    const result = runTool({
      task_id: "fixture-task",
      thread_title: "Fix fixture behavior",
      thread_locator: "github://example/repo/issues/123",
      target_repo: "example/repo",
      handoff_markdown: "# Handoff: Fix fixture behavior\n\n## Summary\nFix fixture behavior.\n",
      build_result: {
        passed: 2,
        failed: 0,
      },
      review_result: {
        verdict: "pass_with_issues",
        findings: [
          {
            id: "blocking",
            severity: "high",
            blocks_completion: true,
          },
          {
            id: "non-blocking",
            severity: "medium",
            blocks_completion: false,
          },
        ],
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

    expect(result.draft_pull_request.governance).toMatchObject({
      blocking_count: 1,
      non_blocking_count: 1,
    });
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("1 blocking review finding");
    expect(result.draft_pull_request.pull_request.body_markdown).toContain("1 non-blocking review finding");
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

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const toolPath = path.resolve("tools/outbox/build_work_item_story/run.mjs");

describe("outbox.build_work_item_story tool", () => {
  it("packages a durable source-thread story message with PR and merge-gate context", () => {
    const result = runTool({
      task_id: "fixture-task",
      thread_title: "Fix fixture behavior",
      thread_locator: "github://example/repo/issues/123",
      target_repo: "example/repo",
      build_result: {
        passed: 3,
        failed: 0,
      },
      review_result: {
        verdict: "pass",
        blocking_count: 0,
        non_blocking_count: 1,
      },
      completion_result: {
        status: "completed",
        title: "Fix fixture behavior",
      },
      status_snapshot: {
        status: "completed",
      },
      pull_request_outbox_entry: {
        kind: "pull_request",
        locator: "https://github.com/example/repo/pull/77",
        metadata: {
          repo: "example/repo",
          branch: "fixture-task",
          base: "main",
        },
      },
      push_result: {
        pull_request: {
          url: "https://github.com/example/repo/pull/77",
        },
      },
    });

    expect(result.story.data).toMatchObject({
      thread_locator: "github://example/repo/issues/123",
      title: "Fix fixture behavior",
    });
    expect(result.story.data.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "intake" }),
        expect.objectContaining({ kind: "triage" }),
        expect.objectContaining({ kind: "spec" }),
        expect.objectContaining({ kind: "build", status: "passed" }),
        expect.objectContaining({ kind: "review", status: "passed" }),
        expect.objectContaining({ kind: "pull_request", status: "ready" }),
        expect.objectContaining({ kind: "merge_gate", status: "ready" }),
        expect.objectContaining({ kind: "outcome", status: "pending" }),
        expect.objectContaining({ kind: "outcome", status: "pending" }),
      ]),
    );
    expect(result.outbox_entry).toMatchObject({
      entry_id: "message:fixture-task:merge_gate",
      kind: "message",
      status: "proposed",
      thread_locator: "github://example/repo/issues/123",
      metadata: {
        schema_version: "runx.outbox-entry.work-item-story.v1",
        workflow: "issue-to-pr",
        milestone_kind: "merge_gate",
        body_markdown: expect.stringContaining("PR: https://github.com/example/repo/pull/77"),
      },
    });
    expect(result.outbox_entry.metadata.body_markdown).toContain("Human merge gate");
    expect(result.outbox_entry.metadata.body_markdown).toContain("Blocking findings: 0");
    expect(result.outbox_entry.metadata.body_markdown).toContain("No final provider outcome has been observed yet");
  });

  it("packages observed merged provider outcomes as a final source-thread update", () => {
    const result = runTool({
      task_id: "fixture-task",
      thread_title: "Fix fixture behavior",
      thread_locator: "github://example/repo/issues/123",
      build_result: {
        passed: 3,
        failed: 0,
      },
      review_result: {
        verdict: "pass",
      },
      completion_result: {
        status: "completed",
        title: "Fix fixture behavior",
      },
      pull_request_outbox_entry: {
        kind: "pull_request",
        locator: "https://github.com/example/repo/pull/77",
        status: "closed",
        metadata: {
          provider_outcome: "merged",
          merged_at: "2026-05-14T12:00:00Z",
          branch: "fixture-task",
          base: "main",
        },
      },
    });

    expect(result.story.data.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "outcome",
          status: "completed",
          summary: "Provider outcome observed: merged.",
        }),
      ]),
    );
    expect(result.outbox_entry).toMatchObject({
      entry_id: "message:fixture-task:outcome",
      kind: "message",
      title: "Issue-to-PR outcome",
      metadata: {
        milestone_kind: "outcome",
        body_markdown: expect.stringContaining("Provider outcome observed: merged."),
      },
    });
    expect(result.outbox_entry.metadata.body_markdown).toContain("Merged at: 2026-05-14T12:00:00Z");
  });

  it("packages observed closed provider outcomes from refreshed PR state", () => {
    const result = runTool({
      task_id: "fixture-task",
      thread_title: "Fix fixture behavior",
      thread_locator: "github://example/repo/issues/123",
      build_result: {
        passed: 3,
        failed: 0,
      },
      review_result: {
        verdict: "pass",
      },
      completion_result: {
        status: "completed",
        title: "Fix fixture behavior",
      },
      pull_request_outbox_entry: {
        kind: "pull_request",
        locator: "https://github.com/example/repo/pull/77",
        metadata: {
          branch: "fixture-task",
          base: "main",
        },
      },
      push_result: {
        pull_request: {
          url: "https://github.com/example/repo/pull/77",
          state: "CLOSED",
        },
      },
    });

    expect(result.story.data.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "outcome",
          status: "completed",
          summary: "Provider outcome observed: closed.",
        }),
      ]),
    );
    expect(result.outbox_entry).toMatchObject({
      entry_id: "message:fixture-task:outcome",
      metadata: {
        milestone_kind: "outcome",
        body_markdown: expect.stringContaining("Provider state: CLOSED"),
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

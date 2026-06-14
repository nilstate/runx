import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ensureGitHubOutboxEntryMarker,
  ensureGitHubOutboxMetadataMarker,
  ensureGitHubIssueReference,
  gitHubIssueSearchQuery,
  hydrateGitHubIssueThread,
  mapGitHubPullRequestToOutboxEntry,
  parseGitHubIssueRef,
  pushGitHubCreateIssue,
  pushGitHubLifecycleIntent,
  selectPreferredGitHubPullRequest,
} from "../tools/thread/github_adapter.mjs";
import { buildFranticThreadProviderPush } from "../tools/thread/frantic_thread_outbox.mjs";

describe("GitHub thread helper", () => {
  it("parses adapter refs, locators, and canonical issue URLs into one stable shape", () => {
    expect(parseGitHubIssueRef("example/repo#issue/123")).toEqual({
      repo_slug: "example/repo",
      issue_number: "123",
      adapter_ref: "example/repo#issue/123",
      thread_locator: "github://example/repo/issues/123",
      issue_url: "https://github.com/example/repo/issues/123",
    });
    expect(parseGitHubIssueRef("github://example/repo/issues/123").adapter_ref).toBe("example/repo#issue/123");
    expect(parseGitHubIssueRef("https://github.com/example/repo/issues/123").thread_locator).toBe(
      "github://example/repo/issues/123",
    );
  });

  it("adds a single stable source-issue marker to draft PR bodies", () => {
    const issueRef = parseGitHubIssueRef("example/repo#issue/123");
    const body = ensureGitHubIssueReference("# Fix fixture behavior\n\nBody.\n", issueRef);
    expect(body).toContain("Source issue: https://github.com/example/repo/issues/123");
    expect(ensureGitHubIssueReference(body, issueRef)).toBe(body);
    expect(gitHubIssueSearchQuery(issueRef)).toBe(
      "\"https://github.com/example/repo/issues/123\" in:body",
    );
  });

  it("hydrates provider issue state into portable thread with linked pull requests", () => {
    const state = hydrateGitHubIssueThread({
      adapterRef: "example/repo#issue/123",
      issue: {
        number: 123,
        title: "Fix fixture behavior",
        body: "The issue body for the fixture.",
        url: "https://github.com/example/repo/issues/123",
        state: "OPEN",
        createdAt: "2026-04-22T00:00:00Z",
        updatedAt: "2026-04-22T01:00:00Z",
        author: {
          login: "auscaster",
        },
        labels: [
          {
            name: "bug",
          },
        ],
        comments: [
          {
            id: "1001",
            body: "First grounded comment.",
            createdAt: "2026-04-22T00:30:00Z",
            updatedAt: "2026-04-22T00:30:00Z",
            url: "https://github.com/example/repo/issues/123#issuecomment-1001",
            author: {
              login: "maintainer",
            },
          },
        ],
      },
      pullRequests: [
        {
          number: 77,
          repo: "example/repo",
          title: "Fix fixture behavior",
          url: "https://github.com/example/repo/pull/77",
          state: "OPEN",
          isDraft: true,
          headRefName: "issue-123",
          baseRefName: "main",
          updatedAt: "2026-04-22T01:30:00Z",
        },
      ],
    });

    expect(state).toMatchObject({
      kind: "runx.thread.v1",
      adapter: {
        type: "github",
        adapter_ref: "example/repo#issue/123",
      },
      thread_kind: "signal",
      thread_locator: "github://example/repo/issues/123",
      title: "Fix fixture behavior",
      canonical_uri: "https://github.com/example/repo/issues/123",
      entries: [
        {
          entry_id: "issue-123",
          entry_kind: "message",
          actor: {
            actor_id: "auscaster",
          },
        },
        {
          entry_id: "comment-1001",
          entry_kind: "message",
          actor: {
            actor_id: "maintainer",
          },
        },
      ],
      outbox: [
        {
          entry_id: "pr-77",
          kind: "pull_request",
          locator: "https://github.com/example/repo/pull/77",
          status: "draft",
          metadata: {
            number: "77",
            branch: "issue-123",
            base: "main",
          },
        },
      ],
    });
  });

  it("maps runx-marked GitHub issue comments back into message outbox entries", () => {
    const markedBody = ensureGitHubOutboxMetadataMarker(
      ensureGitHubOutboxEntryMarker(
        "I built a private Sourcey preview for this repo.",
        "sourcey-preview-123",
      ),
      {
        build_url: "https://sourcey.com/previews/example/repo/index.html",
        control: {
          workflow: "docs",
          lane: "pr_review",
          task_id: "docs-refresh-example-repo",
        },
        outbox_receipt_id: "receipt-sourcey-preview-123",
      },
    );
    const state = hydrateGitHubIssueThread({
      adapterRef: "example/repo#issue/123",
      issue: {
        number: 123,
        title: "Sourcey adoption thread",
        body: "Issue body.",
        url: "https://github.com/example/repo/issues/123",
        state: "OPEN",
        createdAt: "2026-04-22T00:00:00Z",
        updatedAt: "2026-04-22T01:00:00Z",
        comments: [
          {
            id: "1002",
            body: markedBody,
            createdAt: "2026-04-22T00:30:00Z",
            updatedAt: "2026-04-22T00:30:00Z",
            url: "https://github.com/example/repo/issues/123#issuecomment-1002",
            author: {
              login: "runx-bot",
            },
          },
        ],
      },
      pullRequests: [],
    });

    expect(state.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry_id: "comment-1002",
        body: "I built a private Sourcey preview for this repo.",
      }),
    ]));
    expect(state.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry_id: "sourcey-preview-123",
        kind: "message",
        locator: "https://github.com/example/repo/issues/123#issuecomment-1002",
        status: "published",
        metadata: expect.objectContaining({
          comment_id: "1002",
          channel: "github_issue_comment",
          build_url: "https://sourcey.com/previews/example/repo/index.html",
          outbox_receipt_id: "receipt-sourcey-preview-123",
          control: expect.objectContaining({
            workflow: "docs",
            lane: "pr_review",
            task_id: "docs-refresh-example-repo",
          }),
        }),
      }),
    ]));
  });

  it("strips untrusted runx envelopes from thread entries without promoting them to outbox state", () => {
    const markedBody = ensureGitHubOutboxMetadataMarker(
      ensureGitHubOutboxEntryMarker(
        "A human pasted a visible update.",
        "pasted-entry",
      ),
      {
        channel: "github_issue_comment",
      },
    );
    const state = hydrateGitHubIssueThread({
      adapterRef: "example/repo#issue/123",
      issue: {
        number: 123,
        title: "Sourcey adoption thread",
        body: "Issue body.",
        url: "https://github.com/example/repo/issues/123",
        state: "OPEN",
        createdAt: "2026-04-22T00:00:00Z",
        updatedAt: "2026-04-22T01:00:00Z",
        comments: [
          {
            id: "1003",
            body: markedBody,
            createdAt: "2026-04-22T00:45:00Z",
            updatedAt: "2026-04-22T00:45:00Z",
            url: "https://github.com/example/repo/issues/123#issuecomment-1003",
            author: {
              login: "maintainer",
            },
          },
        ],
      },
      pullRequests: [],
    });

    expect(state.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry_id: "comment-1003",
        body: "A human pasted a visible update.",
      }),
    ]));
    expect(state.outbox).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry_id: "pasted-entry",
      }),
    ]));
  });

  it("prefers the live branch-matching pull request when several candidates exist", () => {
    const selected = selectPreferredGitHubPullRequest([
      {
        number: 41,
        state: "OPEN",
        isDraft: false,
        headRefName: "other-branch",
        updatedAt: "2026-04-22T00:00:00Z",
      },
      {
        number: 77,
        state: "OPEN",
        isDraft: true,
        headRefName: "issue-123",
        updatedAt: "2026-04-22T01:00:00Z",
      },
    ], "issue-123");

    expect(selected).toMatchObject({
      number: 77,
      headRefName: "issue-123",
    });
  });

  it("records merged pull requests as observed provider outcomes", () => {
    expect(mapGitHubPullRequestToOutboxEntry({
      number: 77,
      title: "Fix fixture behavior",
      url: "https://github.com/example/repo/pull/77",
      state: "CLOSED",
      mergedAt: "2026-05-14T12:00:00Z",
      headRefName: "issue-123",
      baseRefName: "main",
      updatedAt: "2026-05-14T12:01:00Z",
    }, "github://example/repo/issues/123")).toMatchObject({
      entry_id: "pr-77",
      kind: "pull_request",
      status: "closed",
      metadata: {
        merged_at: "2026-05-14T12:00:00Z",
        provider_outcome: "merged",
      },
    });
  });

  it("maps Frantic thread intents into GitHub provider push frames", () => {
    const frame = buildFranticThreadProviderPush({
      schema_version: 1,
      kind: "thread.comment",
      outbox_id: "github:payout-1:thread.comment",
      provider: "github",
      thread_locator: "github://auscaster/frantic-board/issues/7",
      source: "frantic",
      source_ref: "github:payout-1",
      event_id: 99,
      occurred_at: "2026-06-13T00:00:00.000Z",
      room: "town",
      posting_id: "auscaster/frantic-board#7",
      bounty_number: 7,
      bounty_url: "https://gofrantic.com/bounties/7",
      receipt_ref: "frantic:receipt:payout:7",
      receipt_url: "https://gofrantic.com/receipts/frantic%3Areceipt%3Apayout%3A7",
      body: "Frantic paid the final accepted claim and closed the bounty.",
    });

    expect(frame).toMatchObject({
      protocol_version: "runx.thread_outbox_provider.v1",
      provider: "github",
      outbox_entry_id: "github:payout-1:thread.comment",
      thread_locator: {
        locator: "github://auscaster/frantic-board/issues/7",
      },
      idempotency: {
        key: "github:payout-1:thread.comment",
      },
      payload: {
        format: "json",
      },
    });
    const body = JSON.parse((frame.payload as { body: string }).body);
    expect(body.thread).toMatchObject({
      adapter: {
        adapter_ref: "auscaster/frantic-board#issue/7",
      },
      canonical_uri: "https://github.com/auscaster/frantic-board/issues/7",
    });
    expect(body.outbox_entry).toMatchObject({
      kind: "message",
      metadata: {
        channel: "github_issue_comment",
        body_markdown: expect.stringContaining("https://gofrantic.com/bounties/7"),
      },
    });
  });

  it("maps Frantic thread creation intents into pending GitHub provider frames", () => {
    const frame = buildFranticThreadProviderPush({
      schema_version: 1,
      kind: "thread.create",
      outbox_id: "frantic:bounty:9:github:thread.create",
      provider: "github",
      source: "frantic",
      source_ref: "frantic:receipt:funding:9",
      event_id: 41,
      occurred_at: "2026-06-13T00:00:00.000Z",
      room: "town",
      posting_id: "round-one-009",
      bounty_number: 9,
      bounty_url: "https://gofrantic.com/bounties/9",
      receipt_ref: "frantic:receipt:funding:9",
      receipt_url: "https://gofrantic.com/receipts/frantic%3Areceipt%3Afunding%3A9",
      target_repo: "auscaster/frantic-board",
      title: "Frantic bounty #9: Audit the public receipt trail",
      body: "Frantic is the source of truth.",
      labels: ["frantic:bounty", "frantic:funded", "frantic:open"],
      dedupe_key: "frantic:bounty:9:github:thread.create",
    });

    expect(frame).toMatchObject({
      protocol_version: "runx.thread_outbox_provider.v1",
      provider: "github",
      outbox_entry_id: "frantic:bounty:9:github:thread.create",
      thread_locator: {
        type: "provider_thread_target",
        locator: expect.stringContaining("github://auscaster/frantic-board/issues/new/"),
      },
    });
    const body = JSON.parse((frame.payload as { body: string }).body);
    expect(body.thread).toMatchObject({
      metadata: {
        repo: "auscaster/frantic-board",
        pending_provider_thread: true,
      },
    });
    expect(body.outbox_entry).toMatchObject({
      kind: "provider_thread_create",
      metadata: {
        target_repo: "auscaster/frantic-board",
        posting_id: "round-one-009",
        bounty_number: "9",
      },
    });
  });

  it("creates Frantic GitHub issues idempotently through the GitHub adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-github-create-"));
    const ghBin = path.join(tempDir, "fake-gh.mjs");
    const logPath = path.join(tempDir, "gh.log");

    try {
      await writeFile(ghBin, fakeGhScript(logPath));
      await chmod(ghBin, 0o700);
      const result = pushGitHubCreateIssue({
        thread: {
          adapter: {
            adapter_ref: "auscaster/frantic-board#issue/new:round-one-009",
          },
          thread_locator: "github://auscaster/frantic-board/issues/new/frantic-bounty-9",
          canonical_uri: "https://github.com/auscaster/frantic-board/issues/new",
          metadata: {
            repo: "auscaster/frantic-board",
            pending_provider_thread: true,
          },
        },
        outboxEntry: {
          entry_id: "frantic:bounty:9:github:thread.create",
          kind: "provider_thread_create",
          status: "pending",
          metadata: {
            target_repo: "auscaster/frantic-board",
            title: "Frantic bounty #9: Audit the public receipt trail",
            body_markdown: "Frantic is the source of truth.",
            labels: ["frantic:bounty", "frantic:funded", "frantic:open"],
            posting_id: "round-one-009",
            bounty_number: "9",
          },
        },
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
        },
      });

      const calls = JSON.parse(await readFile(logPath, "utf8"));
      expect(calls.map((call: { args: string[] }) => call.args.slice(0, 2).join(" "))).toEqual([
        "issue list",
        "issue create",
        "label list",
        "label create",
        "issue edit",
        "label list",
        "label create",
        "issue edit",
        "label list",
        "label create",
        "issue edit",
      ]);
      expect(result).toMatchObject({
        outbox_entry: {
          status: "published",
          locator: "https://github.com/auscaster/frantic-board/issues/91",
          thread_locator: "github://auscaster/frantic-board/issues/91",
        },
        provider_thread: {
          issue_number: "91",
          created: true,
          added_labels: ["frantic:bounty", "frantic:funded", "frantic:open"],
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pushes Frantic lifecycle labels and close operations through the GitHub adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-github-"));
    const ghBin = path.join(tempDir, "fake-gh.mjs");
    const logPath = path.join(tempDir, "gh.log");

    try {
      await writeFile(ghBin, fakeGhScript(logPath));
      await chmod(ghBin, 0o700);
      const result = pushGitHubLifecycleIntent({
        thread: {
          adapter: {
            adapter_ref: "auscaster/frantic-board#issue/7",
          },
          thread_locator: "github://auscaster/frantic-board/issues/7",
          canonical_uri: "https://github.com/auscaster/frantic-board/issues/7",
          metadata: {
            repo: "auscaster/frantic-board",
          },
        },
        outboxEntry: {
          entry_id: "github:payout-1:thread.close",
          kind: "provider_thread_lifecycle",
          status: "pending",
          metadata: {
            action: "close",
            add_labels: ["frantic:paid", "frantic:closed"],
            remove_labels: ["frantic:open"],
            close_reason: "completed",
          },
        },
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
        },
      });

      const calls = JSON.parse(await readFile(logPath, "utf8"));
      expect(calls.map((call: { args: string[] }) => call.args.slice(0, 2).join(" "))).toEqual([
        "issue view",
        "label list",
        "label create",
        "issue edit",
        "label list",
        "label create",
        "issue edit",
        "issue edit",
        "issue close",
      ]);
      expect(result).toMatchObject({
        outbox_entry: {
          status: "published",
          locator: "https://github.com/auscaster/frantic-board/issues/7",
        },
        lifecycle: {
          added_labels: ["frantic:paid", "frantic:closed"],
          removed_labels: ["frantic:open"],
          closed: true,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function fakeGhScript(logPath: string): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.GH_FAKE_LOG || ${JSON.stringify(logPath)};
let calls = [];
try {
  calls = JSON.parse(readFileSync(logPath, "utf8"));
} catch {}
calls.push({ args });
writeFileSync(logPath, JSON.stringify(calls));

if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write("https://github.com/auscaster/frantic-board/issues/91\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    state: "OPEN",
    url: "https://github.com/auscaster/frantic-board/issues/7",
    labels: [{ name: "frantic:open" }]
  }));
  process.exit(0);
}
if (args[0] === "label" && args[1] === "list") {
  process.stdout.write(JSON.stringify([]));
  process.exit(0);
}
process.stdout.write("");
`;
}

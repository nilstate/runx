import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  ensureGitHubOutboxEntryMarker,
  ensureGitHubOutboxMetadataMarker,
  ensureGitHubIssueReference,
  gitHubIssueSearchQuery,
  hydrateGitHubIssueThread,
  listGitHubIssuesWithAnyLabel,
  mapGitHubPullRequestToOutboxEntry,
  parseGitHubIssueRef,
  pushGitHubCreateIssue,
  pushGitHubLifecycleIntent,
  readGitHubThreadSnapshot,
  selectPreferredGitHubPullRequest,
} from "../tools/thread/github_adapter.mjs";
import {
  buildCreateFrame,
  buildLifecycleFrame,
  buildMessageFrame,
} from "../tools/thread/thread_desired_state.mjs";

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

  it("maps a desired-thread comment into a GitHub message provider frame", () => {
    const thread = {
      schema_version: 1,
      provider: "github",
      target_repo: "auscaster/frantic-board",
      identity_key: "frantic:bounty:7",
      thread_locator: "github://auscaster/frantic-board/issues/7",
      title: "Frantic bounty #7",
      body: "Frantic is the source of truth.",
      labels: ["bounty", "funded", "available"],
      managed_labels: ["bounty", "funded", "available", "paid", "closed"],
      state: "open",
      comments: [],
      ref: { posting_id: "auscaster/frantic-board#7", bounty_number: 7 },
    };
    const frame = buildMessageFrame(
      thread,
      {
        entry_id: "github:payout-1:thread.comment",
        body: "Frantic paid one accepted claim.",
        receipt_ref: "frantic:receipt:payout:7",
      },
      thread.thread_locator,
      { sourceId: "frantic" },
    );

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
    expect(body.provider_readback).toBe("mutation_only");
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
        source: "frantic",
        outbox_receipt_id: "frantic:receipt:payout:7",
      },
    });
  });

  it("maps a desired-thread state into create and lifecycle provider frames", () => {
    const thread = {
      schema_version: 1,
      provider: "github",
      target_repo: "auscaster/frantic-board",
      identity_key: "frantic:bounty:9",
      title: "Frantic bounty #9: Audit the public receipt trail",
      body: "Frantic is the source of truth.",
      labels: ["bounty", "funded", "available"],
      managed_labels: ["bounty", "funded", "available", "claimed", "paid", "closed"],
      state: "open",
      comments: [],
      ref: { posting_id: "round-one-009", bounty_number: 9 },
    };

    const createFrame = buildCreateFrame(thread, { sourceId: "frantic" });
    expect(createFrame).toMatchObject({
      protocol_version: "runx.thread_outbox_provider.v1",
      provider: "github",
      outbox_entry_id: "frantic:bounty:9",
      thread_locator: {
        type: "provider_thread_target",
        locator: expect.stringContaining("github://auscaster/frantic-board/issues/new/"),
      },
    });
    const createBody = JSON.parse((createFrame.payload as { body: string }).body);
    expect(createBody.thread).toMatchObject({
      metadata: {
        repo: "auscaster/frantic-board",
        pending_provider_thread: true,
      },
    });
    expect(createBody.outbox_entry).toMatchObject({
      kind: "provider_thread_create",
      metadata: {
        target_repo: "auscaster/frantic-board",
        labels: ["bounty", "funded", "available"],
        dedupe_key: "frantic:bounty:9",
      },
    });

    const lifecycleFrame = buildLifecycleFrame(
      { ...thread, state: "closed", close_reason: "completed", labels: ["paid", "closed"] },
      "github://auscaster/frantic-board/issues/9",
      { sourceId: "frantic" },
    );
    const lifecycleBody = JSON.parse((lifecycleFrame.payload as { body: string }).body);
    expect(lifecycleBody.outbox_entry).toMatchObject({
      kind: "provider_thread_lifecycle",
      metadata: {
        action: "close",
        close_reason: "completed",
      },
    });
    expect(lifecycleBody.outbox_entry.metadata.add_labels).toContain("paid");
    expect(lifecycleBody.outbox_entry.metadata.remove_labels).toContain("available");
  });

  it("maps a linked desired-thread refresh to the existing provider issue", () => {
    const thread = {
      schema_version: 1,
      provider: "github",
      target_repo: "auscaster/frantic-board",
      identity_key: "frantic:bounty:90",
      thread_locator: "github://auscaster/frantic-board/issues/205",
      title: "Frantic bounty #90: runx skill: compliance pack",
      body: "Status: claimed",
      labels: ["bounty", "funded", "claimed"],
      managed_labels: ["bounty", "funded", "available", "claimed", "paid", "closed"],
      state: "open",
      comments: [],
      ref: { posting_id: "round-one-090", bounty_number: 90 },
    };

    const frame = buildCreateFrame(thread, { sourceId: "frantic" });
    expect(frame.thread_locator).toMatchObject({
      type: "provider_thread",
      locator: "github://auscaster/frantic-board/issues/205",
    });
    const body = JSON.parse((frame.payload as { body: string }).body);
    expect(body.thread).toMatchObject({
      adapter: {
        adapter_ref: "auscaster/frantic-board#issue/205",
      },
      thread_locator: "github://auscaster/frantic-board/issues/205",
    });
    expect(body.outbox_entry).toMatchObject({
      kind: "provider_thread_create",
      thread_locator: "github://auscaster/frantic-board/issues/205",
      metadata: {
        target_repo: "auscaster/frantic-board",
        title: "Frantic bounty #90: runx skill: compliance pack",
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

  it("pushes Frantic open lifecycle operations through the GitHub adapter", async () => {
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
          entry_id: "github:claim-1:thread.open",
          kind: "provider_thread_lifecycle",
          status: "pending",
          metadata: {
            action: "open",
          },
        },
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
          GH_FAKE_ISSUE_STATE: "CLOSED",
        },
      });

      const calls = JSON.parse(await readFile(logPath, "utf8"));
      expect(calls.map((call: { args: string[] }) => call.args.slice(0, 2).join(" "))).toEqual([
        "issue view",
        "issue reopen",
      ]);
      expect(result).toMatchObject({
        outbox_entry: {
          status: "published",
          locator: "https://github.com/auscaster/frantic-board/issues/7",
        },
        lifecycle: {
          opened: true,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes visible comment bodies in issue snapshots for markerless dedupe", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-github-snapshot-"));
    const ghBin = path.join(tempDir, "fake-gh.mjs");
    const logPath = path.join(tempDir, "gh.log");

    try {
      await writeFile(ghBin, fakeGhScript(logPath));
      await chmod(ghBin, 0o700);
      const snapshot = readGitHubThreadSnapshot({
        adapterRef: "github://auscaster/frantic-board/issues/7",
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
          GH_FAKE_COMMENTS: JSON.stringify([
            {
              body: "Frantic posted this bounty.",
            },
            {
              body: [
                "Frantic funding is visible on the ledger.",
                "",
                "<!-- runx-outbox-envelope: v1 -->",
                "<!-- runx-outbox-entry: organic:posting:p-1:funded:thread.comment -->",
              ].join("\n"),
            },
          ]),
        },
      });

      expect(snapshot.comment_bodies).toContain("Frantic posted this bounty.");
      expect(snapshot.comment_bodies).toContain("Frantic funding is visible on the ledger.");
      expect(snapshot.comment_markers).toContain("organic:posting:p-1:funded:thread.comment");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads every REST comment page before deciding which thread comments are missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-github-rest-snapshot-"));
    const curlBin = path.join(tempDir, "curl");
    const logPath = path.join(tempDir, "curl.log");

    try {
      await writeFile(curlBin, fakeCurlScript(logPath));
      await chmod(curlBin, 0o700);
      const snapshot = readGitHubThreadSnapshot({
        adapterRef: "github://auscaster/frantic-board/issues/7",
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
          GITHUB_TOKEN: "test-token",
          GH_FAKE_LOG: logPath,
        },
      });

      expect(snapshot.comment_markers).toContain("late-page:thread.comment");
      expect(snapshot.comment_bodies).toHaveLength(101);
      const calls = JSON.parse(await readFile(logPath, "utf8"));
      const urls = calls.map((call: { url: string }) => call.url);
      expect(urls).toContain("https://api.github.com/repos/auscaster/frantic-board/issues/7/comments?per_page=100&page=1");
      expect(urls).toContain("https://api.github.com/repos/auscaster/frantic-board/issues/7/comments?per_page=100&page=2");
      expect(urls.some((url: string) => url.includes("page=3"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists GitHub issues carrying any managed label without duplicates", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-github-list-"));
    const ghBin = path.join(tempDir, "fake-gh.mjs");
    const logPath = path.join(tempDir, "gh.log");

    try {
      await writeFile(ghBin, fakeGhScript(logPath));
      await chmod(ghBin, 0o700);
      const issues = listGitHubIssuesWithAnyLabel({
        repoSlug: "auscaster/frantic-board",
        labels: ["bounty", "funded"],
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
          GH_FAKE_ISSUES: JSON.stringify([
            {
              number: 71,
              title: "old paid bounty",
              state: "CLOSED",
              url: "https://github.com/auscaster/frantic-board/issues/71",
              labels: [{ name: "bounty" }, { name: "funded" }],
            },
            {
              number: 72,
              title: "funded bounty",
              state: "OPEN",
              url: "https://github.com/auscaster/frantic-board/issues/72",
              labels: [{ name: "funded" }],
            },
            {
              number: 73,
              title: "unmanaged issue",
              state: "OPEN",
              url: "https://github.com/auscaster/frantic-board/issues/73",
              labels: [{ name: "help wanted" }],
            },
          ]),
        },
      });

      expect(issues.map((issue) => issue.number)).toEqual(["71", "72"]);
      expect(issues[0]).toMatchObject({
        thread_locator: "github://auscaster/frantic-board/issues/71",
        labels: ["bounty", "funded"],
      });
      const calls = JSON.parse(await readFile(logPath, "utf8"));
      expect(calls.map((call: { args: string[] }) => call.args.slice(0, 2).join(" "))).toEqual([
        "issue list",
        "issue list",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dry-runs orphan retirement for managed GitHub issues missing from full desired state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-thread-sync-"));
    const ghBin = path.join(tempDir, "fake-gh.mjs");
    const logPath = path.join(tempDir, "gh.log");
    const desiredThread = {
      schema_version: 1,
      provider: "github",
      target_repo: "auscaster/frantic-board",
      identity_key: "frantic:bounty:10",
      thread_locator: "github://auscaster/frantic-board/issues/10",
      title: "Frantic bounty #10: live thread",
      body: "Still desired.",
      labels: ["bounty", "funded"],
      managed_labels: ["bounty", "funded", "available", "claimed", "paid", "closed"],
      state: "open",
      comments: [],
    };
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/internal/thread-desired-state")) {
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ threads: [desiredThread] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      await writeFile(ghBin, fakeGhScript(logPath));
      await chmod(ghBin, 0o700);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");

      const result = await spawnNode(["scripts/thread-reconcile-sync.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
          GH_FAKE_ISSUES: JSON.stringify([
            {
              number: 10,
              title: "live thread",
              state: "OPEN",
              labels: [{ name: "bounty" }, { name: "funded" }],
            },
            {
              number: 11,
              title: "stale managed thread",
              state: "CLOSED",
              labels: [{ name: "bounty" }, { name: "funded" }, { name: "paid" }, { name: "closed" }],
            },
            {
              number: 12,
              title: "unmanaged issue",
              state: "OPEN",
              labels: [{ name: "help wanted" }],
            },
          ]),
          THREAD_SYNC_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          THREAD_SYNC_INTERNAL_SECRET: "test-secret",
          THREAD_SYNC_TARGET_REPO: "auscaster/frantic-board",
          THREAD_SYNC_FULL_RECONCILE: "1",
          THREAD_SYNC_DRY_RUN: "1",
          THREAD_SYNC_PROGRESS_EVERY: "999",
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ ok: true, reconciled: 1, orphaned: 1 });
      expect(output.results).toContainEqual(expect.objectContaining({
        identity_key: "orphan:auscaster/frantic-board#11",
        locator: "github://auscaster/frantic-board/issues/11",
        orphaned: true,
        dry_run: true,
      }));
    } finally {
      server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes an already-open lifecycle operation without GitHub mutation", async () => {
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
          entry_id: "github:claim-1:thread.open",
          kind: "provider_thread_lifecycle",
          status: "pending",
          metadata: {
            action: "open",
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
      ]);
      expect(result).toMatchObject({
        lifecycle: {
          opened: true,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips live GitHub mutation for non-GitHub fixture thread adapters", () => {
    const request = {
      protocol_version: "runx.thread_outbox_provider.v1",
      push_id: "thread_push_fixture",
      adapter_id: "thread-provider.github",
      provider: "github",
      thread_locator: {
        provider: "github",
        locator: "github://example/repo/issues/123",
        thread_ref: {
          type: "github_issue",
          uri: "github://example/repo/issues/123",
          provider: "github",
          locator: "github://example/repo/issues/123",
        },
      },
      outbox_entry_id: "pull_request:fixture",
      idempotency: {
        key: "thread-outbox:github:fixture",
        content_hash: "sha256:fixture",
      },
      payload: {
        format: "json",
        body: JSON.stringify({
          thread: {
            kind: "runx.thread.v1",
            adapter: {
              type: "file",
              adapter_ref: "github://example/repo/issues/123",
            },
            thread_kind: "signal",
            thread_locator: "github://example/repo/issues/123",
            entries: [],
            decisions: [],
            outbox: [],
            source_refs: [],
          },
          outbox_entry: {
            entry_id: "pull_request:fixture",
            kind: "pull_request",
            status: "proposed",
            thread_locator: "github://example/repo/issues/123",
          },
          draft_pull_request: {
            target: {
              repo: "example/repo",
              branch: "fixture",
            },
          },
          fixture: "/tmp/runx-fixture",
        }),
      },
    };

    const result = spawnSync("node", ["tools/thread/thread_outbox_provider/github-provider.mjs"], {
      cwd: process.cwd(),
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNX_GH_BIN: "/path/that/should/not/be/called",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      observation: {
        status: "skipped",
        idempotency: {
          status: "skipped",
        },
      },
      output: {
        outbox_entry: {
          entry_id: "pull_request:fixture",
        },
        push: {
          status: "skipped",
          reason: "thread adapter is not github",
        },
      },
    });
  });

  it("uses mutation-only provider frames without redundant GraphQL thread reads", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-frantic-github-"));
    const ghBin = path.join(tempDir, "fake-gh.mjs");
    const logPath = path.join(tempDir, "gh.log");
    const thread = {
      schema_version: 1,
      provider: "github",
      target_repo: "auscaster/frantic-board",
      identity_key: "frantic:bounty:7",
      thread_locator: "github://auscaster/frantic-board/issues/7",
      title: "Frantic bounty #7",
      body: "Frantic is the source of truth.",
      labels: ["bounty", "funded", "available"],
      managed_labels: ["bounty", "funded", "available", "paid", "closed"],
      state: "open",
      comments: [],
    };
    const frame = buildMessageFrame(
      thread,
      {
        entry_id: "github:payout-1:thread.comment",
        body: "Frantic paid one accepted claim.",
        receipt_ref: "frantic:receipt:payout:7",
      },
      thread.thread_locator,
      { sourceId: "frantic" },
    );

    try {
      await writeFile(ghBin, fakeGhScript(logPath));
      await chmod(ghBin, 0o700);
      const result = spawnSync("node", ["tools/thread/thread_outbox_provider/github-provider.mjs"], {
        cwd: process.cwd(),
        input: `${JSON.stringify(frame)}\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNX_GH_BIN: ghBin,
          GH_FAKE_LOG: logPath,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const calls = JSON.parse(await readFile(logPath, "utf8"));
      expect(calls.map((call: { args: string[] }) => call.args.slice(0, 2).join(" "))).toEqual([
        "issue comment",
      ]);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        observation: { status: "accepted" },
        output: {
          push: {
            status: "pushed",
          },
        },
      });
      expect(output.output.thread).toBeUndefined();
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
  const issues = JSON.parse(process.env.GH_FAKE_ISSUES || "[]");
  const labelIndex = args.indexOf("--label");
  const wantedLabel = labelIndex >= 0 ? args[labelIndex + 1] : undefined;
  const filtered = wantedLabel
    ? issues.filter((issue) => (issue.labels || []).some((label) => (label.name || label) === wantedLabel))
    : issues;
  process.stdout.write(JSON.stringify(filtered));
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write("https://github.com/auscaster/frantic-board/issues/91\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    title: "Fixture issue",
    body: "Fixture body",
    state: process.env.GH_FAKE_ISSUE_STATE || "OPEN",
    url: "https://github.com/auscaster/frantic-board/issues/7",
    labels: [{ name: "frantic:open" }],
    comments: JSON.parse(process.env.GH_FAKE_COMMENTS || "[]")
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

function fakeCurlScript(logPath: string): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const url = urlIndex >= 0 ? args[urlIndex + 1] : "";
const logPath = process.env.GH_FAKE_LOG || ${JSON.stringify(logPath)};
let calls = [];
try {
  calls = JSON.parse(readFileSync(logPath, "utf8"));
} catch {}
calls.push({ url });
writeFileSync(logPath, JSON.stringify(calls));

let body;
if (url.endsWith("/repos/auscaster/frantic-board/issues/7")) {
  body = { title: "Fixture issue", body: "Fixture body", state: "open", labels: [] };
} else if (url.includes("/repos/auscaster/frantic-board/issues/7/comments?")) {
  const page = Number(new URL(url).searchParams.get("page") || "1");
  body = page === 1
    ? Array.from({ length: 100 }, (_, index) => ({ body: \`comment \${index + 1}\` }))
    : [{
        body: [
          "late comment",
          "",
          "<!-- runx-outbox-envelope: v1 -->",
          "<!-- runx-outbox-entry: late-page:thread.comment -->",
        ].join("\\n"),
      }];
} else {
  body = { message: "not found" };
}
process.stdout.write(JSON.stringify(body) + "\\n200");
`;
}

function spawnNode(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`node ${args.join(" ")} timed out\n${stderr || stdout}`));
      }, 5_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (status, signal) => {
        clearTimeout(timeout);
        resolve({ status, signal, stdout, stderr });
      });
    },
  );
}

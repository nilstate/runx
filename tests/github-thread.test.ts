import { describe, expect, it } from "vitest";

import {
  ensureGitHubIssueReference,
  gitHubIssueSearchQuery,
  hydrateGitHubIssueThread,
  parseGitHubIssueRef,
  selectPreferredGitHubPullRequest,
} from "../tools/thread/github_adapter.mjs";

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
      "\"Source issue: https://github.com/example/repo/issues/123\" in:body",
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
      thread_kind: "work_item",
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
            body: [
              "I built a private Sourcey preview for this repo.",
              "",
              "<!-- runx-outbox-entry: sourcey-preview-123 -->",
              "",
            ].join("\n"),
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
        }),
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
});

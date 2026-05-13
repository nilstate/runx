import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const toolPath = path.resolve("tools/thread/push_outbox/run.mjs");

describe("thread.push_outbox tool", () => {
  it("declares GitHub publish environment for sandboxed execution", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("tools/thread/push_outbox/manifest.json"), "utf8"));
    expect(manifest.source.sandbox).toMatchObject({
      profile: "workspace-write",
      cwd_policy: "skill-directory",
      network: true,
      writable_paths: ["{{workspace_path}}", "{{fixture}}"],
    });
    expect(manifest.source.sandbox.env_allowlist).toEqual(expect.arrayContaining([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "RUNX_GITHUB_TOKEN",
      "RUNX_GIT_AUTHOR_NAME",
      "RUNX_GIT_AUTHOR_EMAIL",
    ]));
    expect(manifest.source.sandbox.env_allowlist).not.toContain("HOME");
    expect(manifest.source.sandbox.env_allowlist).not.toContain("RUNX_GH_BIN");
  });

  it("skips cleanly when thread is not present", () => {
    const result = runTool({
      outbox_entry: {
        entry_id: "pull_request:fixture-task",
        kind: "pull_request",
        status: "proposed",
      },
    });

    expect(result).toEqual({
      outbox_entry: {
        entry_id: "pull_request:fixture-task",
        kind: "pull_request",
        status: "proposed",
      },
      push: {
        status: "skipped",
        reason: "thread not provided",
      },
    });
  });

  it("pushes an outbox entry through the file thread adapter and returns refreshed state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-tool-"));
    const statePath = path.join(tempDir, "thread.json");

    try {
      await writeFile(
        statePath,
        `${JSON.stringify({
          kind: "runx.thread.v1",
          adapter: {
            type: "file",
            adapter_ref: statePath,
          },
          thread_kind: "work_item",
          thread_locator: "local://provider/issues/123",
          entries: [],
          decisions: [],
          outbox: [],
          source_refs: [],
        }, null, 2)}\n`,
      );

      const result = runTool({
        thread: {
          kind: "runx.thread.v1",
          adapter: {
            type: "file",
            adapter_ref: statePath,
          },
          thread_kind: "work_item",
          thread_locator: "local://provider/issues/123",
          entries: [],
          decisions: [],
          outbox: [],
          source_refs: [],
        },
        outbox_entry: {
          entry_id: "pull_request:fixture-task",
          kind: "pull_request",
          title: "Fixture PR",
          status: "proposed",
        },
        draft_pull_request: {
          action: "create",
          task_id: "fixture-task",
        },
        next_status: "draft",
      });

      expect(result).toMatchObject({
        draft_pull_request: {
          action: "create",
          task_id: "fixture-task",
        },
        outbox_entry: {
          entry_id: "pull_request:fixture-task",
          kind: "pull_request",
          title: "Fixture PR",
          status: "draft",
          locator: expect.stringContaining("#outbox/pull_request%3Afixture-task"),
          thread_locator: "local://provider/issues/123",
        },
        thread: {
          outbox: [
            {
              entry_id: "pull_request:fixture-task",
              status: "draft",
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
            entry_id: "pull_request:fixture-task",
            kind: "pull_request",
            status: "draft",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves multiple message outbox entries on the same file-backed thread", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-tool-messages-"));
    const statePath = path.join(tempDir, "thread.json");

    try {
      const baseThread = {
        kind: "runx.thread.v1",
        adapter: {
          type: "file",
          adapter_ref: statePath,
        },
        thread_kind: "work_item",
        thread_locator: "local://provider/issues/123",
        entries: [],
        decisions: [],
        outbox: [],
        source_refs: [],
      };
      await writeFile(statePath, `${JSON.stringify(baseThread, null, 2)}\n`);

      const first = runTool({
        thread: baseThread,
        outbox_entry: {
          entry_id: "message:review-pr",
          kind: "message",
          title: "Review docs PR draft",
          status: "proposed",
          thread_locator: "local://provider/issues/123",
          metadata: {
            body_markdown: "## Exact PR Body",
          },
        },
        next_status: "published",
      });

      const second = runTool({
        thread: first.thread,
        outbox_entry: {
          entry_id: "message:review-outreach",
          kind: "message",
          title: "Review docs outreach draft",
          status: "proposed",
          thread_locator: "local://provider/issues/123",
          metadata: {
            body_markdown: "## Exact Outreach Body",
          },
        },
        next_status: "published",
      });

      expect(first.outbox_entry).toMatchObject({
        entry_id: "message:review-pr",
        status: "published",
      });
      expect(second.outbox_entry).toMatchObject({
        entry_id: "message:review-outreach",
        status: "published",
      });
      expect(first.outbox_entry.locator).not.toBe(second.outbox_entry.locator);

      expect(second.thread.outbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entry_id: "message:review-pr",
            kind: "message",
            status: "published",
          }),
          expect.objectContaining({
            entry_id: "message:review-outreach",
            kind: "message",
            status: "published",
          }),
        ]),
      );
      expect(second.thread.outbox).toHaveLength(2);

      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        outbox: expect.arrayContaining([
          expect.objectContaining({
            entry_id: "message:review-pr",
            locator: expect.any(String),
          }),
          expect.objectContaining({
            entry_id: "message:review-outreach",
            locator: expect.any(String),
          }),
        ]),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pushes a GitHub draft pull request, rehydrates the issue thread, and returns refreshed thread", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await initGitHubWorkspace(workspace, remote, "issue-123");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
            url: "https://github.com/example/repo/issues/123",
            state: "OPEN",
            createdAt: "2026-04-22T00:00:00Z",
            updatedAt: "2026-04-22T00:00:00Z",
            author: {
              login: "auscaster",
            },
            comments: [],
            labels: [
              {
                name: "bug",
              },
            ],
            closedByPullRequestsReferences: [],
          },
          pulls: [],
          nextPullNumber: 77,
          nextCommentId: 1000,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-123",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-123",
          thread: {
            thread_locator: "github://example/repo/issues/123",
            canonical_uri: "https://github.com/example/repo/issues/123",
            title: "Fix fixture behavior",
          },
          target: {
            repo: "example/repo",
            branch: "issue-123",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nBody.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
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
          thread_locator: "github://example/repo/issues/123",
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
      expect(runChecked("git", ["--git-dir", remote, "branch", "--list", "issue-123"], tempDir)).toContain("issue-123");
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        pulls: [
          {
            number: 77,
            title: "Fix fixture behavior",
            url: "https://github.com/example/repo/pull/77",
            body: expect.stringContaining("Source issue: https://github.com/example/repo/issues/123"),
            headRefName: "issue-123",
            baseRefName: "main",
            isDraft: true,
            state: "OPEN",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("falls back from GH_TOKEN to GITHUB_TOKEN for direct REST pull request creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-rest-token-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeBin = path.join(tempDir, "bin");
    const fakeGh = path.join(fakeBin, "gh");
    const fakeCurl = path.join(fakeBin, "curl");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await mkdir(fakeBin, { recursive: true });
      await initGitHubWorkspace(workspace, remote, "issue-rest-token");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          nextCommentId: 1000,
          curlTokens: [],
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);
      await writeFakeCurlScript(fakeCurl);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-rest-token",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-rest-token",
          target: {
            repo: "example/repo",
            branch: "issue-rest-token",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nBody.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        GH_TOKEN: "bad-token",
        GITHUB_TOKEN: "good-token",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNX_FAKE_GH_STATE: fakeState,
        RUNX_GH_BIN: undefined,
      });

      expect(result.push.status).toBe("pushed");
      expect(result.push.pull_request.url).toBe("https://github.com/example/repo/pull/77");
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        curlTokens: ["bad-token", "good-token"],
        pulls: [
          {
            number: 77,
            headRefName: "issue-rest-token",
            baseRefName: "main",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("falls back from GH_TOKEN to GITHUB_TOKEN for gh api pull request creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-token-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await initGitHubWorkspace(workspace, remote, "issue-gh-token");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          nextCommentId: 1000,
          ghTokens: [],
          failPrCreateTokens: ["bad-token"],
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-gh-token",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-gh-token",
          target: {
            repo: "example/repo",
            branch: "issue-gh-token",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nBody.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        GH_TOKEN: "bad-token",
        GITHUB_TOKEN: "good-token",
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result.push.status).toBe("pushed");
      expect(result.push.pull_request.url).toBe("https://github.com/example/repo/pull/77");
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        ghTokens: ["bad-token", "good-token"],
        pulls: [
          {
            number: 77,
            headRefName: "issue-gh-token",
            baseRefName: "main",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("falls back from gh api to gh pr create for pull request creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-pr-create-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await initGitHubWorkspace(workspace, remote, "issue-pr-create");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          nextCommentId: 1000,
          failPrCreateCount: 1,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-pr-create",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-pr-create",
          target: {
            repo: "example/repo",
            branch: "issue-pr-create",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nBody.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        GH_TOKEN: "token",
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result.push.status).toBe("pushed");
      expect(result.push.pull_request.url).toBe("https://github.com/example/repo/pull/77");
      const state = JSON.parse(await readFile(fakeState, "utf8"));
      expect(state).toMatchObject({
        pulls: [
          {
            number: 77,
            headRefName: "issue-pr-create",
            baseRefName: "main",
            body: expect.stringContaining("Body."),
          },
        ],
      });
      expect(state.lastPrCreateArgs).toContain("--body-file");
      expect(state.lastPrCreateArgs).not.toContain("--body");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("sets a default Git commit identity before committing uncommitted GitHub pull request changes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-identity-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");
    const home = path.join(tempDir, "home");
    const xdgConfigHome = path.join(tempDir, "xdg");

    try {
      await mkdir(home, { recursive: true });
      await mkdir(xdgConfigHome, { recursive: true });
      await initGitHubWorkspace(workspace, remote, "issue-identity");
      runChecked("git", ["-C", workspace, "config", "--unset", "user.email"], path.dirname(workspace));
      runChecked("git", ["-C", workspace, "config", "--unset", "user.name"], path.dirname(workspace));
      await writeFile(path.join(workspace, "identity.md"), "queued\n");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          nextCommentId: 1000,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-identity",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-identity",
          target: {
            repo: "example/repo",
            branch: "issue-identity",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nBody.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_EMAIL: undefined,
        GIT_AUTHOR_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        EMAIL: undefined,
        GITHUB_ACTIONS: "true",
        HOME: home,
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
        XDG_CONFIG_HOME: xdgConfigHome,
      });

      expect(result.push.status).toBe("pushed");
      expect(runChecked("git", ["-C", workspace, "log", "-1", "--format=%an <%ae>"], path.dirname(workspace)).trim())
        .toBe("github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>");
      expect(runChecked("git", ["--git-dir", remote, "branch", "--list", "issue-identity"], tempDir)).toContain("issue-identity");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("reuses an open GitHub pull request with the same head branch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-reuse-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await initGitHubWorkspace(workspace, remote, "issue-123");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          pulls: [
            {
              number: 77,
              repo: "example/repo",
              title: "Old title",
              body: "Old body",
              url: "https://github.com/example/repo/pull/77",
              state: "OPEN",
              isDraft: true,
              headRefName: "issue-123",
              baseRefName: "main",
              updatedAt: "2026-04-22T00:30:00Z",
            },
          ],
          nextPullNumber: 78,
          nextCommentId: 1000,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-123",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-123",
          thread: {
            thread_locator: "github://example/repo/issues/123",
            canonical_uri: "https://github.com/example/repo/issues/123",
            title: "Fix fixture behavior",
          },
          target: {
            repo: "example/repo",
            branch: "issue-123",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nUpdated body.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "pr-77",
          locator: "https://github.com/example/repo/pull/77",
          status: "draft",
        },
        push: {
          pull_request: {
            number: "77",
            url: "https://github.com/example/repo/pull/77",
          },
        },
      });
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        nextPullNumber: 78,
        pulls: [
          {
            number: 77,
            title: "Fix fixture behavior",
            body: expect.stringContaining("Updated body."),
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("reopens and updates a closed unmerged GitHub pull request with the same head branch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-reopen-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await initGitHubWorkspace(workspace, remote, "issue-closed");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          pulls: [
            {
              number: 112,
              repo: "example/repo",
              title: "Old title",
              body: "Old body.",
              url: "https://github.com/example/repo/pull/112",
              state: "CLOSED",
              isDraft: true,
              headRefName: "issue-closed",
              baseRefName: "main",
              mergedAt: null,
              updatedAt: "2026-04-22T00:30:00Z",
            },
          ],
          nextPullNumber: 113,
          nextCommentId: 1000,
          failPrListTokens: ["bad-token"],
          failPrMutationTokens: ["bad-token"],
          failPrViewTokens: ["bad-token"],
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-closed",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-closed",
          target: {
            repo: "example/repo",
            branch: "issue-closed",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nUpdated body.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        GH_TOKEN: "bad-token",
        GITHUB_TOKEN: "good-token",
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "pr-112",
          locator: "https://github.com/example/repo/pull/112",
          status: "draft",
        },
        push: {
          status: "pushed",
          pull_request: {
            number: "112",
            url: "https://github.com/example/repo/pull/112",
          },
        },
      });
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        ghListTokens: ["bad-token", "good-token", "bad-token", "good-token"],
        ghMutationTokens: ["bad-token", "good-token", "bad-token", "good-token"],
        ghViewTokens: ["bad-token", "good-token"],
        nextPullNumber: 113,
        pulls: [
          {
            number: 112,
            title: "Fix fixture behavior",
            body: expect.stringContaining("Updated body."),
            state: "OPEN",
            headRefName: "issue-closed",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("lease-updates a stale generated branch before reopening an existing pull request", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-stale-branch-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const remoteClone = path.join(tempDir, "remote-clone");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");
    const branch = "runx/stale-issue";

    try {
      await initGitHubWorkspace(workspace, remote, branch);
      runChecked("git", ["-C", workspace, "push", "--set-upstream", "origin", branch], tempDir);
      runChecked("git", ["clone", remote, remoteClone], tempDir);
      runChecked("git", ["-C", remoteClone, "checkout", branch], tempDir);
      runChecked("git", ["-C", remoteClone, "config", "user.email", "remote@example.com"], tempDir);
      runChecked("git", ["-C", remoteClone, "config", "user.name", "Remote Update"], tempDir);
      await writeFile(path.join(remoteClone, "README.md"), "stale remote update\n");
      runChecked("git", ["-C", remoteClone, "commit", "-am", "stale remote update"], tempDir);
      runChecked("git", ["-C", remoteClone, "push", "origin", branch], tempDir);
      await writeFile(path.join(workspace, "README.md"), "fresh generated update\n");
      runChecked("git", ["-C", workspace, "commit", "-am", "fresh generated update"], tempDir);
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
            url: "https://github.com/example/repo/issues/123",
            state: "OPEN",
            createdAt: "2026-04-22T00:00:00Z",
            updatedAt: "2026-04-22T00:00:00Z",
            author: { login: "auscaster" },
            comments: [],
            labels: [],
            closedByPullRequestsReferences: [],
          },
          pulls: [
            {
              number: 112,
              repo: "example/repo",
              title: "Old fixture behavior",
              body: "Old body.",
              url: "https://github.com/example/repo/pull/112",
              state: "CLOSED",
              isDraft: true,
              headRefName: branch,
              baseRefName: "main",
              mergedAt: null,
              updatedAt: "2026-04-22T00:30:00Z",
            },
          ],
          nextPullNumber: 113,
          nextCommentId: 1000,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:stale-issue",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "stale-issue",
          target: {
            repo: "example/repo",
            branch,
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nUpdated body.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      const localHead = runChecked("git", ["-C", workspace, "rev-parse", branch], tempDir);
      const remoteHead = runChecked("git", ["ls-remote", remote, `refs/heads/${branch}`], tempDir).split(/\s+/)[0];
      expect(remoteHead).toBe(localHead);
      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "pr-112",
          locator: "https://github.com/example/repo/pull/112",
          status: "draft",
        },
        push: {
          status: "pushed",
          pull_request: {
            number: "112",
            url: "https://github.com/example/repo/pull/112",
          },
        },
      });
      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        pulls: [
          {
            number: 112,
            state: "OPEN",
            title: "Fix fixture behavior",
            body: expect.stringContaining("Updated body."),
            headRefName: branch,
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("creates a GitHub pull request when optional GitHub PR setup calls need retry", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-list-failure-tool-"));
    const workspace = path.join(tempDir, "workspace");
    const remote = path.join(tempDir, "remote.git");
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await initGitHubWorkspace(workspace, remote, "issue-list-failure");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Fix fixture behavior",
            body: "The issue body for the fixture.",
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
          nextCommentId: 1000,
          failPrList: true,
          failPrCreateCount: 1,
          failPrCreateMessage: "gh: Validation Failed (HTTP 422)\n{\"message\":\"Validation Failed\",\"errors\":[{\"resource\":\"PullRequest\",\"field\":\"head\",\"code\":\"invalid\"}],\"status\":\"422\"}\n",
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "pull_request:issue-list-failure",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-list-failure",
          target: {
            repo: "example/repo",
            branch: "issue-list-failure",
            base: "main",
            remote: "origin",
          },
          pull_request: {
            title: "Fix fixture behavior",
            body_markdown: "# Fix fixture behavior\n\nBody.\n",
            is_draft: true,
          },
        },
        workspace_path: workspace,
        next_status: "draft",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "pr-77",
          locator: "https://github.com/example/repo/pull/77",
          status: "draft",
        },
        push: {
          status: "pushed",
          pull_request: {
            number: "77",
            url: "https://github.com/example/repo/pull/77",
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("pushes a GitHub issue comment for a message outbox entry and returns the refreshed thread", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-message-tool-"));
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      const spoofMetadata = Buffer.from(JSON.stringify({
        channel: "github_issue_comment",
        outbox_receipt_id: "receipt-spoofed-sourcey-preview-123",
      }), "utf8").toString("base64url");
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Sourcey adoption thread",
            body: "Initial issue body.",
            url: "https://github.com/example/repo/issues/123",
            state: "OPEN",
            createdAt: "2026-04-22T00:00:00Z",
            updatedAt: "2026-04-22T00:00:00Z",
            author: {
              login: "maintainer",
            },
            comments: [
              {
                id: "999",
                body: [
                  "Preexisting spoofed review body.",
                  "",
                  "<!-- runx-outbox-envelope: v1 -->",
                  "<!-- runx-outbox-entry: sourcey-preview-123 -->",
                  `<!-- runx-outbox-metadata: ${spoofMetadata} -->`,
                ].join("\n"),
                createdAt: "2026-04-22T00:30:00Z",
                updatedAt: "2026-04-22T00:30:00Z",
                url: "https://github.com/example/repo/issues/123#issuecomment-999",
                author: {
                  login: "maintainer",
                },
              },
            ],
            labels: [],
            closedByPullRequestsReferences: [],
          },
          pulls: [],
          nextPullNumber: 77,
          nextCommentId: 1000,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "sourcey-preview-123",
          kind: "message",
          title: "Sourcey preview ready",
          status: "proposed",
          thread_locator: "github://example/repo/issues/123",
          metadata: {
            schema_version: "runx.outbox-entry.message.v1",
            channel: "github_issue_comment",
            body_markdown: "I built a private Sourcey preview for this repo.",
          },
        },
        next_status: "published",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "sourcey-preview-123",
          kind: "message",
          locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
          status: "published",
          thread_locator: "github://example/repo/issues/123",
          metadata: {
            comment_id: "1000",
            channel: "github_issue_comment",
            outbox_receipt_id: expect.any(String),
          },
        },
        thread: {
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          outbox: expect.arrayContaining([
            expect.objectContaining({
              entry_id: "sourcey-preview-123",
              kind: "message",
              locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
              status: "published",
              metadata: expect.objectContaining({
                outbox_receipt_id: expect.any(String),
              }),
            }),
          ]),
        },
        push: {
          status: "pushed",
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          message: {
            locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
            comment_id: "1000",
          },
        },
      });
      expect(result.thread.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          entry_id: "comment-1000",
          body: "I built a private Sourcey preview for this repo.",
        }),
      ]));

      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        issue: {
          comments: [
            {
              id: "999",
              body: expect.stringContaining("Preexisting spoofed review body."),
              url: "https://github.com/example/repo/issues/123#issuecomment-999",
            },
            {
              id: "1000",
              body: expect.stringContaining("I built a private Sourcey preview for this repo."),
              url: "https://github.com/example/repo/issues/123#issuecomment-1000",
            },
          ],
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("edits an existing GitHub issue comment for a message outbox entry and returns the refreshed thread", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-message-edit-tool-"));
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Sourcey adoption thread",
            body: "Initial issue body.",
            url: "https://github.com/example/repo/issues/123",
            state: "OPEN",
            createdAt: "2026-04-22T00:00:00Z",
            updatedAt: "2026-04-22T00:00:00Z",
            author: {
              login: "maintainer",
            },
            comments: [
              {
                id: "1000",
                body: [
                  "Old review body.",
                  "",
                  "<!-- runx-outbox-envelope: v1 -->",
                  "<!-- runx-outbox-entry: sourcey-preview-123 -->",
                ].join("\n"),
                createdAt: "2026-04-22T01:00:00Z",
                updatedAt: "2026-04-22T01:00:00Z",
                url: "https://github.com/example/repo/issues/123#issuecomment-1000",
                author: {
                  login: "runx-bot",
                },
              },
            ],
            labels: [],
            closedByPullRequestsReferences: [],
          },
          pulls: [],
          nextPullNumber: 77,
          nextCommentId: 1001,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
        outbox_entry: {
          entry_id: "sourcey-preview-123",
          kind: "message",
          title: "Sourcey preview ready",
          status: "published",
          locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
          thread_locator: "github://example/repo/issues/123",
          metadata: {
            schema_version: "runx.outbox-entry.message.v1",
            channel: "github_issue_comment",
            comment_id: "1000",
            body_markdown: "Updated Sourcey preview review body.",
          },
        },
        next_status: "published",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "sourcey-preview-123",
          kind: "message",
          locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
          status: "published",
          metadata: {
            comment_id: "1000",
            channel: "github_issue_comment",
          },
        },
        push: {
          status: "pushed",
          message: {
            locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
            comment_id: "1000",
          },
        },
      });
      expect(result.thread.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          entry_id: "comment-1000",
          body: "Updated Sourcey preview review body.",
        }),
      ]));

      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        issue: {
          comments: [
            {
              id: "1000",
              body: expect.stringContaining("Updated Sourcey preview review body."),
              url: "https://github.com/example/repo/issues/123#issuecomment-1000",
            },
          ],
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("reuses the existing GitHub issue comment for a message outbox entry when the outgoing payload omits comment metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-message-reuse-tool-"));
    const fakeGh = path.join(tempDir, "fake-gh.mjs");
    const fakeState = path.join(tempDir, "fake-gh-state.json");

    try {
      await writeFile(
        fakeState,
        `${JSON.stringify({
          issue: {
            number: 123,
            title: "Sourcey adoption thread",
            body: "Initial issue body.",
            url: "https://github.com/example/repo/issues/123",
            state: "OPEN",
            createdAt: "2026-04-22T00:00:00Z",
            updatedAt: "2026-04-22T00:00:00Z",
            author: {
              login: "maintainer",
            },
            comments: [
              {
                id: "1000",
                body: [
                  "Old review body.",
                  "",
                  "<!-- runx-outbox-envelope: v1 -->",
                  "<!-- runx-outbox-entry: sourcey-preview-123 -->",
                ].join("\n"),
                createdAt: "2026-04-22T01:00:00Z",
                updatedAt: "2026-04-22T01:00:00Z",
                url: "https://github.com/example/repo/issues/123#issuecomment-1000",
                author: {
                  login: "runx-bot",
                },
              },
            ],
            labels: [],
            closedByPullRequestsReferences: [],
          },
          pulls: [],
          nextPullNumber: 77,
          nextCommentId: 1001,
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
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
          outbox: [
            {
              entry_id: "sourcey-preview-123",
              kind: "message",
              locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
              status: "published",
              thread_locator: "github://example/repo/issues/123",
              metadata: {
                schema_version: "runx.outbox-entry.message.v1",
                channel: "github_issue_comment",
                comment_id: "1000",
                outbox_receipt_id: "receipt-sourcey-preview-123",
              },
            },
          ],
          source_refs: [],
        },
        outbox_entry: {
          entry_id: "sourcey-preview-123",
          kind: "message",
          title: "Sourcey preview ready",
          status: "published",
          thread_locator: "github://example/repo/issues/123",
          metadata: {
            schema_version: "runx.outbox-entry.message.v1",
            channel: "github_issue_comment",
            outbox_receipt_id: "receipt-sourcey-preview-123",
            body_markdown: "Updated Sourcey preview review body.",
          },
        },
        next_status: "published",
      }, {
        RUNX_GH_BIN: fakeGh,
        RUNX_FAKE_GH_STATE: fakeState,
      });

      expect(result).toMatchObject({
        outbox_entry: {
          entry_id: "sourcey-preview-123",
          kind: "message",
          locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
          status: "published",
          metadata: {
            comment_id: "1000",
            channel: "github_issue_comment",
          },
        },
        push: {
          status: "pushed",
          message: {
            locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
            comment_id: "1000",
          },
        },
      });

      expect(JSON.parse(await readFile(fakeState, "utf8"))).toMatchObject({
        issue: {
          comments: [
            {
              id: "1000",
              body: expect.stringContaining("Updated Sourcey preview review body."),
              url: "https://github.com/example/repo/issues/123#issuecomment-1000",
            },
          ],
        },
        nextCommentId: 1001,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});

function runTool(inputs: Readonly<Record<string, unknown>>, envOverrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...envOverrides,
    RUNX_INPUTS_JSON: JSON.stringify(inputs),
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const result = spawnSync("node", [toolPath], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env,
  });
  expect(result.status).toBe(0);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "tool failed");
  }
  return JSON.parse(result.stdout);
}

async function initGitHubWorkspace(workspace: string, remote: string, branch: string): Promise<void> {
  runChecked("git", ["init", "--bare", remote], path.dirname(remote));
  runChecked("git", ["init", "-b", "main", workspace], path.dirname(workspace));
  runChecked("git", ["-C", workspace, "config", "user.email", "smoke@example.com"], path.dirname(workspace));
  runChecked("git", ["-C", workspace, "config", "user.name", "Smoke Test"], path.dirname(workspace));
  await writeFile(path.join(workspace, "README.md"), "base\n");
  runChecked("git", ["-C", workspace, "add", "README.md"], path.dirname(workspace));
  runChecked("git", ["-C", workspace, "commit", "-m", "init"], path.dirname(workspace));
  runChecked("git", ["-C", workspace, "remote", "add", "origin", remote], path.dirname(workspace));
  runChecked("git", ["-C", workspace, "checkout", "-b", branch], path.dirname(workspace));
  await writeFile(path.join(workspace, "README.md"), "updated\n");
  runChecked("git", ["-C", workspace, "add", "README.md"], path.dirname(workspace));
  runChecked("git", ["-C", workspace, "commit", "-m", "change"], path.dirname(workspace));
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

if (args[0] === "issue" && args[1] === "comment") {
  const issueNumber = args[2];
  const repo = readFlag(args, "--repo");
  const body = readFlag(args, "--body");
  const id = String(state.nextCommentId ?? 1000);
  state.nextCommentId = Number(id) + 1;
  const comment = {
    id,
    body,
    createdAt: "2026-04-22T01:00:00Z",
    updatedAt: "2026-04-22T01:00:00Z",
    url: \`https://github.com/\${repo}/issues/\${issueNumber}#issuecomment-\${id}\`,
    author: {
      login: "runx-bot",
    },
  };
  state.issue.comments.push(comment);
  state.issue.updatedAt = "2026-04-22T01:00:00Z";
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stdout.write(\`\${comment.url}\\n\`);
  process.exit(0);
}

if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/comments\\/\\d+$/.test(args[1] || "")) {
  const body = readField(args, "body");
  const commentId = (args[1] || "").split("/").pop();
  const comment = state.issue.comments.find((candidate) => String(candidate.id) === String(commentId));
  if (!comment) {
    throw new Error(\`unknown comment \${commentId}\`);
  }
  comment.body = body;
  comment.updatedAt = "2026-04-22T02:00:00Z";
  state.issue.updatedAt = "2026-04-22T02:00:00Z";
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stdout.write(JSON.stringify(comment));
  process.exit(0);
}

if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/pulls$/.test(args[1] || "")) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  state.ghTokens = [...(state.ghTokens || []), token];
  if ((state.failPrCreateTokens || []).includes(token)) {
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(\`token \${token} cannot create pull requests\\n\`);
    process.exit(1);
  }
  if ((state.failPrCreateCount ?? 0) > 0) {
    state.failPrCreateCount -= 1;
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(state.failPrCreateMessage || "GraphQL: Head sha can't be blank, Head repository can't be blank, No commits between example:main and example:issue-list-failure, not all refs are readable\\n");
    process.exit(1);
  }
  const repo = (args[1] || "").replace(/^repos\\//, "").replace(/\\/pulls$/, "");
  const head = readField(args, "head");
  const base = readField(args, "base");
  const title = readField(args, "title");
  const body = readField(args, "body");
  const number = state.nextPullNumber++;
  const pull = {
    number,
    repo,
    title,
    body,
    url: \`https://github.com/\${repo}/pull/\${number}\`,
    state: "OPEN",
    isDraft: readField(args, "draft") === "true",
    headRefName: head,
    baseRefName: base,
    updatedAt: "2026-04-22T01:00:00Z",
  };
  state.pulls.push(pull);
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stdout.write(args.includes("--jq") ? \`\${pull.url}\\n\` : JSON.stringify(pull));
  process.exit(0);
}

if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(args[1] || "")) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  state.ghMutationTokens = [...(state.ghMutationTokens || []), token];
  if ((state.failPrMutationTokens || []).includes(token)) {
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(\`token \${token} cannot update pull requests\\n\`);
    process.exit(1);
  }
  const pull = findPull(state.pulls, (args[1] || "").split("/").pop());
  pull.title = readField(args, "title") || pull.title;
  pull.body = readField(args, "body") || pull.body;
  pull.baseRefName = readField(args, "base") || pull.baseRefName;
  pull.updatedAt = "2026-04-22T01:00:00Z";
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stdout.write(JSON.stringify(pull));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  state.ghListTokens = [...(state.ghListTokens || []), token];
  if ((state.failPrListTokens || []).includes(token)) {
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(\`token \${token} cannot list pull requests\\n\`);
    process.exit(1);
  }
  if (state.failPrList && args.includes("--head")) {
    process.stderr.write("preflight lookup failed\\n");
    process.exit(1);
  }
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stdout.write(JSON.stringify(state.pulls));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const repo = readFlag(args, "--repo");
  const head = readFlag(args, "--head");
  const base = readFlag(args, "--base");
  const title = readFlag(args, "--title");
  const body = readFlag(args, "--body") || readBodyFile(args, "--body-file");
  const number = state.nextPullNumber++;
  state.lastPrCreateArgs = args;
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
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  state.ghMutationTokens = [...(state.ghMutationTokens || []), token];
  if ((state.failPrMutationTokens || []).includes(token)) {
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(\`token \${token} cannot edit pull requests\\n\`);
    process.exit(1);
  }
  const ref = args[2];
  const pull = findPull(state.pulls, ref);
  pull.title = readFlag(args, "--title");
  pull.body = readFlag(args, "--body");
  pull.baseRefName = readFlag(args, "--base") || pull.baseRefName;
  pull.updatedAt = "2026-04-22T01:00:00Z";
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "reopen") {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  state.ghMutationTokens = [...(state.ghMutationTokens || []), token];
  if ((state.failPrMutationTokens || []).includes(token)) {
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(\`token \${token} cannot reopen pull requests\\n\`);
    process.exit(1);
  }
  const pull = findPull(state.pulls, args[2]);
  pull.state = "OPEN";
  pull.updatedAt = "2026-04-22T01:00:00Z";
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  state.ghViewTokens = [...(state.ghViewTokens || []), token];
  if ((state.failPrViewTokens || []).includes(token)) {
    writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
    process.stderr.write(\`token \${token} cannot view pull requests\\n\`);
    process.exit(1);
  }
  const pull = findPull(state.pulls, args[2]);
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
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

function readField(argv, key) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "-f" && argv[index] !== "-F") {
      continue;
    }
    const value = argv[index + 1] || "";
    if (value.startsWith(\`\${key}=\`)) {
      return value.slice(key.length + 1);
    }
  }
  return "";
}

function readBodyFile(argv, flag) {
  const value = readFlag(argv, flag);
  if (!value) {
    return "";
  }
  if (value === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(value, "utf8");
}
`,
    { mode: 0o755 },
  );
}

async function writeFakeCurlScript(scriptPath: string): Promise<void> {
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
const authHeader = readHeader(args, "Authorization");
const token = authHeader.replace(/^Bearer\\s+/, "");
state.curlTokens = [...(state.curlTokens || []), token];

if (token === "bad-token") {
  writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
  process.stderr.write("bad token cannot create pull requests\\n");
  process.exit(22);
}

const repo = (readFlag(args, "--url").match(/\\/repos\\/([^/]+\\/[^/]+)\\/pulls$/) || [])[1];
const payload = JSON.parse(readFileSync(0, "utf8"));
const number = state.nextPullNumber++;
const pull = {
  number,
  repo,
  title: payload.title,
  body: payload.body,
  url: \`https://github.com/\${repo}/pull/\${number}\`,
  html_url: \`https://github.com/\${repo}/pull/\${number}\`,
  state: "OPEN",
  isDraft: payload.draft === true,
  headRefName: payload.head,
  baseRefName: payload.base,
  updatedAt: "2026-04-22T01:00:00Z",
};
state.pulls.push(pull);
writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`);
process.stdout.write(JSON.stringify(pull));

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : "";
}

function readHeader(argv, headerName) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "--header") {
      continue;
    }
    const value = argv[index + 1] || "";
    const prefix = \`\${headerName}:\`;
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length).trim();
    }
  }
  return "";
}
`,
    { mode: 0o755 },
  );
}

function runChecked(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  expect(result.status).toBe(0);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "command failed");
  }
  return result.stdout.trim();
}

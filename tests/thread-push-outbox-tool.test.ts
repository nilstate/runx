import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const toolPath = path.resolve("tools/thread/push_outbox/run.mjs");

describe("thread.push_outbox tool", () => {
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

  it("pushes a GitHub issue comment for a message outbox entry and returns the refreshed thread", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-gh-message-tool-"));
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
          },
        },
        thread: {
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          outbox: [
            {
              entry_id: "sourcey-preview-123",
              kind: "message",
              locator: "https://github.com/example/repo/issues/123#issuecomment-1000",
              status: "published",
            },
          ],
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
});

function runTool(inputs: Readonly<Record<string, unknown>>, envOverrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("node", [toolPath], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      ...envOverrides,
      RUNX_INPUTS_JSON: JSON.stringify(inputs),
    },
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
  const body = readFlag(args, "-f")?.replace(/^body=/, "");
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
  const ref = args[2];
  const pull = findPull(state.pulls, ref);
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

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const toolPath = path.resolve("tools/subject_memory/push_outbox/run.mjs");

describe("subject_memory.push_outbox tool", () => {
  it("skips cleanly when subject memory is not present", () => {
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
        reason: "subject_memory not provided",
      },
    });
  });

  it("pushes an outbox entry through the file subject-memory adapter and returns refreshed memory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-subject-memory-tool-"));
    const memoryPath = path.join(tempDir, "subject-memory.json");

    try {
      await writeFile(
        memoryPath,
        `${JSON.stringify({
          kind: "runx.subject-memory.v1",
          adapter: {
            type: "file",
            adapter_ref: memoryPath,
          },
          subject: {
            subject_kind: "work_item",
            subject_locator: "local://provider/issues/123",
          },
          entries: [],
          decisions: [],
          subject_outbox: [],
          source_refs: [],
        }, null, 2)}\n`,
      );

      const result = runTool({
        subject_memory: {
          kind: "runx.subject-memory.v1",
          adapter: {
            type: "file",
            adapter_ref: memoryPath,
          },
          subject: {
            subject_kind: "work_item",
            subject_locator: "local://provider/issues/123",
          },
          entries: [],
          decisions: [],
          subject_outbox: [],
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
          subject_locator: "local://provider/issues/123",
        },
        subject_memory: {
          subject_outbox: [
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
            adapter_ref: memoryPath,
          },
        },
      });

      expect(JSON.parse(await readFile(memoryPath, "utf8"))).toMatchObject({
        subject_outbox: [
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

  it("pushes a GitHub draft pull request, rehydrates the issue thread, and returns refreshed subject memory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-subject-memory-gh-tool-"));
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
        }, null, 2)}\n`,
      );
      await writeFakeGhScript(fakeGh);

      const result = runTool({
        subject_memory: {
          kind: "runx.subject-memory.v1",
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          subject: {
            subject_kind: "work_item",
            subject_locator: "github://example/repo/issues/123",
            canonical_uri: "https://github.com/example/repo/issues/123",
          },
          entries: [],
          decisions: [],
          subject_outbox: [],
          source_refs: [],
        },
        outbox_entry: {
          entry_id: "pull_request:issue-123",
          kind: "pull_request",
          title: "Fix fixture behavior",
          status: "proposed",
          subject_locator: "github://example/repo/issues/123",
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: "issue-123",
          subject: {
            subject_locator: "github://example/repo/issues/123",
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
          subject_locator: "github://example/repo/issues/123",
        },
        subject_memory: {
          adapter: {
            type: "github",
            adapter_ref: "example/repo#issue/123",
          },
          subject: {
            subject_locator: "github://example/repo/issues/123",
          },
          subject_outbox: [
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
  });
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

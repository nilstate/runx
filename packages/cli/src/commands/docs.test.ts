import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Caller } from "@runxhq/core/runner-local";

const runLocalSkill = vi.fn();

vi.mock("@runxhq/adapters", () => ({
  resolveDefaultSkillAdapters: vi.fn(async () => []),
}));

vi.mock("@runxhq/core/tool-catalogs", () => ({
  resolveEnvToolCatalogAdapters: vi.fn(() => []),
}));

vi.mock("@runxhq/core/runner-local", () => ({
  runLocalSkill,
}));

vi.mock("../runtime-assets.js", () => ({
  resolveBundledCliVoiceProfilePath: vi.fn(async () => undefined),
}));

const { handleDocsCommand } = await import("./docs.js");
type DocsCommandArgs = import("./docs.js").DocsCommandArgs;

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

const deps = {
  resolveRegistryStoreForChains: async () => undefined,
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("handleDocsCommand", () => {
  it("rebuilds and refreshes the same docs PR review thread through rerun", async () => {
    const sourceyRoot = await mkDocsRoot();
    const thread = {
      thread_locator: "github://sourcey/sourcey.com/issues/2",
      canonical_uri: "https://github.com/sourcey/sourcey.com/issues/2",
      outbox: [
        {
          entry_id: "message:docs-refresh-example-repo:review",
          kind: "message",
          locator: "https://github.com/sourcey/sourcey.com/issues/2#issuecomment-1",
          metadata: {
            body_markdown: "## Exact PR Body",
            control: {
              workflow: "docs",
              lane: "pr_review",
              task_id: "docs-refresh-example-repo",
            },
          },
        },
      ],
    };
    vi.stubGlobal("__runxDocsThreadFixture", thread);
    runLocalSkill
      .mockResolvedValueOnce(successSkillResult({
        target: { repo_slug: "example/repo" },
      }))
      .mockResolvedValueOnce(successSkillResult({
        operator_summary: {
          should_open_pr: true,
          rationale: "The generated docs bundle is stronger than the current docs surface.",
        },
        before_after_evidence: {
          build_url: "https://sourcey.com/previews/example/repo/index.html",
        },
      }))
      .mockResolvedValueOnce(successSkillResult({
        package_summary: {
          should_push: false,
        },
        review_outbox_entry: {
          entry_id: "message:docs-refresh-example-repo:review",
          locator: "https://github.com/sourcey/sourcey.com/issues/2#issuecomment-1",
        },
        push: {
          status: "skipped",
        },
      }));

    const result = await handleDocsCommand(
      {
        command: "docs",
        docsAction: "rerun",
        inputs: {
          issue: "sourcey/sourcey.com#issue/2",
          "repo-root": "/tmp/example-repo",
          "sourcey-root": sourceyRoot,
        },
      } satisfies DocsCommandArgs,
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_DOCS_THREAD_ADAPTER_PATH: path.join(sourceyRoot, "adapter.mjs"),
      },
      caller,
      deps,
    );

    expect(result).toMatchObject({
      status: "success",
      action: "rerun",
      task_id: "docs-refresh-example-repo",
      lane: "pull_request",
      preview_url: "https://sourcey.com/previews/example/repo/index.html",
      review_comment_url: "https://github.com/sourcey/sourcey.com/issues/2#issuecomment-1",
    });
    expect(runLocalSkill).toHaveBeenCalledTimes(3);
    expect(runLocalSkill.mock.calls[2]?.[0]).toMatchObject({
      runner: "docs-pr",
      inputs: expect.objectContaining({
        task_id: "docs-refresh-example-repo",
        push_pr: false,
      }),
    });
  });

  it("reduces a docs signal from the latest review handoff on the thread", async () => {
    const sourceyRoot = await mkDocsRoot();
    const thread = {
      thread_locator: "github://sourcey/sourcey.com/issues/2",
      canonical_uri: "https://github.com/sourcey/sourcey.com/issues/2",
      outbox: [
        {
          entry_id: "message:docs-refresh-example-repo:review",
          kind: "message",
          locator: "https://github.com/sourcey/sourcey.com/issues/2#issuecomment-1",
          metadata: {
            body_markdown: "## Exact PR Body",
            control: {
              workflow: "docs",
              lane: "pr_review",
              task_id: "docs-refresh-example-repo",
              handoff_ref: {
                handoff_id: "sourcey.docs-pr:docs-refresh-example-repo",
                boundary_kind: "external_maintainer",
                thread_locator: "github://sourcey/sourcey.com/issues/2",
              },
            },
          },
        },
      ],
    };
    vi.stubGlobal("__runxDocsThreadFixture", thread);
    runLocalSkill.mockResolvedValueOnce(successSkillResult({
      handoff_state: {
        status: "needs_revision",
        summary: "needs_revision from issue_comment (requested_changes)",
      },
      operator_summary: {
        summary: "needs_revision from issue_comment (requested_changes)",
      },
    }));

    const result = await handleDocsCommand(
      {
        command: "docs",
        docsAction: "signal",
        inputs: {
          issue: "sourcey/sourcey.com#issue/2",
          "sourcey-root": sourceyRoot,
          source: "issue_comment",
          disposition: "requested_changes",
          "source-ref": "https://github.com/sourcey/sourcey.com/issues/2#issuecomment-99",
        },
      } satisfies DocsCommandArgs,
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_DOCS_THREAD_ADAPTER_PATH: path.join(sourceyRoot, "adapter.mjs"),
      },
      caller,
      deps,
    );

    expect(result).toMatchObject({
      status: "success",
      action: "signal",
      task_id: "docs-refresh-example-repo",
      lane: "pull_request",
      handoff_state: {
        status: "needs_revision",
      },
    });
    expect(runLocalSkill).toHaveBeenCalledTimes(1);
    expect(runLocalSkill.mock.calls[0]?.[0]).toMatchObject({
      runner: "docs-signal",
      inputs: expect.objectContaining({
        signal_source: "issue_comment",
        signal_disposition: "requested_changes",
        docs_pr_packet: expect.objectContaining({
          handoff_ref: expect.objectContaining({
            handoff_id: "sourcey.docs-pr:docs-refresh-example-repo",
          }),
        }),
      }),
    });
  });

  it("normalizes docs rerun repo-root inputs to the git top-level", async () => {
    const sourceyRoot = await mkDocsRoot();
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "runx-docs-repo-"));
    tempDirs.push(repoRoot);
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    const nestedRoot = path.join(repoRoot, "packages", "easyllm");
    await mkdir(nestedRoot, { recursive: true });
    const thread = {
      thread_locator: "github://sourcey/sourcey.com/issues/2",
      canonical_uri: "https://github.com/sourcey/sourcey.com/issues/2",
      outbox: [],
    };
    vi.stubGlobal("__runxDocsThreadFixture", thread);
    runLocalSkill
      .mockResolvedValueOnce(successSkillResult({
        target: { repo_slug: "example/repo" },
      }))
      .mockResolvedValueOnce(successSkillResult({
        operator_summary: {
          should_open_pr: true,
          rationale: "ready",
        },
        before_after_evidence: {
          build_url: "https://sourcey.com/previews/example/repo/index.html",
        },
      }))
      .mockResolvedValueOnce(successSkillResult({
        package_summary: {
          should_push: false,
        },
        review_outbox_entry: {
          entry_id: "message:docs-refresh-example-repo:review",
          locator: "https://github.com/sourcey/sourcey.com/issues/2#issuecomment-1",
        },
      }));

    await handleDocsCommand(
      {
        command: "docs",
        docsAction: "rerun",
        inputs: {
          issue: "sourcey/sourcey.com#issue/2",
          "repo-root": nestedRoot,
          "sourcey-root": sourceyRoot,
        },
      } satisfies DocsCommandArgs,
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_DOCS_THREAD_ADAPTER_PATH: path.join(sourceyRoot, "adapter.mjs"),
      },
      caller,
      deps,
    );

    expect(runLocalSkill.mock.calls[0]?.[0]).toMatchObject({
      runner: "docs-scan",
      inputs: expect.objectContaining({
        repo_root: repoRoot,
      }),
    });
  });

  it("returns a managed-agent hint when docs-build pauses on cognitive work", async () => {
    const sourceyRoot = await mkDocsRoot();
    const thread = {
      thread_locator: "github://sourcey/sourcey.com/issues/2",
      canonical_uri: "https://github.com/sourcey/sourcey.com/issues/2",
      outbox: [],
    };
    vi.stubGlobal("__runxDocsThreadFixture", thread);
    runLocalSkill
      .mockResolvedValueOnce(successSkillResult({
        target: { repo_slug: "example/repo" },
      }))
      .mockResolvedValueOnce({
        status: "needs_resolution",
        skillPath: path.join(sourceyRoot, "skills", "docs-build"),
        runId: "rx_docs_build",
        stepIds: ["shape-brief"],
        stepLabels: ["shape native docs brief"],
        requests: [
          {
            id: "req_1",
            kind: "cognitive_work",
            work: {
              id: "req_1",
              source_type: "agent-step",
              skill: "docs-build",
            },
          },
        ],
      });

    const result = await handleDocsCommand(
      {
        command: "docs",
        docsAction: "rerun",
        inputs: {
          issue: "sourcey/sourcey.com#issue/2",
          "repo-root": "/tmp/example-repo",
          "sourcey-root": sourceyRoot,
        },
      } satisfies DocsCommandArgs,
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_DOCS_THREAD_ADAPTER_PATH: path.join(sourceyRoot, "adapter.mjs"),
      },
      caller,
      deps,
    );

    expect(result).toMatchObject({
      status: "needs_resolution",
      phase: "build",
    });
    expect(result.message).toContain("shape native docs brief");
    expect(result.message).toContain("RUNX_AGENT_PROVIDER");
  });
});

async function mkDocsRoot(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-docs-command-"));
  tempDirs.push(tempDir);
  await mkdir(path.join(tempDir, "skills", "docs-scan"), { recursive: true });
  await mkdir(path.join(tempDir, "skills", "docs-build"), { recursive: true });
  await mkdir(path.join(tempDir, "skills", "docs-pr"), { recursive: true });
  await mkdir(path.join(tempDir, "skills", "docs-signal"), { recursive: true });
  await writeFile(
    path.join(tempDir, "adapter.mjs"),
    `export function parseGitHubIssueRef(value) {
  return {
    repo_slug: "sourcey/sourcey.com",
    issue_number: "2",
    adapter_ref: "sourcey/sourcey.com#issue/2",
    thread_locator: "github://sourcey/sourcey.com/issues/2",
    issue_url: "https://github.com/sourcey/sourcey.com/issues/2",
  };
}
export function fetchGitHubIssueThread() {
  return globalThis.__runxDocsThreadFixture;
}
`,
    "utf8",
  );
  return tempDir;
}

function successSkillResult(data: Record<string, unknown>) {
  return {
    status: "success",
    execution: {
      stdout: JSON.stringify({
        schema: "runx.test.packet.v1",
        data,
      }),
      stderr: "",
      exitCode: 0,
    },
    receipt: {
      id: "receipt-test",
    },
  };
}

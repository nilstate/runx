import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/dogfood-github-issue-to-pr.mjs");

describe("GitHub issue-to-PR dogfood script", () => {
  it("reports a ready read-only preflight without hydrating GitHub", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dogfood-preflight-"));

    try {
      const workspace = path.join(tempDir, "workspace");
      const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
      await mkdir(path.join(workspace, ".scafld"), { recursive: true });
      initGitWorkspace(workspace, "issue-123");
      await writeFakeScafld(fakeScafld);

      const result = runDogfood([
        "--preflight",
        "--repo", "example/repo",
        "--issue", "123",
        "--workspace", workspace,
        "--scafld-bin", fakeScafld,
      ], {
        RUNX_BIN: undefined,
      });

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        status: "ready",
        reason: "dogfood_preflight_ready",
        mode: "github_issue_to_pr",
        repo: "example/repo",
        issue: {
          number: "123",
        },
        checks: {
          workspace: {
            status: "ready",
          },
          scafld: {
            status: "ready",
            source: "flag:--scafld-bin",
          },
          branch: {
            status: "ready",
            expected: "issue-123",
            current: "issue-123",
          },
          runx_bin: {
            status: "skipped",
            source: "env:RUNX_BIN",
          },
          github: {
            status: "deferred",
          },
        },
      });
      expect(payload.next_command).toContain("pnpm dogfood:github-issue-to-pr --");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks with a clear RUNX_BIN diagnostic when the configured CLI cannot start", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dogfood-runx-bin-"));

    try {
      const workspace = path.join(tempDir, "workspace");
      const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
      const missingRunx = path.join(tempDir, "missing-runx");
      await mkdir(path.join(workspace, ".scafld"), { recursive: true });
      initGitWorkspace(workspace, "issue-123");
      await writeFakeScafld(fakeScafld);

      const result = runDogfood([
        "--preflight",
        "--repo", "example/repo",
        "--issue", "123",
        "--workspace", workspace,
        "--scafld-bin", fakeScafld,
      ], {
        RUNX_BIN: missingRunx,
      });

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.reason).toBe("dogfood_preflight_blocked");
      expect(payload.checks.runx_bin).toMatchObject({
        name: "RUNX_BIN",
        status: "blocked",
        source: "env:RUNX_BIN",
        requested: missingRunx,
        resolved: missingRunx,
      });
      expect(payload.checks.runx_bin.next).toContain("Unset RUNX_BIN");
      expect(payload.next_action).toContain("Fix the blocked preflight checks");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks live publication when the workspace is on the wrong branch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dogfood-branch-"));

    try {
      const workspace = path.join(tempDir, "workspace");
      const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
      await mkdir(path.join(workspace, ".scafld"), { recursive: true });
      initGitWorkspace(workspace, "main");
      await writeFakeScafld(fakeScafld);

      const result = runDogfood([
        "--preflight",
        "--repo", "example/repo",
        "--issue", "123",
        "--workspace", workspace,
        "--scafld-bin", fakeScafld,
      ], {
        RUNX_BIN: undefined,
      });

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(payload.checks.branch).toMatchObject({
        name: "git_branch",
        status: "blocked",
        expected: "issue-123",
        current: "main",
        reason: "workspace is not on the intended issue branch.",
      });
      expect(payload.checks.branch.next).toContain("git switch issue-123");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows explicit branch preparation when the workspace is clean", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-dogfood-branch-prepare-"));

    try {
      const workspace = path.join(tempDir, "workspace");
      const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
      await mkdir(path.join(workspace, ".scafld"), { recursive: true });
      await writeFile(path.join(workspace, ".scafld", "config.yaml"), "project: fixture\n");
      initGitWorkspace(workspace, "main");
      commitWorkspace(workspace);
      await writeFakeScafld(fakeScafld);

      const result = runDogfood([
        "--preflight",
        "--prepare-branch",
        "--repo", "example/repo",
        "--issue", "123",
        "--workspace", workspace,
        "--scafld-bin", fakeScafld,
      ], {
        RUNX_BIN: undefined,
      });

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.checks.branch).toMatchObject({
        name: "git_branch",
        status: "ready",
        expected: "issue-123",
        current: "main",
        action: "create_branch",
      });
      expect(payload.next_command).toContain("--prepare-branch");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function runDogfood(args: readonly string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  return spawnSync("node", [scriptPath, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env,
  });
}

function initGitWorkspace(workspace: string, branch: string) {
  const commands = [
    ["git", ["init", "-b", branch]],
    ["git", ["config", "user.email", "test@example.com"]],
    ["git", ["config", "user.name", "Test User"]],
  ] as const;
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  }
}

function commitWorkspace(workspace: string) {
  const commands = [
    ["git", ["add", "."]],
    ["git", ["commit", "-m", "init"]],
  ] as const;
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  }
}

async function writeFakeScafld(script: string): Promise<void> {
  await writeFile(
    script,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "list" && argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ ok: true, command: "list", result: [] }) + "\\n");
  process.exit(0);
}
process.stderr.write("unsupported fake scafld command\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
}

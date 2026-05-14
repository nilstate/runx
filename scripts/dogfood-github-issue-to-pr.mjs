#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat } from "node:fs/promises";

import { createDefaultLocalSkillRuntime } from "@runxhq/adapters";
import { runLocalSkill } from "@runxhq/runtime-local";
import {
  fetchGitHubIssueThread,
  firstNonEmptyString,
  parseGitHubIssueRef,
  selectPreferredGitHubPullRequest,
} from "../tools/thread/github_adapter.mjs";
import { sanitizePublicMarkdown } from "../tools/public_markdown.mjs";

class DogfoodPreflightError extends Error {
  constructor(preflight) {
    super("dogfood preflight blocked the GitHub issue-to-PR run.");
    this.preflight = preflight;
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const issueRef = parseGitHubIssueRef(`${requiredFlag(args, "repo")}#issue/${requiredFlag(args, "issue")}`);
  const workspace = path.resolve(requiredFlag(args, "workspace"));
  const taskId = firstNonEmptyString(args.task_id, args.branch, `issue-${issueRef.issue_number}`);
  const branchName = firstNonEmptyString(args.branch, taskId);
  const scafldBin = firstNonEmptyString(
    args.scafld_bin,
    process.env.SCAFLD_BIN,
    "scafld",
  );
  const preflight = await buildDogfoodPreflight({
    args,
    issueRef,
    workspace,
    scafldBin,
    taskId,
    branchName,
  });

  if (args.preflight) {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    process.exitCode = preflight.status === "ready" ? 0 : 1;
  } else if (preflight.status === "blocked") {
    throw new DogfoodPreflightError(preflight);
  } else {
    prepareDogfoodBranch({
      workspace,
      branchName,
      prepareBranch: args.prepare_branch === true,
    });
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `runx-github-issue-to-pr-${taskId}-`));
    const runtime = await createDefaultLocalSkillRuntime({
      root: runtimeRoot,
      receiptDir: args.receipt_dir ? path.resolve(args.receipt_dir) : undefined,
      runxHome: args.runx_home ? path.resolve(args.runx_home) : undefined,
      env: process.env,
    });

    const before = fetchGitHubIssueThread({
      adapterRef: issueRef.adapter_ref,
      env: runtime.env,
      cwd: workspace,
    });
    const caller = await createAnswersCaller(args.answers);
    const result = await runLocalSkill({
      skillPath: path.resolve("skills/issue-to-pr"),
      inputs: {
        fixture: workspace,
        task_id: taskId,
        thread_title: firstNonEmptyString(before.title, `Issue #${issueRef.issue_number}`),
        thread_body: firstIssueBody(before),
        thread_locator: issueRef.thread_locator,
        thread: before,
        target_repo: issueRef.repo_slug,
        branch: branchName,
        scafld_bin: scafldBin,
      },
      caller,
      adapters: runtime.adapters,
      env: runtime.env,
      receiptDir: runtime.paths.receiptDir,
      runxHome: runtime.paths.runxHome,
    });
    const after = fetchGitHubIssueThread({
      adapterRef: issueRef.adapter_ref,
      env: runtime.env,
      cwd: workspace,
    });

    const executionPayload = result.status === "success"
      ? safeJsonParse(result.execution.stdout)
      : undefined;
    const preferredBeforePull = selectPreferredGitHubPullRequest(
      before.outbox.map((entry) => ({
        number: optionalNumber(entry.metadata?.number),
        url: entry.locator,
        headRefName: entry.metadata?.branch,
        updatedAt: entry.metadata?.updated_at,
        isDraft: entry.status === "draft",
        state: entry.status === "closed" ? "CLOSED" : "OPEN",
      })),
      branchName,
    );
    const preferredAfterPull = selectPreferredGitHubPullRequest(
      after.outbox.map((entry) => ({
        number: optionalNumber(entry.metadata?.number),
        url: entry.locator,
        headRefName: entry.metadata?.branch,
        updatedAt: entry.metadata?.updated_at,
        isDraft: entry.status === "draft",
        state: entry.status === "closed" ? "CLOSED" : "OPEN",
      })),
      branchName,
    );

    const output = {
      status: result.status,
      task_id: taskId,
      repo: issueRef.repo_slug,
      issue: {
        number: issueRef.issue_number,
        url: issueRef.issue_url,
      },
      workspace,
      receipt_dir: runtime.paths.receiptDir,
      runx_home: runtime.paths.runxHome,
      before: summarizeThread(before, preferredBeforePull),
      after: summarizeThread(after, preferredAfterPull),
      execution: executionPayload,
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (result.status !== "success") {
      process.exitCode = 1;
    }
  }
} catch (error) {
  if (error instanceof DogfoodPreflightError) {
    process.stdout.write(`${JSON.stringify(error.preflight, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({
      status: "blocked",
      reason: "github_issue_thread_unavailable",
      error: {
        message: sanitizePublicMarkdown(errorMessage(error)),
      },
      next: "Provide a real --repo, --issue, --workspace, and GitHub CLI auth context, then rerun the dogfood command.",
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredFlag(argsRecord, key) {
  const value = firstNonEmptyString(argsRecord[key]);
  if (!value) {
    throw new Error(`--${key.replace(/_/g, "-")} is required.`);
  }
  return value;
}

async function buildDogfoodPreflight({ args: argsRecord, issueRef, workspace, scafldBin, taskId, branchName }) {
  const workspaceCheck = await inspectWorkspace(workspace);
  const scafldCheck = workspaceCheck.status === "ready"
    ? inspectCommand({
      name: "SCAFLD_BIN",
      source: argsRecord.scafld_bin
        ? "flag:--scafld-bin"
        : process.env.SCAFLD_BIN
          ? "env:SCAFLD_BIN"
          : "path:scafld",
      command: resolveCommandCandidate(scafldBin, process.cwd()),
      requested: scafldBin,
      args: ["list", "--json"],
      cwd: workspace,
      next: "Set --scafld-bin or SCAFLD_BIN to the scafld executable and verify `scafld list --json` from the target workspace.",
    })
    : {
      name: "SCAFLD_BIN",
      status: "skipped",
      source: argsRecord.scafld_bin
        ? "flag:--scafld-bin"
        : process.env.SCAFLD_BIN
          ? "env:SCAFLD_BIN"
          : "path:scafld",
      requested: scafldBin,
      reason: "workspace is not a scafld workspace",
    };
  const runxBinCheck = process.env.RUNX_BIN
    ? inspectCommand({
      name: "RUNX_BIN",
      source: "env:RUNX_BIN",
      command: resolveCommandCandidate(process.env.RUNX_BIN, process.cwd()),
      requested: process.env.RUNX_BIN,
      args: ["--help"],
      cwd: process.cwd(),
      next: "Unset RUNX_BIN or point it at the executable runx CLI for this checkout. Verify with `$RUNX_BIN --help`.",
    })
    : {
      name: "RUNX_BIN",
      status: "skipped",
      source: "env:RUNX_BIN",
      reason: "RUNX_BIN is not set; this script uses the local package runtime directly.",
    };
  const checks = {
    workspace: workspaceCheck,
    branch: workspaceCheck.status === "ready"
      ? inspectGitBranch(workspace, branchName, {
        prepareBranch: argsRecord.prepare_branch === true,
      })
      : {
          name: "git_branch",
          status: "skipped",
          reason: "workspace is not ready",
          expected: branchName,
        },
    scafld: scafldCheck,
    runx_bin: runxBinCheck,
    github: {
      status: "deferred",
      reason: "GitHub issue hydration runs after local runner and workspace checks.",
    },
  };
  const blocking = Object.values(checks).filter((check) => check.status === "blocked");
  const nextCommand = [
    "pnpm dogfood:github-issue-to-pr --",
    "--repo", issueRef.repo_slug,
    "--issue", issueRef.issue_number,
    "--workspace", shellQuote(workspace),
    taskId ? `--task-id ${shellQuote(taskId)}` : "",
    branchName && branchName !== taskId ? `--branch ${shellQuote(branchName)}` : "",
    argsRecord.prepare_branch ? "--prepare-branch" : "",
    argsRecord.scafld_bin ? `--scafld-bin ${shellQuote(argsRecord.scafld_bin)}` : "",
    argsRecord.answers ? `--answers ${shellQuote(argsRecord.answers)}` : "",
  ].filter(Boolean).join(" ");

  return {
    status: blocking.length > 0 ? "blocked" : "ready",
    reason: blocking.length > 0 ? "dogfood_preflight_blocked" : "dogfood_preflight_ready",
    mode: "github_issue_to_pr",
    repo: issueRef.repo_slug,
    issue: {
      number: issueRef.issue_number,
      url: issueRef.issue_url,
    },
    task_id: taskId,
    branch: branchName,
    workspace,
    checks,
    next_command: nextCommand,
    next_action: blocking.length > 0
      ? "Fix the blocked preflight checks, then rerun the dogfood command."
      : "Run the dogfood command to hydrate the GitHub issue and execute the governed lane.",
  };
}

async function inspectWorkspace(workspace) {
  try {
    const workspaceStat = await stat(workspace);
    if (!workspaceStat.isDirectory()) {
      return {
        status: "blocked",
        path: workspace,
        reason: "--workspace must be a directory.",
        next: "Point --workspace at the target repository root.",
      };
    }
  } catch (error) {
    return {
      status: "blocked",
      path: workspace,
      reason: `workspace is not readable: ${sanitizePublicMarkdown(errorMessage(error))}`,
      next: "Create or checkout the target repository and pass its root with --workspace.",
    };
  }

  const scafldDir = path.join(workspace, ".scafld");
  try {
    const scafldStat = await stat(scafldDir);
    if (!scafldStat.isDirectory()) {
      return {
        status: "blocked",
        path: workspace,
        scafld_dir: scafldDir,
        reason: "workspace .scafld path is not a directory.",
        next: "Run scafld init in the target repository before issue-to-pr live ops.",
      };
    }
  } catch {
    return {
      status: "blocked",
      path: workspace,
      scafld_dir: scafldDir,
      reason: "workspace is missing .scafld.",
      next: "Run scafld init in the target repository before issue-to-pr live ops.",
    };
  }

  return {
    status: "ready",
    path: workspace,
    scafld_dir: scafldDir,
  };
}

function inspectGitBranch(workspace, expectedBranch, options = {}) {
  const ref = spawnSync("git", ["check-ref-format", "--branch", expectedBranch], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (ref.status !== 0) {
    return {
      name: "git_branch",
      status: "blocked",
      expected: expectedBranch,
      reason: "intended issue branch is not a valid git branch name.",
      stderr: preview(sanitizePublicMarkdown(ref.stderr)),
      next: "Pass a valid --branch value or task id for live issue-to-PR.",
    };
  }

  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return {
      name: "git_branch",
      status: "blocked",
      expected: expectedBranch,
      reason: "--workspace must be a git worktree before live GitHub publication.",
      stderr: preview(sanitizePublicMarkdown(inside.stderr)),
      next: "Checkout the target repository, create the issue branch, and rerun the dogfood command.",
    };
  }

  const current = spawnSync("git", ["branch", "--show-current"], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  const currentBranch = current.stdout.trim();
  if (current.status !== 0 || !currentBranch) {
    return {
      name: "git_branch",
      status: "blocked",
      expected: expectedBranch,
      reason: "workspace branch could not be determined.",
      stderr: preview(sanitizePublicMarkdown(current.stderr)),
      next: `Checkout ${expectedBranch} in the target workspace before running live issue-to-PR.`,
    };
  }
  if (currentBranch !== expectedBranch) {
    const branchExists = gitBranchExists(workspace, expectedBranch);
    if (options.prepareBranch === true) {
      const status = spawnSync("git", ["status", "--porcelain=v1"], {
        cwd: workspace,
        encoding: "utf8",
        shell: false,
        env: process.env,
      });
      if (status.status !== 0) {
        return {
          name: "git_branch",
          status: "blocked",
          expected: expectedBranch,
          current: currentBranch,
          reason: "workspace status could not be checked before branch preparation.",
          stderr: preview(sanitizePublicMarkdown(status.stderr)),
          next: "Verify the target workspace with `git status`, then rerun the dogfood command.",
        };
      }
      if (status.stdout.trim().length > 0) {
        return {
          name: "git_branch",
          status: "blocked",
          expected: expectedBranch,
          current: currentBranch,
          action: branchExists ? "switch_existing" : "create_branch",
          reason: "workspace has uncommitted changes; refusing to switch or create the issue branch.",
          next: "Commit, stash, or clean the workspace before rerunning with --prepare-branch.",
        };
      }
      return {
        name: "git_branch",
        status: "ready",
        expected: expectedBranch,
        current: currentBranch,
        action: branchExists ? "switch_existing" : "create_branch",
        reason: branchExists
          ? "live run will switch to the intended issue branch before mutation."
          : "live run will create the intended issue branch before mutation.",
      };
    }
    return {
      name: "git_branch",
      status: "blocked",
      expected: expectedBranch,
      current: currentBranch,
      reason: "workspace is not on the intended issue branch.",
      next: `Run \`git switch ${expectedBranch}\` or rerun the dogfood command with --prepare-branch after confirming the workspace is clean.`,
    };
  }
  return {
    name: "git_branch",
    status: "ready",
    expected: expectedBranch,
    current: currentBranch,
  };
}

function prepareDogfoodBranch({ workspace, branchName, prepareBranch }) {
  const current = requireGitOutput(workspace, ["branch", "--show-current"]).trim();
  if (current === branchName) {
    return;
  }
  if (!prepareBranch) {
    throw new Error(`workspace is on branch '${current}', but live issue-to-PR requires '${branchName}'. Rerun with --prepare-branch after confirming the workspace is clean.`);
  }

  const status = requireGitOutput(workspace, ["status", "--porcelain=v1"]).trim();
  if (status.length > 0) {
    throw new Error("workspace has uncommitted changes; refusing to switch or create the issue branch.");
  }

  const args = gitBranchExists(workspace, branchName)
    ? ["switch", branchName]
    : ["switch", "-c", branchName];
  const switched = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (switched.status !== 0) {
    throw new Error(preview(sanitizePublicMarkdown(switched.stderr)) ?? `git ${args.join(" ")} failed.`);
  }

  const verified = requireGitOutput(workspace, ["branch", "--show-current"]).trim();
  if (verified !== branchName) {
    throw new Error(`workspace branch preparation ended on '${verified}', expected '${branchName}'.`);
  }
}

function gitBranchExists(workspace, branchName) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  return result.status === 0;
}

function requireGitOutput(workspace, args) {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(preview(sanitizePublicMarkdown(result.stderr)) ?? `git ${args.join(" ")} failed.`);
  }
  return result.stdout;
}

function inspectCommand({ name, source, command, requested, args: commandArgs, cwd, next }) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (result.error) {
    return {
      name,
      status: "blocked",
      source,
      requested,
      resolved: command,
      cwd,
      argv: [command, ...commandArgs],
      reason: sanitizePublicMarkdown(result.error.message),
      next,
    };
  }
  if (result.status !== 0) {
    return {
      name,
      status: "blocked",
      source,
      requested,
      resolved: command,
      cwd,
      argv: [command, ...commandArgs],
      exit_code: result.status,
      stderr: preview(sanitizePublicMarkdown(result.stderr)),
      stdout: preview(sanitizePublicMarkdown(result.stdout)),
      next,
    };
  }
  return {
    name,
    status: "ready",
    source,
    requested,
    resolved: command,
    cwd,
    argv: [command, ...commandArgs],
  };
}

function resolveCommandCandidate(candidate, baseDir) {
  const value = firstNonEmptyString(candidate);
  if (!value) {
    return value;
  }
  if (!value.includes(path.sep)) {
    return value;
  }
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function preview(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

async function createAnswersCaller(answersPath) {
  const answersDocument = answersPath
    ? safeJsonParse(await readFile(path.resolve(answersPath), "utf8"))
    : { answers: {} };
  const answers = isRecord(answersDocument?.answers) ? answersDocument.answers : {};
  return {
    resolve: async (request) => {
      if (request.kind !== "cognitive_work") {
        return undefined;
      }
      const payload = answers[request.id];
      if (!payload) {
        return undefined;
      }
      return {
        actor: "agent",
        payload,
      };
    },
    report: () => undefined,
  };
}

function firstIssueBody(state) {
  const issueEntry = state.entries.find((entry) => String(entry.entry_id).startsWith("issue-"));
  return firstNonEmptyString(issueEntry?.body);
}

function summarizeThread(state, preferredPull) {
  return {
    entries: state.entries.length,
    outbox: state.outbox.length,
    cursor: state.adapter.cursor,
    preferred_pull_request: preferredPull
      ? {
          number: firstNonEmptyString(preferredPull.number),
          url: firstNonEmptyString(preferredPull.url),
          branch: firstNonEmptyString(preferredPull.headRefName),
          is_draft: preferredPull.isDraft === true,
          state: firstNonEmptyString(preferredPull.state),
        }
      : undefined,
  };
}

function safeJsonParse(value) {
  return JSON.parse(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value) {
  const text = firstNonEmptyString(value);
  return text ? Number(text) : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

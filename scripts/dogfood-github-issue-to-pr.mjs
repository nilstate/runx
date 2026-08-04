#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  fetchGitHubIssueThread,
  firstNonEmptyString,
  parseGitHubIssueRef,
  pushGitHubMessage,
  selectPreferredGitHubPullRequest,
} from "../tools/thread/github_adapter.mjs";
import { sanitizePublicMarkdown } from "../tools/public_markdown.mjs";

const RUNX_OSS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISSUE_TO_PR_SKILL_PATH = path.join(RUNX_OSS_ROOT, "skills", "issue-to-pr");

class DogfoodPreflightError extends Error {
  constructor(preflight) {
    super("dogfood preflight blocked the GitHub issue-to-PR run.");
    this.preflight = preflight;
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(dogfoodHelp());
    process.exit(0);
  }
  const mode = normalizeMode(args);
  const resolved = resolveDogfoodConfig(args, { mode });
  if (!resolved.ok) {
    process.stdout.write(`${JSON.stringify(resolved.payload, null, 2)}\n`);
    process.exitCode = resolved.exitCode;
    process.exit(resolved.exitCode);
  }
  const issueRef = parseGitHubIssueRef(`${resolved.repo}#issue/${resolved.issue}`);
  const workspace = path.resolve(resolved.workspace);
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
    allowlist: resolved.allowlist,
  });

  if (mode === "preflight") {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    process.exitCode = preflight.status === "ready" ? 0 : 1;
  } else if (mode === "observe") {
    if (preflight.status === "blocked") {
      throw new DogfoodPreflightError(preflight);
    }
    const observed = observeDogfoodOutcome({
      issueRef,
      workspace,
      taskId,
      branchName,
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
  } else if (preflight.status === "blocked") {
    throw new DogfoodPreflightError(preflight);
  } else {
    const created = await createDogfoodIssueToPr({
      args,
      issueRef,
      workspace,
      scafldBin,
      taskId,
      branchName,
      preflight,
      allowlist: resolved.allowlist,
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    process.exitCode = dogfoodCreateExitCode(created);
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
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];
    const value = !next || next.startsWith("--")
      ? true
      : next;
    if (parsed[key] === undefined) {
      parsed[key] = value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
    if (!next || next.startsWith("--")) {
      continue;
    }
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

function normalizeMode(argsRecord) {
  const mode = firstNonEmptyString(argsRecord.mode);
  if (argsRecord.preflight === true) {
    return "preflight";
  }
  if (argsRecord.observe_outcome === true || mode === "observe" || mode === "outcome") {
    return "observe";
  }
  if (!mode || mode === "create" || mode === "live-create") {
    return "create";
  }
  if (mode === "preflight") {
    return "preflight";
  }
  throw new Error("--mode must be one of preflight, create, or observe.");
}

function resolveDogfoodConfig(argsRecord, { mode }) {
  const repo = firstNonEmptyString(argsRecord.repo, process.env.RUNX_LIVE_ISSUE_TO_PR_REPO);
  const issue = firstNonEmptyString(argsRecord.issue, process.env.RUNX_LIVE_ISSUE_TO_PR_ISSUE);
  const workspace = firstNonEmptyString(argsRecord.workspace, process.env.RUNX_LIVE_ISSUE_TO_PR_WORKSPACE);
  const allowlist = parseDogfoodRepoAllowlist(argsRecord, process.env);
  const missing = [
    repo ? undefined : "repo",
    issue ? undefined : "issue",
    workspace ? undefined : "workspace",
  ].filter(Boolean);
  if (missing.length === 0) {
    const allowlistCheck = inspectDogfoodRepoAllowlist(repo, allowlist);
    if (allowlistCheck.status === "blocked") {
      return {
        ok: false,
        payload: {
          status: "blocked",
          reason: "live_issue_to_pr_repo_not_allowlisted",
          mode,
          repo,
          allowed_repos: allowlist,
          mutation: "none",
          check: allowlistCheck,
          next: "Add the proving-ground repo with --allow-repo or RUNX_LIVE_ISSUE_TO_PR_ALLOWED_REPOS before running live create/observe.",
        },
        exitCode: 1,
      };
    }
    return { ok: true, repo: allowlistCheck.repo, issue, workspace, allowlist };
  }
  const payload = {
    status: "skipped",
    reason: "live_issue_to_pr_target_not_configured",
    mode,
    missing,
    required: {
      repo: "pass --repo or RUNX_LIVE_ISSUE_TO_PR_REPO",
      issue: "pass --issue or RUNX_LIVE_ISSUE_TO_PR_ISSUE",
      workspace: "pass --workspace or RUNX_LIVE_ISSUE_TO_PR_WORKSPACE",
      allowlist: "pass --allow-repo or RUNX_LIVE_ISSUE_TO_PR_ALLOWED_REPOS",
    },
    mutation: "none",
    next: "Configure an allowlisted proving-ground repo and rerun preflight before create mode.",
  };
  return {
    ok: false,
    payload,
    exitCode: mode === "preflight" ? 0 : 1,
  };
}

function parseDogfoodRepoAllowlist(argsRecord, env) {
  const values = [
    ...arrayValues(argsRecord.allow_repo),
    ...splitList(env?.RUNX_LIVE_ISSUE_TO_PR_ALLOWED_REPOS),
  ];
  const seen = new Set();
  const repos = [];
  for (const value of values) {
    const repo = normalizeRepoSlug(value);
    if (!repo || seen.has(repo)) {
      continue;
    }
    seen.add(repo);
    repos.push(repo);
  }
  return repos;
}

function inspectDogfoodRepoAllowlist(repo, allowlist) {
  const normalizedRepo = normalizeRepoSlug(repo);
  if (!normalizedRepo) {
    return {
      name: "target_repo_allowlist",
      status: "blocked",
      repo,
      allowed_repos: allowlist,
      reason: "target repo must be an owner/repo slug.",
      next: "Pass a GitHub repo slug like owner/repo.",
    };
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return {
      name: "target_repo_allowlist",
      status: "blocked",
      repo: normalizedRepo,
      allowed_repos: [],
      reason: "live issue-to-PR requires an explicit proving-ground repo allowlist.",
      next: "Pass --allow-repo owner/repo or set RUNX_LIVE_ISSUE_TO_PR_ALLOWED_REPOS=owner/repo.",
    };
  }
  if (!allowlist.includes(normalizedRepo)) {
    return {
      name: "target_repo_allowlist",
      status: "blocked",
      repo: normalizedRepo,
      allowed_repos: allowlist,
      reason: "target repo is not in the configured proving-ground allowlist.",
      next: "Use a configured proving-ground repo, or intentionally add this repo to --allow-repo/RUNX_LIVE_ISSUE_TO_PR_ALLOWED_REPOS.",
    };
  }
  return {
    name: "target_repo_allowlist",
    status: "ready",
    repo: normalizedRepo,
    allowed_repos: allowlist,
    reason: "target repo is explicitly allowlisted for live dogfood mutation.",
  };
}

function arrayValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => splitList(entry));
}

function splitList(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return [];
  }
  return text
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRepoSlug(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function dogfoodHelp() {
  return `GitHub issue-to-PR dogfood harness

Modes:
  --mode preflight, --preflight  Validate target, scafld, branch, and local tooling. No mutation.
  --mode create                 Run the governed issue-to-PR lane. May create/update branch, issue comments, and PR.
  --mode observe                Observe PR/issue outcome after a human merge or close. No code mutation; terminal outcomes upsert a source-thread comment.

Mutation gates:
  - target repo and issue are explicit flags or RUNX_LIVE_ISSUE_TO_PR_* env
  - target repo must be in --allow-repo or RUNX_LIVE_ISSUE_TO_PR_ALLOWED_REPOS
  - workspace must be a git repo with .scafld
  - branch must match the generated task branch, or --prepare-branch must be explicit
  - dirty worktrees block branch preparation
  - scafld must be executable from the target workspace
  - provider publication requires explicit RUNX_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN env
  - missing live target config makes preflight return a skipped JSON payload with exit 0

Examples:
  pnpm live:issue-to-pr -- --allow-repo owner/repo --repo owner/repo --issue 123 --workspace /repo
  pnpm dogfood:github-issue-to-pr -- --mode create --prepare-branch --allow-repo owner/repo --repo owner/repo --issue 123 --workspace /repo
  runx resume <run-id> answers.json --receipt-dir /repo/.runx/receipts --json
  pnpm dogfood:github-issue-to-pr -- --mode observe --allow-repo owner/repo --repo owner/repo --issue 123 --workspace /repo
`;
}

async function buildDogfoodPreflight({ args: argsRecord, issueRef, workspace, scafldBin, taskId, branchName, allowlist }) {
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
  const runxCli = resolveRunxCli(argsRecord);
  const runxBinCheck = inspectCommand({
    name: "RUNX_BIN",
    source: runxCli.source,
    command: runxCli.command,
    requested: runxCli.requested,
    args: ["--help"],
    cwd: process.cwd(),
    next: "Set --runx-bin, RUNX_BIN, or put the executable runx CLI on PATH. Verify with `runx --help`.",
  });
  const githubPublishAuthCheck = inspectGitHubPublishAuth(process.env);
  const checks = {
    target_repo_allowlist: inspectDogfoodRepoAllowlist(issueRef.repo_slug, allowlist),
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
    github_publish_auth: githubPublishAuthCheck,
    github: {
      status: "deferred",
      reason: "GitHub issue hydration runs after local runner and workspace checks.",
    },
  };
  const blocking = Object.values(checks).filter((check) => check.status === "blocked");
  const nextCommand = [
    "pnpm dogfood:github-issue-to-pr --",
    "--allow-repo", issueRef.repo_slug,
    "--repo", issueRef.repo_slug,
    "--issue", issueRef.issue_number,
    "--workspace", shellQuote(workspace),
    taskId ? `--task-id ${shellQuote(taskId)}` : "",
    branchName && branchName !== taskId ? `--branch ${shellQuote(branchName)}` : "",
    argsRecord.prepare_branch ? "--prepare-branch" : "",
    argsRecord.scafld_bin ? `--scafld-bin ${shellQuote(argsRecord.scafld_bin)}` : "",
    argsRecord.runx_bin ? `--runx-bin ${shellQuote(argsRecord.runx_bin)}` : "",
    argsRecord.skill ? `--skill ${shellQuote(argsRecord.skill)}` : "",
    argsRecord.receipt_dir ? `--receipt-dir ${shellQuote(argsRecord.receipt_dir)}` : "",
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
    modes: {
      preflight: "read-only local validation; no provider mutation",
      create: "runs issue-to-pr and may create/update the issue thread and PR",
      observe: "observes provider state after a human merge or close; no code mutation; terminal outcomes upsert one source-thread comment",
    },
    mutation_gates: [
      "explicit repo, issue, and workspace",
      "target repo is in the explicit proving-ground allowlist",
      "workspace .scafld exists",
      "workspace is on the intended issue branch or --prepare-branch is explicit",
      "dirty worktrees block branch preparation",
      "scafld list --json succeeds from the target workspace",
      "explicit GitHub token env is present for the provider process",
      "human merge remains outside the harness",
    ],
    checks,
    next_command: nextCommand,
    next_action: blocking.length > 0
      ? "Fix the blocked preflight checks, then rerun the dogfood command."
      : "Run the dogfood command to hydrate the GitHub issue and execute the governed lane.",
  };
}

async function createDogfoodIssueToPr({
  args: argsRecord,
  issueRef,
  workspace,
  scafldBin,
  taskId,
  branchName,
  preflight,
  allowlist,
}) {
  const continuationCheck = inspectContinuationArgs(argsRecord, taskId, issueRef, workspace);
  if (continuationCheck) {
    return continuationCheck;
  }

  prepareDogfoodBranch({
    workspace,
    branchName,
    prepareBranch: argsRecord.prepare_branch === true,
  });

  const thread = fetchGitHubIssueThread({
    adapterRef: issueRef.adapter_ref,
    env: process.env,
    cwd: workspace,
  });
  const beforePreferredPull = selectPreferredPullFromThread(thread, branchName);
  const runxCli = resolveRunxCli(argsRecord);
  const receiptDir = resolveDogfoodReceiptDir(argsRecord, workspace);
  const operationalPolicy = await resolveDogfoodOperationalPolicy({
    args: argsRecord,
    issueRef,
    allowlist,
  });
  const repoSnapshot = buildDogfoodRepoSnapshot({
    workspace,
    issueRef,
    branchName,
    thread,
  });
  const invocation = buildIssueToPrSkillInvocation({
    args: argsRecord,
    issueRef,
    workspace,
    scafldBin,
    taskId,
    branchName,
    thread,
    receiptDir,
    operationalPolicy,
    repoSnapshot,
  });
  const run = spawnSync(runxCli.command, invocation.argv, {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const redactions = dogfoodRedactions(workspace);
  if (run.error) {
    return buildDogfoodCreateRunxFailure({
      issueRef,
      workspace,
      taskId,
      branchName,
      preflight,
      runxCli,
      receiptDir,
      run,
      redactions,
      reason: "dogfood_create_runx_cli_unavailable",
    });
  }

  const nativeOutput = parseJsonOutput(run.stdout);
  const nativeStatus = firstNonEmptyString(nativeOutput?.status);
  if (run.status !== 0 && !(run.status === 2 && nativeStatus === "needs_agent")) {
    return buildDogfoodCreateRunxFailure({
      issueRef,
      workspace,
      taskId,
      branchName,
      preflight,
      runxCli,
      receiptDir,
      run,
      redactions,
      reason: "dogfood_create_native_route_failed",
      nativeOutput,
    });
  }

  const refreshedThread = nativeStatus === "sealed"
    ? fetchGitHubIssueThread({
        adapterRef: issueRef.adapter_ref,
        env: process.env,
        cwd: workspace,
      })
    : thread;
  const preferredPull = selectPreferredPullFromThread(refreshedThread, branchName);
  return buildDogfoodCreateResult({
    args: argsRecord,
    issueRef,
    workspace,
    taskId,
    branchName,
    preflight,
    runxCli,
    receiptDir,
    beforePreferredPull,
    preferredPull,
    refreshedThread,
    run,
    nativeOutput,
    redactions,
  });
}

function inspectContinuationArgs(argsRecord, taskId, issueRef, workspace) {
  const answers = firstNonEmptyString(argsRecord.answers);
  const runId = firstNonEmptyString(argsRecord.run_id);
  if (answers && !runId) {
    return {
      status: "blocked",
      reason: "dogfood_create_answers_require_run_id",
      mode: "create",
      mutation: "none",
      repo: issueRef.repo_slug,
      issue: {
        number: issueRef.issue_number,
        url: issueRef.issue_url,
      },
      task_id: taskId,
      workspace: summarizeLocalPath(workspace),
      next: "First run create mode without an answers file, then continue with the returned run_id and answers file.",
    };
  }
  if (runId && !answers) {
    return {
      status: "blocked",
      reason: "dogfood_create_run_id_requires_answers",
      mode: "create",
      mutation: "none",
      repo: issueRef.repo_slug,
      issue: {
        number: issueRef.issue_number,
        url: issueRef.issue_url,
      },
      task_id: taskId,
      run_id: runId,
      workspace: summarizeLocalPath(workspace),
      next: "Provide an answers file with the run_id so the native graph can resume the stored run state.",
    };
  }
  return undefined;
}

function buildIssueToPrSkillInvocation({
  args: argsRecord,
  issueRef,
  workspace,
  scafldBin,
  taskId,
  branchName,
  thread,
  receiptDir,
  operationalPolicy,
  repoSnapshot,
}) {
  const skillPath = resolveDogfoodSkillPath(argsRecord);
  const runId = firstNonEmptyString(argsRecord.run_id);
  const answers = firstNonEmptyString(argsRecord.answers);
  if (runId && answers) {
    return {
      skill_path: skillPath,
      argv: [
        "resume",
        runId,
        resolveInputPath(answers),
        "--receipt-dir",
        receiptDir,
        "--json",
      ],
    };
  }

  const threadBody = primaryThreadBody(thread);
  const argv = [
    "skill",
    skillPath,
    "--json",
    "--receipt-dir",
    receiptDir,
    "--task-id",
    taskId,
    "--thread-title",
    firstNonEmptyString(thread.title, `GitHub issue ${issueRef.issue_number}`),
    "--thread-body",
    threadBody ?? issueRef.issue_url,
    "--thread-locator",
    issueRef.thread_locator,
    "--thread",
    JSON.stringify(thread),
    "--target-repo",
    issueRef.repo_slug,
    "--source-id",
    firstNonEmptyString(argsRecord.source_id, "github-issues"),
    "--runner-id",
    firstNonEmptyString(argsRecord.runner_id, "local-dogfood"),
    "--operational-policy",
    JSON.stringify(operationalPolicy),
    "--branch",
    branchName,
    "--fixture",
    workspace,
    "--workspace-path",
    workspace,
    "--scafld-bin",
    scafldInputValue(scafldBin),
    "--repo-snapshot",
    JSON.stringify(repoSnapshot),
  ];
  pushOptionalInput(argv, "--repo-context", argsRecord.repo_context);
  pushOptionalInput(argv, "--size", argsRecord.size);
  pushOptionalInput(argv, "--risk", argsRecord.risk);
  pushOptionalInput(argv, "--base", argsRecord.base);
  pushOptionalInput(argv, "--provider", argsRecord.provider);
  pushOptionalInput(argv, "--provider-command", argsRecord.provider_command);
  pushOptionalInput(argv, "--provider-binary", argsRecord.provider_binary);
  pushOptionalInput(argv, "--model", argsRecord.model);

  return {
    skill_path: skillPath,
    argv,
  };
}

function pushOptionalInput(argv, flag, value) {
  const text = firstNonEmptyString(value);
  if (text) {
    argv.push(flag, text);
  }
}

function buildDogfoodCreateResult({
  args: argsRecord,
  issueRef,
  workspace,
  taskId,
  branchName,
  preflight,
  runxCli,
  receiptDir,
  beforePreferredPull,
  preferredPull,
  refreshedThread,
  run,
  nativeOutput,
  redactions,
}) {
  const nativeStatus = firstNonEmptyString(nativeOutput?.status);
  const runId = firstNonEmptyString(nativeOutput?.run_id);
  const receiptRefs = collectReceiptRefs(nativeOutput);
  if (nativeStatus === "needs_agent") {
    return {
      status: "needs_agent",
      reason: "dogfood_create_native_graph_needs_agent",
      mode: "create",
      mutation: "local_graph_state",
      repo: issueRef.repo_slug,
      issue: {
        number: issueRef.issue_number,
        url: issueRef.issue_url,
      },
      task_id: taskId,
      branch: branchName,
      run_id: runId,
      receipt_dir: summarizeLocalPath(receiptDir),
      preflight: summarizePreflight(preflight),
      native_route: summarizeNativeRoute(runxCli, run, nativeOutput, redactions),
      requests: sanitizeDogfoodValue(nativeOutput?.requests, redactions),
      next_command: buildContinuationCommand({
        args: argsRecord,
        runId,
        receiptDir,
      }),
      next_human_gate: "Resolve the native graph request, write answers.json, then run the continuation command.",
    };
  }

  if (nativeStatus === "sealed" && preferredPull) {
    return {
      status: "created",
      reason: firstNonEmptyString(preferredPull.url) === firstNonEmptyString(beforePreferredPull?.url)
        ? "dogfood_create_pr_refreshed"
        : "dogfood_create_pr_published",
      mode: "create",
      mutation: "branch_pr_source_thread",
      source_issue_url: issueRef.issue_url,
      pull_request_url: firstNonEmptyString(preferredPull.url),
      pull_request: {
        number: firstNonEmptyString(preferredPull.number),
        url: firstNonEmptyString(preferredPull.url),
        branch: firstNonEmptyString(preferredPull.headRefName),
        state: firstNonEmptyString(preferredPull.state),
        is_draft: preferredPull.isDraft === true,
      },
      task_id: taskId,
      branch: branchName,
      run_id: runId,
      receipt_refs: receiptRefs,
      source_thread_publication_refs: sourceThreadPublicationRefs(refreshedThread),
      thread: summarizeThread(refreshedThread, preferredPull),
      preflight: summarizePreflight(preflight),
      native_route: summarizeNativeRoute(runxCli, run, nativeOutput, redactions),
      next_human_gate: "Review, merge, or close the draft PR outside the harness, then run observe mode.",
    };
  }

  return {
    status: "blocked",
    reason: nativeStatus === "sealed"
      ? "dogfood_create_pr_not_found_after_native_run"
      : "dogfood_create_native_route_unexpected_output",
    mode: "create",
    mutation: nativeStatus === "sealed" ? "native_route_completed" : "unknown",
    repo: issueRef.repo_slug,
    issue: {
      number: issueRef.issue_number,
      url: issueRef.issue_url,
    },
    task_id: taskId,
    branch: branchName,
    workspace: summarizeLocalPath(workspace),
    run_id: runId,
    receipt_refs: receiptRefs,
    thread: summarizeThread(refreshedThread, preferredPull),
    preflight: summarizePreflight(preflight),
    native_route: summarizeNativeRoute(runxCli, run, nativeOutput, redactions),
    next: nativeStatus === "sealed"
      ? "The native graph sealed but no matching PR was observed. Inspect the source thread outbox and branch before retrying."
      : "Inspect the native route output; create mode expects runx.skill_run.v1 with status needs_agent or sealed.",
  };
}

function buildDogfoodCreateRunxFailure({
  issueRef,
  workspace,
  taskId,
  branchName,
  preflight,
  runxCli,
  receiptDir,
  run,
  redactions,
  reason,
  nativeOutput,
}) {
  return {
    status: "blocked",
    reason,
    mode: "create",
    mutation: "none",
    repo: issueRef.repo_slug,
    issue: {
      number: issueRef.issue_number,
      url: issueRef.issue_url,
    },
    task_id: taskId,
    branch: branchName,
    workspace: summarizeLocalPath(workspace),
    receipt_dir: summarizeLocalPath(receiptDir),
    preflight: summarizePreflight(preflight),
    native_route: summarizeNativeRoute(runxCli, run, nativeOutput, redactions),
    next: "Fix the native runx skill invocation, then rerun create mode. No provider publication result was accepted from this run.",
  };
}

function summarizePreflight(preflight) {
  return {
    status: preflight.status,
    reason: preflight.reason,
  };
}

function summarizeNativeRoute(runxCli, run, nativeOutput, redactions) {
  return {
    command: runxCli.requested,
    source: runxCli.source,
    route: "runx skill skills/issue-to-pr",
    exit_code: typeof run?.status === "number" ? run.status : undefined,
    signal: firstNonEmptyString(run?.signal),
    stdout: nativeOutput
      ? undefined
      : preview(redactLocalPaths(sanitizePublicMarkdown(run?.stdout ?? ""), redactions)),
    stderr: preview(redactLocalPaths(sanitizePublicMarkdown(run?.stderr ?? ""), redactions)),
    output_status: firstNonEmptyString(nativeOutput?.status),
    output_run_id: firstNonEmptyString(nativeOutput?.run_id),
    output_receipt_id: firstNonEmptyString(nativeOutput?.receipt_id),
  };
}

function buildContinuationCommand({ args: argsRecord, runId, receiptDir }) {
  const runx = firstNonEmptyString(argsRecord.runx_bin, "runx");
  return [
    shellQuote(runx),
    "resume",
    runId ? shellQuote(runId) : "<run-id>",
    "<answers.json>",
    receiptDir ? `--receipt-dir ${shellQuote(receiptDir)}` : "",
    "--json",
  ].filter(Boolean).join(" ");
}

function dogfoodCreateExitCode(result) {
  if (result?.status === "created") {
    return 0;
  }
  if (result?.status === "needs_agent") {
    return 2;
  }
  return 1;
}

function resolveRunxCli(argsRecord) {
  const explicit = firstNonEmptyString(argsRecord.runx_bin, process.env.RUNX_BIN);
  if (explicit) {
    return {
      requested: explicit,
      command: resolveCommandCandidate(explicit, process.cwd()),
      source: argsRecord.runx_bin ? "flag:--runx-bin" : "env:RUNX_BIN",
    };
  }
  const local = [
    path.join(RUNX_OSS_ROOT, "crates", "target", "debug", "runx"),
    path.join(RUNX_OSS_ROOT, "crates", "target", "release", "runx"),
  ].find((candidate) => existsSync(candidate));
  const requested = local ?? "runx";
  return {
    requested,
    command: resolveCommandCandidate(requested, process.cwd()),
    source: local ? "local:crates/target/runx" : "path:runx",
  };
}

function resolveDogfoodSkillPath(argsRecord) {
  return resolveInputPath(firstNonEmptyString(
    argsRecord.skill,
    process.env.RUNX_LIVE_ISSUE_TO_PR_SKILL,
    ISSUE_TO_PR_SKILL_PATH,
  ));
}

function resolveDogfoodReceiptDir(argsRecord, workspace) {
  return resolveInputPath(firstNonEmptyString(
    argsRecord.receipt_dir,
    process.env.RUNX_LIVE_ISSUE_TO_PR_RECEIPT_DIR,
    path.join(workspace, ".runx", "receipts"),
  ));
}

function resolveInputPath(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return text;
  }
  return path.isAbsolute(text) ? text : path.resolve(process.cwd(), text);
}

function scafldInputValue(scafldBin) {
  const value = firstNonEmptyString(scafldBin, "scafld");
  return value.includes(path.sep) ? resolveCommandCandidate(value, process.cwd()) : value;
}

async function resolveDogfoodOperationalPolicy({ args: argsRecord, issueRef, allowlist }) {
  const explicit = firstNonEmptyString(argsRecord.operational_policy);
  if (explicit) {
    if (explicit.trim().startsWith("{")) {
      return JSON.parse(explicit);
    }
    const raw = await readFile(resolveInputPath(explicit), "utf8");
    return JSON.parse(raw);
  }
  return buildDogfoodOperationalPolicy({
    issueRef,
    allowlist,
    sourceId: firstNonEmptyString(argsRecord.source_id, "github-issues"),
    runnerId: firstNonEmptyString(argsRecord.runner_id, "local-dogfood"),
  });
}

function buildDogfoodOperationalPolicy({ issueRef, allowlist, sourceId, runnerId }) {
  const repos = Array.from(new Set([issueRef.repo_slug, ...allowlist]));
  return {
    schema: "runx.operational_policy.v1",
    schema_version: "runx.operational_policy.v1",
    policy_id: `dogfood-${issueRef.repo_slug.replace(/\//g, "-")}`,
    sources: [
      {
        source_id: sourceId,
        provider: "github",
        allowed_locators: [`github://${issueRef.repo_slug}/issues`],
        allowed_actions: ["reply-only", "issue-intake", "issue-to-pr"],
        source_thread: {
          required: true,
          publish_mode: "comment",
          missing_behavior: "fail_closed",
        },
      },
    ],
    runners: [
      {
        runner_id: runnerId,
        kind: "local",
        state: "available",
        allowed_actions: ["reply-only", "issue-intake", "issue-to-pr"],
        target_repos: repos,
        scafld_required: true,
      },
    ],
    owner_routes: [
      {
        route_id: "dogfood-maintainers",
        owners: ["maintainers"],
        target_repos: repos,
      },
    ],
    targets: repos.map((repo) => ({
      repo,
      runner_ids: [runnerId],
      allowed_actions: ["reply-only", "issue-intake", "issue-to-pr"],
      default_owner_route: "dogfood-maintainers",
      scafld_required: true,
    })),
    dedupe: {
      strategy: "source_fingerprint",
      key_fields: ["source.provider", "source.locator", "signal.fingerprint"],
      on_duplicate: "reuse",
    },
    outcomes: {
      observe_provider: true,
      verification_required: true,
      close_source_issue: "when_verified",
      publish_final_source_thread_update: true,
    },
    permissions: {
      auto_merge: false,
      mutate_target_repo: true,
      require_human_merge_gate: true,
    },
  };
}

function buildDogfoodRepoSnapshot({ workspace, issueRef, branchName, thread }) {
  const files = gitOutputOrEmpty(workspace, ["ls-files"])
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const status = gitOutputOrEmpty(workspace, ["status", "--porcelain=v1"])
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const head = firstNonEmptyString(gitOutputOrEmpty(workspace, ["rev-parse", "--short=12", "HEAD"]));
  const text = [thread.title, primaryThreadBody(thread)].filter(Boolean).join("\n\n");
  return {
    schema: "runx.repo_snapshot.v1",
    target_repo: issueRef.repo_slug,
    branch: branchName,
    head,
    dirty_count: status.length,
    dirty_paths: status.slice(0, 50),
    existing_files: selectSnapshotFiles(files),
    recommended_files: inferRecommendedFiles(text, files),
  };
}

function gitOutputOrEmpty(workspace, args) {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  return result.status === 0 ? result.stdout : "";
}

function selectSnapshotFiles(files) {
  const preferred = [
    "README.md",
    "package.json",
    "pnpm-workspace.yaml",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
  ];
  const selected = new Set();
  for (const file of preferred) {
    if (files.includes(file)) {
      selected.add(file);
    }
  }
  for (const file of files) {
    if (
      selected.size >= 80 ||
      file.startsWith(".scafld/") ||
      file.startsWith(".git/")
    ) {
      continue;
    }
    if (/\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|rs|go|py|json|yaml|yml|toml)$/.test(file)) {
      selected.add(file);
    }
  }
  return [...selected];
}

function inferRecommendedFiles(text, files) {
  const candidates = new Set();
  const body = firstNonEmptyString(text) ?? "";
  for (const match of body.matchAll(/`([^`\n]+\.[A-Za-z0-9]+)`/g)) {
    candidates.add(match[1]);
  }
  for (const match of body.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g)) {
    candidates.add(match[1]);
  }
  const known = new Set(files);
  return [...candidates]
    .map((entry) => entry.replace(/^\.\//, ""))
    .filter((entry) => known.has(entry))
    .slice(0, 20);
}

function primaryThreadBody(thread) {
  const entry = threadEntries(thread)
    .find((candidate) => firstNonEmptyString(candidate?.body));
  const body = firstNonEmptyString(entry?.body);
  if (!body) {
    return undefined;
  }
  const sanitized = sanitizePublicMarkdown(body);
  return sanitized.length > 20000 ? `${sanitized.slice(0, 20000)}...` : sanitized;
}

function selectPreferredPullFromThread(thread, branchName) {
  return selectPreferredGitHubPullRequest(
    pullRequestOutboxEntries(thread).map((entry) => ({
      number: optionalNumber(entry.metadata?.number),
      url: entry.locator,
      headRefName: entry.metadata?.branch,
      updatedAt: entry.metadata?.updated_at,
      isDraft: entry.status === "draft",
      state: entry.status === "closed" ? "CLOSED" : "OPEN",
      mergedAt: entry.metadata?.merged_at,
    })),
    branchName,
  );
}

function pullRequestOutboxEntries(thread) {
  return threadOutbox(thread).filter((entry) =>
    firstNonEmptyString(entry.kind) === "pull_request"
    || firstNonEmptyString(entry.metadata?.schema_version) === "runx.outbox-entry.pull-request.v1"
    || /\/pull\/\d+(?:$|[?#])/u.test(firstNonEmptyString(entry.locator) ?? "")
  );
}

function collectReceiptRefs(nativeOutput) {
  const refs = [];
  const push = (value) => {
    const text = firstNonEmptyString(value);
    if (text && !refs.includes(text)) {
      refs.push(text);
    }
  };
  push(nativeOutput?.receipt_id);
  const steps = Array.isArray(nativeOutput?.trace?.steps) ? nativeOutput.trace.steps : [];
  for (const step of steps) {
    push(step?.receipt_id);
  }
  return refs;
}

function sourceThreadPublicationRefs(thread) {
  return threadOutbox(thread)
    .map((entry) => ({
      entry_id: firstNonEmptyString(entry.entry_id),
      kind: firstNonEmptyString(entry.kind),
      status: firstNonEmptyString(entry.status),
      locator: firstNonEmptyString(entry.locator),
      branch: firstNonEmptyString(entry.metadata?.branch),
      comment_id: firstNonEmptyString(entry.metadata?.comment_id),
    }))
    .filter((entry) => entry.locator || entry.comment_id)
    .slice(-5);
}

function parseJsonOutput(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function dogfoodRedactions(workspace) {
  return [
    [workspace, "{workspace}"],
    [RUNX_OSS_ROOT, "{runx_oss}"],
  ].filter(([from]) => firstNonEmptyString(from));
}

function sanitizeDogfoodValue(value, redactions) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDogfoodValue(entry, redactions));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sanitizeDogfoodValue(nested, redactions),
      ]),
    );
  }
  if (typeof value === "string") {
    return redactLocalPaths(sanitizePublicMarkdown(value), redactions);
  }
  return value;
}

function redactLocalPaths(value, redactions) {
  let text = String(value ?? "");
  for (const [from, to] of redactions) {
    text = text.split(from).join(to);
  }
  return text;
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

function inspectGitHubPublishAuth(env) {
  const present = ["RUNX_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
    .filter((name) => firstNonEmptyString(env?.[name]));
  if (present.length > 0) {
    return {
      name: "github_publish_auth",
      status: "ready",
      source: present,
      reason: "explicit token env is available to the provider process.",
    };
  }
  return {
    name: "github_publish_auth",
    status: "blocked",
    source: [],
    reason: "GitHub issue hydration can use ambient gh auth, but issue-to-pr-push-outbox receives only explicit token env through the thread-outbox-provider front.",
    next: "Export RUNX_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN before create/observe publication. For local dogfood, use `export RUNX_GITHUB_TOKEN=\"$(gh auth token)\"` in the shell running the harness.",
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

function summarizeThread(state, preferredPull) {
  return {
    entries: threadEntries(state).length,
    outbox: threadOutbox(state).length,
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

function observeDogfoodOutcome({ issueRef, workspace, taskId, branchName, env }) {
  const thread = fetchGitHubIssueThread({
    adapterRef: issueRef.adapter_ref,
    env,
    cwd: workspace,
  });
  const preferredPull = selectPreferredGitHubPullRequest(
    pullRequestOutboxEntries(thread).map((entry) => ({
      number: optionalNumber(entry.metadata?.number),
      url: entry.locator,
      headRefName: entry.metadata?.branch,
      updatedAt: entry.metadata?.updated_at,
      isDraft: entry.status === "draft",
      state: entry.status === "closed" ? "CLOSED" : "OPEN",
      mergedAt: entry.metadata?.merged_at,
    })),
    branchName,
  );
  const providerOutcome = observedProviderOutcome(preferredPull);
  const pushed = providerOutcome
    ? pushGitHubMessage({
        thread,
        outboxEntry: buildDogfoodOutcomeOutboxEntry({
          issueRef,
          taskId,
          branchName,
          preferredPull,
          providerOutcome,
        }),
        workspacePath: workspace,
        nextStatus: "published",
        env,
      })
    : undefined;
  const refreshedThread = pushed
    ? fetchGitHubIssueThread({
        adapterRef: issueRef.adapter_ref,
        env,
        cwd: workspace,
      })
    : thread;
  return {
    status: preferredPull ? "observed" : "blocked",
    reason: preferredPull
      ? providerOutcome
        ? "dogfood_outcome_published"
        : "dogfood_pr_open_human_gate_pending"
      : "dogfood_pr_not_found",
    mode: "observe",
    mutation: pushed ? "source_thread_comment" : "none",
    source_issue_url: issueRef.issue_url,
    pull_request_url: firstNonEmptyString(preferredPull?.url),
    pull_request: preferredPull
      ? {
          number: firstNonEmptyString(preferredPull.number),
          url: firstNonEmptyString(preferredPull.url),
          branch: firstNonEmptyString(preferredPull.headRefName),
          state: firstNonEmptyString(preferredPull.state),
          outcome: providerOutcome,
          merged_at: firstNonEmptyString(preferredPull.mergedAt),
          is_draft: preferredPull.isDraft === true,
        }
      : undefined,
    outcome_comment: pushed
      ? {
          locator: firstNonEmptyString(pushed.message?.locator, pushed.outbox_entry?.locator),
          comment_id: firstNonEmptyString(pushed.message?.comment_id, pushed.outbox_entry?.metadata?.comment_id),
        }
      : undefined,
    thread: summarizeThread(refreshedThread, preferredPull),
    next: preferredPull
      ? providerOutcome
        ? "Terminal provider outcome has been recorded on the source thread."
        : "Human merge gate is still pending; merge or close the PR outside the harness, then observe again."
      : "Run create mode first, or pass the branch that matches the PR created for this issue.",
  };
}

function observedProviderOutcome(preferredPull) {
  if (!preferredPull) {
    return undefined;
  }
  if (firstNonEmptyString(preferredPull.mergedAt, preferredPull.merged_at)) {
    return "merged";
  }
  if (String(preferredPull.state ?? "").toUpperCase() === "CLOSED") {
    return "closed";
  }
  return undefined;
}

function buildDogfoodOutcomeOutboxEntry({
  issueRef,
  taskId,
  branchName,
  preferredPull,
  providerOutcome,
}) {
  const entryId = `message:${taskId}:outcome`;
  return {
    entry_id: entryId,
    kind: "message",
    status: "pending",
    thread_locator: issueRef.thread_locator,
    title: "Issue-to-PR outcome",
    metadata: {
      schema_version: "runx.outbox-entry.message.v1",
      channel: "github_issue_comment",
      outbox_receipt_id: `dogfood-outcome:${taskId}`,
      body_markdown: buildDogfoodOutcomeMarkdown({
        issueRef,
        taskId,
        branchName,
        preferredPull,
        providerOutcome,
      }),
    },
  };
}

function buildDogfoodOutcomeMarkdown({
  issueRef,
  taskId,
  branchName,
  preferredPull,
  providerOutcome,
}) {
  const pullUrl = firstNonEmptyString(preferredPull?.url);
  const mergedAt = firstNonEmptyString(preferredPull?.mergedAt, preferredPull?.merged_at);
  const summary = providerOutcome === "merged"
    ? "The generated PR was merged by a human."
    : "The generated PR was closed by a human.";
  const lines = [
    "## Issue-to-PR outcome",
    "",
    summary,
    "",
    `- Source issue: ${issueRef.issue_url}`,
    pullUrl ? `- Pull request: ${pullUrl}` : undefined,
    `- Branch: ${branchName}`,
    `- scafld task: ${taskId}`,
    `- Outcome: ${providerOutcome}`,
    mergedAt ? `- Merged at: ${mergedAt}` : undefined,
    "",
    "Human merge gate remained outside the harness; observe mode only recorded the provider outcome back to the source thread.",
  ].filter(Boolean);
  return sanitizePublicMarkdown(lines.join("\n"));
}

function summarizeLocalPath(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  return {
    basename: path.basename(text),
    hash: `sha256:${hashString(text).slice(0, 16)}`,
  };
}

function hashString(value) {
  let hash = 5381;
  for (const char of value) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function optionalNumber(value) {
  const text = firstNonEmptyString(value);
  return text ? Number(text) : undefined;
}

function threadEntries(state) {
  return Array.isArray(state?.entries) ? state.entries : [];
}

function threadOutbox(state) {
  return Array.isArray(state?.outbox) ? state.outbox : [];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

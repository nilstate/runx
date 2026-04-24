import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveDefaultSkillAdapters } from "@runxhq/adapters";
import { resolvePathFromUserInput } from "@runxhq/core/config";
import type { RegistryStore } from "@runxhq/core/registry";
import { runLocalSkill, type Caller, type RunLocalSkillResult } from "@runxhq/core/runner-local";
import { resolveEnvToolCatalogAdapters } from "@runxhq/core/tool-catalogs";

import type { ParsedArgs } from "../index.js";
import { resolveBundledCliVoiceProfilePath } from "../runtime-assets.js";

export type DocsCommandArgs = Partial<ParsedArgs> & {
  readonly command?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly receiptDir?: string;
  readonly docsAction?: "rerun" | "push-pr" | "signal" | "status" | "doctor" | "dogfood" | "bind-repo";
};

interface GitHubIssueRef {
  readonly repo_slug: string;
  readonly issue_number: string;
  readonly adapter_ref: string;
  readonly thread_locator: string;
  readonly issue_url: string;
}

interface GitHubHydratedThread {
  readonly thread_locator: string;
  readonly canonical_uri?: string;
  readonly outbox?: readonly unknown[];
}

export interface DocsCommandDeps {
  readonly resolveRegistryStoreForChains: (env: NodeJS.ProcessEnv) => Promise<RegistryStore | undefined>;
}

export type DocsCommandResult =
  | {
      readonly status: "success";
      readonly action: "status" | "rerun" | "push-pr" | "signal" | "bind-repo";
      readonly issue: string;
      readonly thread_locator: string;
      readonly task_id?: string;
      readonly lane?: "pull_request" | "outreach";
      readonly target_repo?: string;
      readonly repo_root?: string;
      readonly preview_url?: string;
      readonly review_comment_url?: string;
      readonly pull_request_url?: string;
      readonly review_entry_id?: string;
      readonly summary: string;
      readonly thread: GitHubHydratedThread;
      readonly handoff_state?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "success";
      readonly action: "doctor" | "dogfood";
      readonly summary: string;
      readonly checks?: readonly {
        readonly status: "pass" | "fail";
        readonly message: string;
      }[];
      readonly receipts?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "needs_resolution" | "policy_denied" | "failure";
      readonly action: NonNullable<DocsCommandArgs["docsAction"]>;
      readonly issue?: string;
      readonly phase?: "scan" | "build" | "review" | "signal";
      readonly message: string;
      readonly result?: RunLocalSkillResult;
    };

interface DocsControlState {
  readonly issueRef: GitHubIssueRef;
  readonly thread: GitHubHydratedThread;
  readonly latestReview?: Record<string, unknown>;
  readonly latestSignal?: Record<string, unknown>;
  readonly latestPullRequest?: Record<string, unknown>;
  readonly taskId?: string;
  readonly lane?: "pull_request" | "outreach";
  readonly targetRepo?: string;
  readonly boundRepoRoot?: string;
  readonly handoffRef?: Record<string, unknown>;
  readonly handoffState?: Record<string, unknown>;
}

interface ExecutedDocsSkill {
  readonly result: RunLocalSkillResult;
  readonly packet?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
}

const DOCS_CONTROL_BINDINGS_PATH = path.join(".runx", "state", "docs-control-bindings.json");

export async function handleDocsCommand(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  deps: DocsCommandDeps,
): Promise<DocsCommandResult> {
  const action = parsed.docsAction;
  if (!action) {
    throw new Error("runx docs requires an action: status, bind-repo, rerun, push-pr, signal, doctor, or dogfood.");
  }

  if (action === "doctor" || action === "dogfood") {
    const sourceyRoot = resolveSourceyRoot(parsed.inputs, env);
    return action === "doctor"
      ? await handleDocsDoctorAction(sourceyRoot)
      : await handleDocsDogfoodAction(parsed, env, caller, deps, sourceyRoot);
  }

  const issueInput = readStringInput(parsed.inputs, ["issue", "thread", "control-issue"]);
  if (!issueInput) {
    throw new Error(`runx docs ${action} requires --issue owner/repo#issue/123 or a canonical GitHub issue URL.`);
  }

  const statusSourceyRoot = resolveOptionalSourceyRoot(parsed.inputs, env);
  const control = await withDocsRepoBinding(
    await loadDocsControlState(issueInput, env, resolveDocsThreadCwd(parsed.inputs, env)),
    statusSourceyRoot,
  );

  if (action === "status") {
    return buildDocsStatusResult(control);
  }

  const sourceyRoot = resolveSourceyRoot(parsed.inputs, env);
  const boundControl = await withDocsRepoBinding(control, sourceyRoot);

  if (action === "bind-repo") {
    return await handleDocsBindRepoAction(parsed, env, sourceyRoot, boundControl);
  }

  if (action === "signal") {
    return await handleDocsSignalAction(parsed, env, caller, deps, sourceyRoot, boundControl);
  }

  return await handleDocsRerunAction(parsed, env, caller, deps, sourceyRoot, boundControl);
}

export function renderDocsResult(result: DocsCommandResult): string {
  if (result.status !== "success") {
    const lines = [
      `docs ${result.action}`,
      result.issue ? `issue    ${result.issue}` : undefined,
      result.phase ? `phase    ${result.phase}` : undefined,
      `status   ${result.status}`,
      `detail   ${result.message}`,
    ].filter((line): line is string => typeof line === "string");
    return `${lines.join("\n")}\n`;
  }

  if (result.action === "doctor" || result.action === "dogfood") {
    const lines = [
      `docs ${result.action}`,
      `status   success`,
      `summary  ${result.summary}`,
      ...(result.checks ?? []).map((check) => `${check.status === "pass" ? "pass" : "fail"}     ${check.message}`),
    ];
    return `${lines.join("\n")}\n`;
  }

  if (result.action === "status") {
    const lines = [
      "docs status",
      `issue    ${result.issue}`,
      `thread   ${result.thread_locator}`,
      result.task_id ? `task     ${result.task_id}` : undefined,
      result.lane ? `lane     ${result.lane}` : undefined,
      result.target_repo ? `target   ${result.target_repo}` : undefined,
      result.repo_root ? `repo     ${result.repo_root}` : undefined,
      result.review_comment_url ? `review   ${result.review_comment_url}` : undefined,
      result.pull_request_url ? `pr       ${result.pull_request_url}` : undefined,
      `summary  ${result.summary}`,
    ].filter((line): line is string => typeof line === "string");
    return `${lines.join("\n")}\n`;
  }

  if (result.action === "signal") {
    const lines = [
      "docs signal",
      `issue    ${result.issue}`,
      result.task_id ? `task     ${result.task_id}` : undefined,
      result.lane ? `lane     ${result.lane}` : undefined,
      result.target_repo ? `target   ${result.target_repo}` : undefined,
      `status   ${readStringFromRecord(result.handoff_state, ["status"]) ?? "unknown"}`,
      `summary  ${result.summary}`,
    ].filter((line): line is string => typeof line === "string");
    return `${lines.join("\n")}\n`;
  }

  if (result.action === "bind-repo") {
    const lines = [
      "docs bind-repo",
      `issue    ${result.issue}`,
      `thread   ${result.thread_locator}`,
      result.task_id ? `task     ${result.task_id}` : undefined,
      result.target_repo ? `target   ${result.target_repo}` : undefined,
      result.repo_root ? `repo     ${result.repo_root}` : undefined,
      `summary  ${result.summary}`,
    ].filter((line): line is string => typeof line === "string");
    return `${lines.join("\n")}\n`;
  }

  const threadedResult = result as {
    readonly action: "rerun" | "push-pr";
    readonly issue: string;
    readonly thread_locator: string;
    readonly task_id?: string;
    readonly lane?: "pull_request" | "outreach";
    readonly target_repo?: string;
    readonly repo_root?: string;
    readonly preview_url?: string;
    readonly review_comment_url?: string;
    readonly pull_request_url?: string;
    readonly summary: string;
  };
  const lines = [
    `docs ${threadedResult.action}`,
    `issue    ${threadedResult.issue}`,
    `thread   ${threadedResult.thread_locator}`,
    threadedResult.task_id ? `task     ${threadedResult.task_id}` : undefined,
    threadedResult.lane ? `lane     ${threadedResult.lane}` : undefined,
    threadedResult.target_repo ? `target   ${threadedResult.target_repo}` : undefined,
    threadedResult.repo_root ? `repo     ${threadedResult.repo_root}` : undefined,
    threadedResult.preview_url ? `preview  ${threadedResult.preview_url}` : undefined,
    threadedResult.review_comment_url ? `review   ${threadedResult.review_comment_url}` : undefined,
    threadedResult.pull_request_url ? `pr       ${threadedResult.pull_request_url}` : undefined,
    `summary  ${threadedResult.summary}`,
  ].filter((line): line is string => typeof line === "string");
  return `${lines.join("\n")}\n`;
}

async function handleDocsRerunAction(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  deps: DocsCommandDeps,
  sourceyRoot: string,
  control: DocsControlState,
): Promise<DocsCommandResult> {
  const repoRootInput = firstNonEmptyString(
    readStringInput(parsed.inputs, ["repo-root", "repo_root", "project"]),
    control.boundRepoRoot,
  );
  if (!repoRootInput) {
    return {
      status: "failure",
      action: parsed.docsAction ?? "rerun",
      issue: control.issueRef.issue_url,
      phase: "scan",
      message: "No local target repo clone is bound to this control thread yet. Run `runx docs bind-repo --issue ... --repo-root /path/to/repo` first or pass `--repo-root` directly.",
    };
  }
  const repoRoot = normalizeDocsRepoRoot(resolvePathFromUserInput(repoRootInput, env));
  if (!existsSync(repoRoot)) {
    const rebound = control.boundRepoRoot && repoRootInput === control.boundRepoRoot;
    return {
      status: "failure",
      action: parsed.docsAction ?? "rerun",
      issue: control.issueRef.issue_url,
      phase: "scan",
      message: rebound
        ? `The bound repo clone '${repoRoot}' no longer exists. Rebind it with \`runx docs bind-repo --issue ... --repo-root /path/to/repo\`.`
        : `The repo clone '${repoRoot}' does not exist.`,
    };
  }

  if (parsed.docsAction === "push-pr" && readStringFromRecord(control.handoffState, ["status"]) !== "accepted") {
    return {
      status: "failure",
      action: parsed.docsAction,
      issue: control.issueRef.issue_url,
      phase: "review",
      message: "The control thread is not approved for PR push yet. Record an accepted review signal with `runx docs signal --disposition accepted ...` before using `runx docs push-pr`.",
    };
  }

  const skillEnv = { ...env, RUNX_CWD: sourceyRoot };
  const scanPacket = await executeDocsSkill(
    sourceyRoot,
    "docs-scan",
    {
      repo_root: repoRoot,
      repo_url: readStringInput(parsed.inputs, ["repo-url", "repo_url"]),
      docs_url: readStringInput(parsed.inputs, ["docs-url", "docs_url"]),
      default_branch: readStringInput(parsed.inputs, ["default-branch", "default_branch"]),
      objective: readStringInput(parsed.inputs, ["objective"]),
      scan_context: readStringInput(parsed.inputs, ["scan-context", "scan_context"]),
    },
    skillEnv,
    caller,
    parsed,
    deps,
  );
  if (scanPacket.result.status !== "success" || !scanPacket.data) {
    return toDocsSkillFailure(parsed.docsAction ?? "rerun", control.issueRef.issue_url, "scan", scanPacket.result);
  }

  const buildPacket = await executeDocsSkill(
    sourceyRoot,
    "docs-build",
    {
      repo_root: repoRoot,
      docs_scan_packet: scanPacket.data,
      build_context: readStringInput(parsed.inputs, ["build-context", "build_context"]),
      sourcey_bin: readStringInput(parsed.inputs, ["sourcey-bin", "sourcey_bin"]),
    },
    skillEnv,
    caller,
    parsed,
    deps,
  );
  if (buildPacket.result.status !== "success" || !buildPacket.data) {
    return toDocsSkillFailure(parsed.docsAction ?? "rerun", control.issueRef.issue_url, "build", buildPacket.result);
  }

  const selectedLane = selectDocsLane({
    action: parsed.docsAction === "push-pr" ? "push-pr" : "rerun",
    explicit: readStringInput(parsed.inputs, ["handoff"]),
    priorLane: control.lane,
    buildPacket: buildPacket.data,
  });
  const taskId = resolveDocsTaskId(
    readStringInput(parsed.inputs, ["task-id", "task_id"]),
    control.taskId,
    buildPacket.data,
    selectedLane,
  );

  if (selectedLane === "outreach" && parsed.docsAction === "push-pr") {
    return {
      status: "failure",
      action: parsed.docsAction,
      issue: control.issueRef.issue_url,
      phase: "review",
      message: "The current docs build resolved to an outreach-only handoff. Use `runx docs rerun` to refresh the review thread instead of `runx docs push-pr`.",
    };
  }

  if (selectedLane === "pull_request" && readBooleanFromRecord(buildPacket.data, ["operator_summary", "should_open_pr"]) !== true) {
    return {
      status: "failure",
      action: parsed.docsAction ?? "rerun",
      issue: control.issueRef.issue_url,
      phase: "review",
      message: firstNonEmptyString(
        readStringFromRecord(buildPacket.data, ["operator_summary", "rationale"]),
        "The generated docs bundle is not eligible for a maintainer PR.",
      ) ?? "The generated docs bundle is not eligible for a maintainer PR.",
    };
  }

  const reviewSkill = selectedLane === "pull_request" ? "docs-pr" : "docs-outreach";
  const reviewInputs = selectedLane === "pull_request"
    ? pruneRecord({
        repo_root: repoRoot,
        docs_build_packet: buildPacket.data,
        thread: control.thread,
        task_id: taskId,
        pr_context: readStringInput(parsed.inputs, ["pr-context", "pr_context"]),
        name: readStringInput(parsed.inputs, ["name", "branch"]),
        base: readStringInput(parsed.inputs, ["base"]),
        bind_current: readBooleanInput(parsed.inputs, ["bind-current", "bind_current"], true),
        push_pr: parsed.docsAction === "push-pr",
      })
    : pruneRecord({
        repo_root: repoRoot,
        docs_build_packet: buildPacket.data,
        thread: control.thread,
        task_id: taskId,
        outreach_context: readStringInput(parsed.inputs, ["outreach-context", "outreach_context"]),
        maintainer_contact: buildMaintainerContact(parsed.inputs),
        push_outreach: readBooleanInput(parsed.inputs, ["push-outreach", "push_outreach"], false),
      });
  const reviewPacket = await executeDocsSkill(
    sourceyRoot,
    reviewSkill,
    reviewInputs,
    skillEnv,
    caller,
    parsed,
    deps,
  );
  if (reviewPacket.result.status !== "success" || !reviewPacket.data) {
    return toDocsSkillFailure(parsed.docsAction ?? "rerun", control.issueRef.issue_url, "review", reviewPacket.result);
  }

  const packageSummary = readRecord(reviewPacket.data.package_summary);
  const outboxEntry = readRecord(reviewPacket.data.review_outbox_entry);
  const push = readRecord(reviewPacket.data.push);
  return {
    status: "success",
    action: parsed.docsAction ?? "rerun",
    issue: control.issueRef.issue_url,
    thread_locator: control.issueRef.thread_locator,
    task_id: taskId,
    lane: selectedLane,
    target_repo: control.targetRepo ?? readStringFromRecord(buildPacket.data, ["scan", "target", "repo_slug"]),
    repo_root: repoRoot,
    preview_url: firstNonEmptyString(
      readStringFromRecord(buildPacket.data, ["before_after_evidence", "build_url"]),
      readStringFromRecord(buildPacket.data, ["preview", "preview_url"]),
    ),
    review_comment_url: firstNonEmptyString(
      readStringFromRecord(outboxEntry, ["locator"]),
      readStringFromRecord(reviewPacket.data, ["review_push", "message", "locator"]),
      readStringFromRecord(push, ["pull_request", "url"]),
    ),
    pull_request_url: firstNonEmptyString(
      readStringFromRecord(push, ["pull_request", "url"]),
      readStringFromRecord(reviewPacket.data, ["outbox_entry", "locator"]),
    ),
    review_entry_id: readStringFromRecord(outboxEntry, ["entry_id"]),
    summary: firstNonEmptyString(
      packageSummary?.should_push === true
        ? "Review refreshed and PR push completed through the control thread."
        : "Review refreshed on the control thread. Upstream push is still gated.",
      readStringFromRecord(buildPacket.data, ["operator_summary", "rationale"]),
      "Docs review refreshed successfully.",
    ) ?? "Docs review refreshed successfully.",
    thread: control.thread,
  };
}

async function handleDocsBindRepoAction(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  sourceyRoot: string,
  control: DocsControlState,
): Promise<DocsCommandResult> {
  const repoRootInput = readStringInput(parsed.inputs, ["repo-root", "repo_root", "project"]);
  if (!repoRootInput) {
    throw new Error("runx docs bind-repo requires --repo-root pointing at a local target repo clone.");
  }
  const repoRoot = normalizeDocsRepoRoot(resolvePathFromUserInput(repoRootInput, env));
  if (!existsSync(repoRoot)) {
    throw new Error(`The repo clone '${repoRoot}' does not exist.`);
  }
  await writeDocsRepoBinding(sourceyRoot, control.issueRef.thread_locator, {
    issue_url: control.issueRef.issue_url,
    thread_locator: control.issueRef.thread_locator,
    target_repo: control.targetRepo,
    task_id: control.taskId,
    repo_root: repoRoot,
    updated_at: new Date().toISOString(),
  });
  return {
    status: "success",
    action: "bind-repo",
    issue: control.issueRef.issue_url,
    thread_locator: control.issueRef.thread_locator,
    task_id: control.taskId,
    lane: control.lane,
    target_repo: control.targetRepo,
    repo_root: repoRoot,
    summary: control.targetRepo
      ? `Bound ${repoRoot} to ${control.targetRepo} for this control thread.`
      : `Bound ${repoRoot} to this control thread.`,
    thread: control.thread,
  };
}

async function handleDocsSignalAction(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  deps: DocsCommandDeps,
  sourceyRoot: string,
  control: DocsControlState,
): Promise<DocsCommandResult> {
  const signalSource = readStringInput(parsed.inputs, ["source", "signal-source", "signal_source"]);
  const signalDisposition = readStringInput(parsed.inputs, ["disposition", "signal-disposition", "signal_disposition"]);
  if (!signalSource || !signalDisposition) {
    throw new Error("runx docs signal requires --source and --disposition.");
  }
  if (!control.taskId || !control.lane) {
    throw new Error("No docs review handoff was found on the control thread. Run `runx docs rerun` first.");
  }
  const handoffRef = control.handoffRef ?? synthesizeHandoffRef(control);
  if (!handoffRef) {
    throw new Error("The latest docs review comment does not carry a reusable handoff reference yet. Refresh the review first with `runx docs rerun`.");
  }
  const skillEnv = { ...env, RUNX_CWD: sourceyRoot };
  const signalPacket = await executeDocsSkill(
    sourceyRoot,
    "docs-signal",
    pruneRecord({
      thread: control.thread,
      signal_source: signalSource,
      signal_disposition: signalDisposition,
      notes: readStringInput(parsed.inputs, ["notes"]),
      recorded_at: readStringInput(parsed.inputs, ["recorded-at", "recorded_at"]),
      source_ref: buildSignalSourceRef(parsed.inputs),
      suppression_reason: readStringInput(parsed.inputs, ["suppression-reason", "suppression_reason"]),
      suppression_scope: readStringInput(parsed.inputs, ["suppression-scope", "suppression_scope"]),
      docs_pr_packet: control.lane === "pull_request" ? { handoff_ref: handoffRef } : undefined,
      docs_outreach_packet: control.lane === "outreach" ? { handoff_ref: handoffRef } : undefined,
    }),
    skillEnv,
    caller,
    parsed,
    deps,
  );
  if (signalPacket.result.status !== "success" || !signalPacket.data) {
    return toDocsSkillFailure(parsed.docsAction ?? "signal", control.issueRef.issue_url, "signal", signalPacket.result);
  }

  const handoffState = readRecord(signalPacket.data.handoff_state);
  const signalOutboxEntry = buildDocsSignalOutboxEntry(control, signalPacket.data);
  if (signalOutboxEntry) {
    const threadAdapter = await loadThreadAdapterModule(env);
    threadAdapter.pushGitHubMessage({
      thread: control.thread,
      outboxEntry: signalOutboxEntry,
      nextStatus: "published",
      env,
    });
  }
  return {
    status: "success",
    action: parsed.docsAction ?? "signal",
    issue: control.issueRef.issue_url,
    thread_locator: control.issueRef.thread_locator,
    task_id: control.taskId,
    lane: control.lane,
    target_repo: control.targetRepo,
    repo_root: control.boundRepoRoot,
    handoff_state: handoffState,
    summary: firstNonEmptyString(
      readStringFromRecord(handoffState, ["summary"]),
      readStringFromRecord(signalPacket.data, ["operator_summary", "summary"]),
      "Signal recorded.",
    ) ?? "Signal recorded.",
    thread: control.thread,
  };
}

async function handleDocsDoctorAction(sourceyRoot: string): Promise<DocsCommandResult> {
  const checks: { status: "pass" | "fail"; message: string }[] = [];
  const packageJson = JSON.parse(await readFile(path.join(sourceyRoot, "package.json"), "utf8")) as Record<string, unknown>;

  await checkFileMissing(sourceyRoot, ".runx/tools/docs/push_pr", "direct docs push_pr tool remains deleted", checks);
  await checkContains(sourceyRoot, "skills/docs-build/X.yaml", "tool: docs.publish_preview", "docs-build publishes a hosted preview surface before maintainer handoff", checks);
  await checkContains(sourceyRoot, "skills/docs-build/X.yaml", "../../.runx/vendor/sourcey/SKILL.md", "docs-build resolves the Sourcey build lane from the repo-local vendored skill bundle", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/prepare_build/src/index.ts", "integration_decision", "docs.prepare_build emits an integration decision for pathway-aware handoff", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/score_quality/src/index.ts", "existing_surface", "docs.score_quality records the visible docs surface", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/research_context/src/index.ts", "existing_surface", "docs.research_context carries the visible docs surface into the grounded brief", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "Hosted preview", "docs.package_build records hosted preview evidence in the build summary", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "integration_decision", "docs.package_build carries the integration decision into the docs packet", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "coverage_assessment", "docs.package_build records preview coverage against the current docs surface", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "regresses the maintainer's existing visible docs surface", "docs.package_build blocks native patches that shrink the visible docs surface", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "substantive_file_count", "docs.package_build tracks substantive authored docs files", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "scaffold-only", "docs.package_build blocks scaffold-only bundles from opening PRs", checks);
  await checkContains(sourceyRoot, "skills/docs-build/X.yaml", "\"existing_surface\": {", "docs-build brief shape records the current visible docs surface", checks);
  await checkContains(sourceyRoot, ".runx/vendor/sourcey/X.yaml", "When project_brief is supplied, it is the quality bar:", "vendored Sourcey runner consumes the grounded brief during authoring", checks);
  await checkContains(sourceyRoot, ".runx/vendor/sourcey/X.yaml", "existing_surface.visible_paths", "vendored Sourcey runner preserves the current visible docs footprint", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "thread:", "docs-pr declares a thread input", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "required: true", "docs-pr requires the GitHub control thread", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "default: false", "docs-pr defaults push_pr to false", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "tool: docs.stage_pr", "docs-pr stages the bounded upstream docs bundle directly", checks);
  await checkNotContains(sourceyRoot, "skills/docs-pr/X.yaml", "../../.runx/vendor/issue-to-pr", "docs-pr no longer routes maintainer-facing docs work through the nested issue-to-pr lane", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "tool: thread.push_outbox", "docs-pr publishes through thread.push_outbox", checks);
  await checkFileExists(sourceyRoot, ".runx/tools/docs/stage_pr/run.mjs", "docs.stage_pr tool is present", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/stage_pr/src/index.ts", "migration_bundle.files", "docs.stage_pr stages the authored upstream docs bundle", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/stage_pr/src/index.ts", "commit_subject", "docs.stage_pr carries the reviewed commit subject into the PR draft", checks);
  await checkFileMissing(sourceyRoot, "scripts/ensure-runx-runtime.mjs", "the old installed-runtime patch script is gone; Sourcey uses the real CLI directly", checks);
  await checkFileMissing(sourceyRoot, "scripts/runx-local.mjs", "the old local runx shim is gone; Sourcey uses the real CLI directly", checks);
  await checkFileMissing(sourceyRoot, "scripts/doctor-outreach-flow.mjs", "the old outreach doctor harness is gone; `runx docs doctor` is canonical", checks);
  await checkFileMissing(sourceyRoot, "scripts/dogfood-outreach-flow.mjs", "the old outreach dogfood harness is gone; `runx docs dogfood` is canonical", checks);
  await checkNotContains(sourceyRoot, ".runx/tools/docs/prepare_pr/src/index.ts", "docs://refresh/", "docs-pr no longer invents synthetic thread locators", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/prepare_pr/src/index.ts", "hosted preview URL", "docs.prepare_pr rejects local temp preview paths", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/prepare_pr/src/index.ts", "Integration decision", "docs.prepare_pr carries the integration decision into the review request", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "thread:", "docs-outreach declares a thread input", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "required: true", "docs-outreach requires the GitHub control thread", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "default: false", "docs-outreach defaults push_outreach to false", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "tool: thread.push_outbox", "docs-outreach publishes review through thread.push_outbox", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "handoff_ref", "docs.package_pr emits a reusable handoff_ref", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Preview Site", "docs.package_pr includes the hosted preview site in review and PR bodies", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Integration Path", "docs.package_pr includes the integration path in review and PR bodies", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Exact Commit Subject", "docs.package_pr review message includes the exact commit subject", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Exact PR Title", "docs.package_pr review message includes the exact PR title", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Exact PR Body", "docs.package_pr review message includes the exact PR body", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "outreach_message_markdown", "docs.package_outreach emits the exact outreach body", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "review_message_markdown", "docs.package_outreach emits the exact review message", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "## Integration Path", "docs.package_outreach includes the integration path in review and outreach surfaces", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "## Exact Outreach Body", "docs.package_outreach review message includes the exact outreach body", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "substantive docs bundle", "docs.package_outreach refuses scaffold-only external outreach", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_signal/src/index.ts", "runx.handoff_signal.v1", "docs.package_signal emits the generic handoff signal contract", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/handoff.mjs", "runx.handoff_state.v1", "docs.package_signal emits the generic handoff state contract", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_signal/src/index.ts", "runx.suppression_record.v1", "docs.package_signal emits the generic suppression contract", checks);
  checkPinnedCliDependency(packageJson, checks);
  await checkNoDirectGitHubMutation(sourceyRoot, ".runx/tools/docs", checks);
  await checkContains(sourceyRoot, "package.json", "\"doctor:outreach\": \"runx docs doctor\"", "package.json routes doctor:outreach through the runx CLI", checks);
  await checkContains(sourceyRoot, "package.json", "\"dogfood:outreach\": \"runx docs dogfood\"", "package.json routes dogfood:outreach through the runx CLI", checks);

  const failed = checks.filter((check) => check.status === "fail");
  return failed.length === 0
    ? {
        status: "success",
        action: "doctor",
        summary: `All outreach-flow checks passed (${checks.length}/${checks.length}).`,
        checks,
      }
    : {
        status: "failure",
        action: "doctor",
        message: `${failed.length} outreach-flow checks failed.`,
      };
}

async function handleDocsDogfoodAction(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  deps: DocsCommandDeps,
  sourceyRoot: string,
): Promise<DocsCommandResult> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runx-docs-dogfood-"));
  const repoRoot = path.join(tempRoot, "target-repo");
  const runtimeRoot = path.join(tempRoot, "runtime");
  const receiptDir = parsed.receiptDir
    ? resolvePathFromUserInput(parsed.receiptDir, env)
    : path.join(runtimeRoot, "receipts");
  const threadPath = path.join(runtimeRoot, "control-thread.json");
  const taskId = "docs-refresh-easyllm";
  try {
    await mkdir(repoRoot, { recursive: true });
    await mkdir(receiptDir, { recursive: true });
    await initDogfoodRepo(repoRoot);
    const thread = await writeDogfoodControlThread(threadPath);
    const skillEnv = { ...env, RUNX_CWD: sourceyRoot };

    const docsPr = await executeDocsSkill(
      sourceyRoot,
      "docs-pr",
      {
        repo_root: repoRoot,
        docs_build_packet: buildDogfoodDocsPrPacket(),
        thread,
        task_id: taskId,
        push_pr: true,
        pr_context: "Review the packaged PR text in this control thread before any upstream send.",
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (docsPr.result.status !== "success" || !docsPr.data) {
      return toDocsSkillFailure("dogfood", undefined, "review", docsPr.result);
    }
    const readmeContents = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const gettingStartedContents = await readFile(path.join(repoRoot, "docs/getting-started.md"), "utf8");
    if (readmeContents !== DOGFOOD_README_CONTENTS || gettingStartedContents !== DOGFOOD_GETTING_STARTED_CONTENTS) {
      return {
        status: "failure",
        action: "dogfood",
        message: "docs-pr dogfood did not stage the expected authored docs bundle into the repo clone.",
      };
    }

    const docsOutreach = await executeDocsSkill(
      sourceyRoot,
      "docs-outreach",
      {
        repo_root: repoRoot,
        docs_build_packet: buildDogfoodDocsOutreachPacket(),
        thread,
        maintainer_contact: {
          channel: "email",
          email: "maintainer@example.org",
          display_name: "Maintainer",
        },
        outreach_context: "Invite maintainers to review the hosted preview and suggest the lowest-friction adoption path.",
        push_outreach: true,
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (docsOutreach.result.status !== "success" || !docsOutreach.data) {
      return toDocsSkillFailure("dogfood", undefined, "review", docsOutreach.result);
    }

    const docsSignal = await executeDocsSkill(
      sourceyRoot,
      "docs-signal",
      {
        docs_pr_packet: docsPr.data,
        signal_source: "pull_request_review",
        signal_disposition: "requested_changes",
        recorded_at: "2026-04-24T04:00:00Z",
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (docsSignal.result.status !== "success" || !docsSignal.data) {
      return toDocsSkillFailure("dogfood", undefined, "signal", docsSignal.result);
    }
    if (readStringFromRecord(docsSignal.data, ["handoff_state", "status"]) !== "needs_revision") {
      return {
        status: "failure",
        action: "dogfood",
        message: "docs-signal dogfood did not reduce PR review feedback to needs_revision.",
      };
    }

    const outreachSuppression = await executeDocsSkill(
      sourceyRoot,
      "docs-signal",
      {
        docs_outreach_packet: {
          handoff_ref: {
            handoff_id: "sourcey.docs-outreach:docs-outreach-easyllm",
            boundary_kind: "external_contact",
            target_repo: "philschmid/easyllm",
            target_locator: "github://sourcey/sourcey.com/issues/2",
            contact_locator: "mailto:maintainer@example.org",
            thread_locator: "github://sourcey/sourcey.com/issues/2",
            outbox_entry_id: "message:docs-outreach-easyllm:outreach",
          },
        },
        signal_source: "email_reply",
        signal_disposition: "requested_no_contact",
        suppression_reason: "requested_no_contact",
        recorded_at: "2026-04-24T04:05:00Z",
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (outreachSuppression.result.status !== "success" || !outreachSuppression.data) {
      return toDocsSkillFailure("dogfood", undefined, "signal", outreachSuppression.result);
    }
    if (readStringFromRecord(outreachSuppression.data, ["handoff_state", "status"]) !== "suppressed") {
      return {
        status: "failure",
        action: "dogfood",
        message: "docs-signal dogfood did not suppress outreach when requested.",
      };
    }

    return {
      status: "success",
      action: "dogfood",
      summary: "Thread-first docs dogfood passed for review packaging, adapter-managed push, signal reduction, and outreach suppression.",
      receipts: {
        docs_pr: docsPr.result.receipt?.id,
        docs_outreach: docsOutreach.result.receipt?.id,
        docs_signal: docsSignal.result.receipt?.id,
        docs_outreach_signal: outreachSuppression.result.receipt?.id,
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function buildDocsStatusResult(control: DocsControlState): DocsCommandResult {
  return {
    status: "success",
    action: "status",
    issue: control.issueRef.issue_url,
    thread_locator: control.issueRef.thread_locator,
    task_id: control.taskId,
    lane: control.lane,
    target_repo: control.targetRepo,
    repo_root: control.boundRepoRoot,
    review_comment_url: firstNonEmptyString(control.latestReview?.locator),
    pull_request_url: firstNonEmptyString(control.latestPullRequest?.locator),
    review_entry_id: firstNonEmptyString(control.latestReview?.entry_id),
    summary: firstNonEmptyString(
      readStringFromRecord(control.handoffState, ["summary"]),
      control.latestReview
        ? "Docs review state recovered from the control thread."
        : "No docs review comments have been published on this control thread yet.",
    ) ?? "No docs review comments have been published on this control thread yet.",
    handoff_state: control.handoffState,
    thread: control.thread,
  };
}

async function loadDocsControlState(issueInput: string, env: NodeJS.ProcessEnv, cwd: string): Promise<DocsControlState> {
  const threadAdapter = await loadThreadAdapterModule(env);
  const issueRef = threadAdapter.parseGitHubIssueRef(issueInput);
  const thread = threadAdapter.fetchGitHubIssueThread({
    adapterRef: issueRef.adapter_ref,
    env,
    cwd,
  });
  const latestReview = findLatestDocsReviewEntry(thread);
  const latestSignal = findLatestDocsSignalEntry(thread);
  const latestPullRequest = findLatestPullRequestEntry(thread);
  const control = readDocsControlMetadata(latestReview);
  const signalControl = readDocsControlMetadata(latestSignal);
  const lane = inferDocsLane(latestReview);
  const handoffRef = readRecord(signalControl?.handoff_ref) ?? readRecord(control?.handoff_ref);
  return {
    issueRef,
    thread,
    latestReview,
    latestSignal,
    latestPullRequest,
    taskId: firstNonEmptyString(
      signalControl?.task_id,
      control?.task_id,
      parseDocsTaskId(firstNonEmptyString(latestReview?.entry_id)),
      parseDocsSignalTaskId(firstNonEmptyString(latestSignal?.entry_id)),
    ),
    lane,
    targetRepo: firstNonEmptyString(
      readStringFromRecord(handoffRef, ["target_repo"]),
      readStringFromRecord(signalControl, ["target_repo"]),
      readStringFromRecord(control, ["target_repo"]),
    ),
    handoffRef,
    handoffState: readRecord(signalControl?.handoff_state),
  };
}

async function withDocsRepoBinding(control: DocsControlState, sourceyRoot: string | undefined): Promise<DocsControlState> {
  if (!sourceyRoot) {
    return control;
  }
  const bindings = await readDocsRepoBindings(sourceyRoot);
  const binding = readRecord(bindings[control.issueRef.thread_locator]);
  return {
    ...control,
    targetRepo: firstNonEmptyString(
      control.targetRepo,
      readStringFromRecord(binding, ["target_repo"]),
    ),
    boundRepoRoot: firstNonEmptyString(
      readStringFromRecord(binding, ["repo_root"]),
      control.boundRepoRoot,
    ),
  };
}

async function loadThreadAdapterModule(env: NodeJS.ProcessEnv): Promise<{
  readonly parseGitHubIssueRef: (...values: readonly unknown[]) => GitHubIssueRef;
  readonly fetchGitHubIssueThread: (options: {
    readonly adapterRef: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  }) => GitHubHydratedThread;
  readonly pushGitHubMessage: (options: {
    readonly thread: GitHubHydratedThread;
    readonly outboxEntry: Readonly<Record<string, unknown>>;
    readonly nextStatus?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly workspacePath?: string;
  }) => Readonly<Record<string, unknown>>;
}> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    firstNonEmptyString(env.RUNX_DOCS_THREAD_ADAPTER_PATH),
    path.resolve(here, "../../tools/thread/github_adapter.mjs"),
    path.resolve(here, "../../../tools/thread/github_adapter.mjs"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    return await import(pathToFileURL(candidate).href);
  }
  throw new Error("Unable to resolve the runx GitHub thread adapter from the CLI package.");
}

async function executeDocsSkill(
  sourceyRoot: string,
  skillName: "docs-scan" | "docs-build" | "docs-pr" | "docs-outreach" | "docs-signal",
  inputs: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  parsed: DocsCommandArgs,
  deps: DocsCommandDeps,
): Promise<ExecutedDocsSkill> {
  const skillPath = path.join(sourceyRoot, "skills", skillName);
  if (!existsSync(skillPath)) {
    throw new Error(`Sourcey docs skill '${skillName}' was not found at ${skillPath}.`);
  }
  const adapters = await resolveDefaultSkillAdapters(env);
  const registryStore = await deps.resolveRegistryStoreForChains(env);
  const result = await runLocalSkill({
    skillPath,
    runner: skillName,
    inputs,
    caller,
    env,
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
    adapters,
    registryStore,
    toolCatalogAdapters: resolveEnvToolCatalogAdapters(env),
    voiceProfilePath: await resolveBundledCliVoiceProfilePath(),
  });
  if (result.status !== "success" && result.status !== "failure") {
    return { result };
  }
  const packet = parseSkillPacket(result.execution.stdout);
  return {
    result,
    packet,
    data: readRecord(packet?.data) ?? packet,
  };
}

function parseSkillPacket(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return readRecord(parsed);
  } catch {
    return undefined;
  }
}

function resolveSourceyRoot(inputs: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): string {
  const explicit = readStringInput(inputs, ["sourcey-root", "sourcey_root"]);
  const candidate = explicit
    ? resolvePathFromUserInput(explicit, env)
    : resolvePathFromUserInput(env.RUNX_DOCS_ROOT ?? env.RUNX_CWD ?? process.cwd(), env);
  if (!existsSync(path.join(candidate, "skills", "docs-build"))) {
    throw new Error(`Sourcey docs root '${candidate}' does not contain skills/docs-build. Pass --sourcey-root explicitly.`);
  }
  return candidate;
}

function resolveOptionalSourceyRoot(inputs: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = readStringInput(inputs, ["sourcey-root", "sourcey_root"]);
  if (explicit) {
    return resolveSourceyRoot(inputs, env);
  }
  const candidate = resolvePathFromUserInput(env.RUNX_DOCS_ROOT ?? env.RUNX_CWD ?? process.cwd(), env);
  return existsSync(path.join(candidate, "skills", "docs-build")) ? candidate : undefined;
}

function resolveDocsThreadCwd(inputs: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): string {
  const explicit = readStringInput(inputs, ["sourcey-root", "sourcey_root"]);
  return explicit
    ? resolvePathFromUserInput(explicit, env)
    : resolvePathFromUserInput(env.RUNX_DOCS_ROOT ?? env.RUNX_CWD ?? process.cwd(), env);
}

function selectDocsLane(options: {
  readonly action: "rerun" | "push-pr";
  readonly explicit?: string;
  readonly priorLane?: "pull_request" | "outreach";
  readonly buildPacket: Readonly<Record<string, unknown>>;
}): "pull_request" | "outreach" {
  const explicit = firstNonEmptyString(options.explicit);
  if (explicit === "pr" || explicit === "pull_request") {
    return "pull_request";
  }
  if (explicit === "outreach") {
    return "outreach";
  }
  if (options.action === "push-pr") {
    return "pull_request";
  }
  if (options.priorLane) {
    return options.priorLane;
  }
  return readStringFromRecord(options.buildPacket, ["operator_summary", "recommended_handoff"]) === "outreach"
    ? "outreach"
    : "pull_request";
}

function resolveDocsTaskId(
  explicit: string | undefined,
  previous: string | undefined,
  buildPacket: Readonly<Record<string, unknown>>,
  lane: "pull_request" | "outreach",
): string | undefined {
  return firstNonEmptyString(
    explicit,
    previous,
    buildTaskIdFromPacket(buildPacket, lane),
  );
}

function buildTaskIdFromPacket(buildPacket: Readonly<Record<string, unknown>>, lane: "pull_request" | "outreach"): string | undefined {
  const repoSlug = readStringFromRecord(buildPacket, ["scan", "target", "repo_slug"]);
  if (!repoSlug) {
    return undefined;
  }
  const normalizedRepo = repoSlug.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return lane === "outreach" ? `docs-outreach-${normalizedRepo}` : `docs-refresh-${normalizedRepo}`;
}

function findLatestDocsReviewEntry(thread: { readonly outbox?: readonly unknown[] } | Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const outbox = Array.isArray(thread.outbox) ? thread.outbox : [];
  const reviews = outbox
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => entry.kind === "message")
    .filter((entry) => {
      const entryId = firstNonEmptyString(entry.entry_id);
      if (!entryId) {
        return false;
      }
      const control = readDocsControlMetadata(entry);
      if (control?.workflow === "docs" && (control?.lane === "pr_review" || control?.lane === "outreach_review")) {
        return true;
      }
      return /^message:[^:]+:review$/i.test(entryId);
    });
  return reviews
    .slice()
    .sort((left, right) => {
      const leftUpdated = firstNonEmptyString(
        readStringFromRecord(left, ["metadata", "updated_at"]),
        readStringFromRecord(left, ["metadata", "pushed_at"]),
        readStringFromRecord(left, ["locator"]),
        readStringFromRecord(left, ["entry_id"]),
      );
      const rightUpdated = firstNonEmptyString(
        readStringFromRecord(right, ["metadata", "updated_at"]),
        readStringFromRecord(right, ["metadata", "pushed_at"]),
        readStringFromRecord(right, ["locator"]),
        readStringFromRecord(right, ["entry_id"]),
      );
      return String(rightUpdated).localeCompare(String(leftUpdated));
    })[0];
}

function findLatestDocsSignalEntry(thread: { readonly outbox?: readonly unknown[] } | Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const outbox = Array.isArray(thread.outbox) ? thread.outbox : [];
  const signals = outbox
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => entry.kind === "message")
    .filter((entry) => {
      const entryId = firstNonEmptyString(entry.entry_id);
      if (!entryId) {
        return false;
      }
      const control = readDocsControlMetadata(entry);
      if (control?.workflow === "docs" && control?.lane === "handoff_signal") {
        return true;
      }
      return /^message:[^:]+:signal$/i.test(entryId);
    });
  return signals
    .slice()
    .sort((left, right) => {
      const leftUpdated = firstNonEmptyString(
        readStringFromRecord(left, ["metadata", "updated_at"]),
        readStringFromRecord(left, ["metadata", "pushed_at"]),
        readStringFromRecord(left, ["locator"]),
        readStringFromRecord(left, ["entry_id"]),
      );
      const rightUpdated = firstNonEmptyString(
        readStringFromRecord(right, ["metadata", "updated_at"]),
        readStringFromRecord(right, ["metadata", "pushed_at"]),
        readStringFromRecord(right, ["locator"]),
        readStringFromRecord(right, ["entry_id"]),
      );
      return String(rightUpdated).localeCompare(String(leftUpdated));
    })[0];
}

function findLatestPullRequestEntry(thread: { readonly outbox?: readonly unknown[] } | Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const outbox = Array.isArray(thread.outbox) ? thread.outbox : [];
  return outbox
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => entry.kind === "pull_request")
    .slice()
    .sort((left, right) => {
      const leftUpdated = firstNonEmptyString(
        readStringFromRecord(left, ["metadata", "updated_at"]),
        readStringFromRecord(left, ["metadata", "pushed_at"]),
        readStringFromRecord(left, ["locator"]),
        readStringFromRecord(left, ["entry_id"]),
      );
      const rightUpdated = firstNonEmptyString(
        readStringFromRecord(right, ["metadata", "updated_at"]),
        readStringFromRecord(right, ["metadata", "pushed_at"]),
        readStringFromRecord(right, ["locator"]),
        readStringFromRecord(right, ["entry_id"]),
      );
      return String(rightUpdated).localeCompare(String(leftUpdated));
    })[0];
}

function inferDocsLane(entry: Record<string, unknown> | undefined): "pull_request" | "outreach" | undefined {
  const control = readDocsControlMetadata(entry);
  if (control?.lane === "pr_review") {
    return "pull_request";
  }
  if (control?.lane === "outreach_review") {
    return "outreach";
  }
  const body = readStringFromRecord(entry, ["metadata", "body_markdown"]);
  if (!body) {
    return undefined;
  }
  if (body.includes("## Exact PR Body")) {
    return "pull_request";
  }
  if (body.includes("## Exact Outreach Body")) {
    return "outreach";
  }
  return undefined;
}

function parseDocsTaskId(entryId: string | undefined): string | undefined {
  const text = firstNonEmptyString(entryId);
  if (!text) {
    return undefined;
  }
  const match = text.match(/^message:([^:]+):review$/i);
  return firstNonEmptyString(match?.[1]);
}

function parseDocsSignalTaskId(entryId: string | undefined): string | undefined {
  const text = firstNonEmptyString(entryId);
  if (!text) {
    return undefined;
  }
  const match = text.match(/^message:([^:]+):signal$/i);
  return firstNonEmptyString(match?.[1]);
}

function readDocsControlMetadata(entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const metadata = readRecord(entry?.metadata);
  return readRecord(metadata?.control);
}

function synthesizeHandoffRef(control: DocsControlState): Record<string, unknown> | undefined {
  if (!control.taskId || !control.lane) {
    return undefined;
  }
  return pruneRecord({
    handoff_id: control.lane === "pull_request" ? `sourcey.docs-pr:${control.taskId}` : `sourcey.docs-outreach:${control.taskId}`,
    boundary_kind: control.lane === "pull_request" ? "external_maintainer" : "external_contact",
    thread_locator: control.issueRef.thread_locator,
    target_locator: control.issueRef.thread_locator,
    outbox_entry_id: firstNonEmptyString(control.latestReview?.entry_id),
  });
}

function buildDocsSignalOutboxEntry(
  control: DocsControlState,
  signalPacket: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!control.taskId) {
    return undefined;
  }
  const handoffRef = readRecord(signalPacket.handoff_ref);
  const handoffSignal = readRecord(signalPacket.handoff_signal);
  const handoffState = readRecord(signalPacket.handoff_state);
  if (!handoffRef || !handoffSignal || !handoffState) {
    return undefined;
  }
  const suppressionRecord = readRecord(signalPacket.suppression_record);
  const sourceRef = readRecord(handoffSignal.source_ref);
  const existing = control.latestSignal;
  const previewUrl = deriveDocsPreviewUrl(control.latestReview);
  const reviewUrl = firstNonEmptyString(control.latestReview?.locator);
  const targetRepo = firstNonEmptyString(
    readStringFromRecord(handoffRef, ["target_repo"]),
    control.targetRepo,
    parseTargetRepoFromPreviewUrl(previewUrl),
  );
  const status = readStringFromRecord(handoffState, ["status"]) ?? "unknown";
  const summary = firstNonEmptyString(readStringFromRecord(handoffState, ["summary"]));
  const bodyLines = [
    "Current control status for the active docs handoff.",
    "",
    "## Current State",
    targetRepo ? `Target repo: \`${targetRepo}\`` : undefined,
    `Status: \`${status}\``,
    summary ? `Summary: ${summary}` : undefined,
    previewUrl ? `Preview site: ${previewUrl}` : undefined,
    reviewUrl ? `Draft review: ${reviewUrl}` : undefined,
    "",
    "## Latest Signal",
    `Source: \`${readStringFromRecord(handoffSignal, ["source"]) ?? "unknown"}\``,
    `Disposition: \`${readStringFromRecord(handoffSignal, ["disposition"]) ?? "unknown"}\``,
    `Recorded at: \`${readStringFromRecord(handoffSignal, ["recorded_at"]) ?? "unknown"}\``,
    sourceRef
      ? `Source ref: ${readStringFromRecord(sourceRef, ["uri"]) ?? "unknown"}`
      : undefined,
    suppressionRecord
      ? `Suppression: \`${readStringFromRecord(suppressionRecord, ["scope"]) ?? "unknown"}\` / \`${readStringFromRecord(suppressionRecord, ["reason"]) ?? "unknown"}\``
      : undefined,
    "",
    "## Next Action",
    describeDocsNextAction(status),
  ].filter((line): line is string => typeof line === "string");

  return pruneRecord({
    entry_id: firstNonEmptyString(existing?.entry_id, `message:${control.taskId}:signal`),
    kind: "message",
    locator: firstNonEmptyString(existing?.locator),
    status: "draft",
    thread_locator: control.issueRef.thread_locator,
    metadata: pruneRecord({
      schema_version: "runx.outbox-entry.message.v1",
      channel: "github_issue_comment",
      comment_id: readStringFromRecord(existing, ["metadata", "comment_id"]),
      body_markdown: `${bodyLines.join("\n")}\n`,
      control: {
        schema_version: "sourcey.docs.control.v1",
        workflow: "docs",
        lane: "handoff_signal",
        task_id: control.taskId,
        handoff_lane: control.lane ?? "pull_request",
        handoff_ref: handoffRef,
        handoff_signal: handoffSignal,
        handoff_state: handoffState,
        suppression_record: suppressionRecord,
      },
    }),
  });
}

function describeDocsNextAction(status: string): string {
  switch (status) {
    case "needs_revision":
      return "Revise the docs draft, rerun the review refresh, and keep the upstream PR gated until the thread is accepted.";
    case "accepted":
      return "The control thread is approved. Trigger the upstream PR push when ready.";
    case "sent":
      return "The upstream handoff has already been sent. Watch the maintainer thread for follow-up signals.";
    case "suppressed":
      return "Do not send follow-up outreach from this handoff unless an operator intentionally clears the suppression state.";
    default:
      return "Review the current handoff state and decide whether to revise, approve, or suppress the next outbound step.";
  }
}

function deriveDocsPreviewUrl(entry: Record<string, unknown> | undefined): string | undefined {
  const direct = sanitizeDocsPreviewUrl(firstNonEmptyString(
    readStringFromRecord(entry, ["metadata", "build_url"]),
    readStringFromRecord(entry, ["metadata", "control", "build_url"]),
  ));
  if (direct) {
    return direct;
  }
  const body = readStringFromRecord(entry, ["metadata", "body_markdown"]);
  if (!body) {
    return undefined;
  }
  const match = body.match(/https:\/\/sourcey\.com\/previews\/[^\s)'"`]+/i);
  return sanitizeDocsPreviewUrl(firstNonEmptyString(match?.[0]));
}

function sanitizeDocsPreviewUrl(value: string | undefined): string | undefined {
  return firstNonEmptyString(value?.replace(/[.,;:!?]+$/u, ""));
}

function parseTargetRepoFromPreviewUrl(value: string | undefined): string | undefined {
  const previewUrl = firstNonEmptyString(value);
  if (!previewUrl) {
    return undefined;
  }
  const match = previewUrl.match(/\/previews\/([^/]+)\/([^/]+)\/?/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

async function readDocsRepoBindings(sourceyRoot: string): Promise<Readonly<Record<string, unknown>>> {
  const filePath = path.join(sourceyRoot, DOCS_CONTROL_BINDINGS_PATH);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const bindings = readRecord(parsed.bindings);
    return bindings ?? {};
  } catch {
    return {};
  }
}

async function writeDocsRepoBinding(
  sourceyRoot: string,
  threadLocator: string,
  binding: Readonly<Record<string, unknown>>,
): Promise<void> {
  const bindingsPath = path.join(sourceyRoot, DOCS_CONTROL_BINDINGS_PATH);
  const bindingsDir = path.dirname(bindingsPath);
  const existing = await readDocsRepoBindings(sourceyRoot);
  await mkdir(bindingsDir, { recursive: true });
  await writeFile(
    bindingsPath,
    `${JSON.stringify({
      schema_version: "runx.docs-control-bindings.v1",
      bindings: {
        ...existing,
        [threadLocator]: pruneRecord(binding),
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function buildMaintainerContact(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  return pruneRecord({
    channel: readStringInput(inputs, ["contact-channel", "contact_channel", "channel"]),
    email: readStringInput(inputs, ["maintainer-email", "maintainer_email", "email"]),
    display_name: readStringInput(inputs, ["maintainer-name", "maintainer_name", "name"]),
    locator: readStringInput(inputs, ["contact-locator", "contact_locator"]),
    handle: readStringInput(inputs, ["contact-handle", "contact_handle", "handle"]),
    subject: readStringInput(inputs, ["subject"]),
  });
}

function buildSignalSourceRef(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const uri = readStringInput(inputs, ["source-ref", "source_ref", "source-uri", "source_uri"]);
  if (!uri) {
    return undefined;
  }
  return pruneRecord({
    type: readStringInput(inputs, ["source-ref-type", "source_ref_type"]) ?? "provider_comment",
    uri,
    label: readStringInput(inputs, ["source-ref-label", "source_ref_label"]),
    recorded_at: readStringInput(inputs, ["recorded-at", "recorded_at"]),
  });
}

function toDocsSkillFailure(
  action: NonNullable<DocsCommandArgs["docsAction"]>,
  issue: string | undefined,
  phase: "scan" | "build" | "review" | "signal",
  result: RunLocalSkillResult,
): DocsCommandResult {
  if (result.status === "needs_resolution") {
    return {
      status: "needs_resolution",
      action,
      issue,
      phase,
      message: buildNeedsResolutionMessage(phase, result),
      result,
    };
  }
  if (result.status === "policy_denied") {
    return {
      status: "policy_denied",
      action,
      issue,
      phase,
      message: result.reasons.join("; ") || `The ${phase} phase was denied by policy.`,
      result,
    };
  }
  return {
    status: "failure",
    action,
    issue,
    phase,
    message: firstNonEmptyString(result.execution.stderr, result.execution.errorMessage, `The ${phase} phase failed.`) ?? `The ${phase} phase failed.`,
    result,
  };
}

function normalizeDocsRepoRoot(candidate: string): string {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return topLevel.length > 0 ? topLevel : candidate;
  } catch {
    return candidate;
  }
}

function buildNeedsResolutionMessage(
  phase: "scan" | "build" | "review" | "signal",
  result: Extract<RunLocalSkillResult, { readonly status: "needs_resolution" }>,
): string {
  const requests = Array.isArray(result.requests) ? result.requests : [];
  const cognitiveRequest = requests.find((request) => request.kind === "cognitive_work");
  if (!cognitiveRequest) {
    return `The ${phase} phase needs resolution before the docs flow can continue.`;
  }

  const labels = Array.isArray(result.stepLabels) ? result.stepLabels.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const label = labels[0];
  return label
    ? `The ${phase} phase paused at '${label}' and needs managed agent work. Configure RUNX_AGENT_PROVIDER and RUNX_AGENT_MODEL plus OPENAI_API_KEY or ANTHROPIC_API_KEY, then rerun.`
    : `The ${phase} phase needs managed agent work. Configure RUNX_AGENT_PROVIDER and RUNX_AGENT_MODEL plus OPENAI_API_KEY or ANTHROPIC_API_KEY, then rerun.`;
}

async function checkContains(
  root: string,
  relativePath: string,
  pattern: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  checks.push({ status: contents.includes(pattern) ? "pass" : "fail", message });
}

async function checkNotContains(
  root: string,
  relativePath: string,
  pattern: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  checks.push({ status: contents.includes(pattern) ? "fail" : "pass", message });
}

async function checkFileMissing(
  root: string,
  relativePath: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  checks.push({ status: existsSync(path.join(root, relativePath)) ? "fail" : "pass", message });
}

async function checkFileExists(
  root: string,
  relativePath: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  checks.push({ status: existsSync(path.join(root, relativePath)) ? "pass" : "fail", message });
}

function checkPinnedCliDependency(
  packageJson: Record<string, unknown>,
  checks: { status: "pass" | "fail"; message: string }[],
): void {
  const dependencies = readRecord(packageJson.dependencies);
  const devDependencies = readRecord(packageJson.devDependencies);
  const version = firstNonEmptyString(dependencies?.["@runxhq/cli"], devDependencies?.["@runxhq/cli"]);
  checks.push({
    status: typeof version === "string" && (version.startsWith("file:vendor/runx/") || /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) ? "pass" : "fail",
    message: typeof version === "string" && (version.startsWith("file:vendor/runx/") || /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
      ? `Sourcey pins @runxhq/cli deterministically (${version})`
      : "Sourcey must pin @runxhq/cli deterministically for repeatable outreach runs",
  });
}

async function checkNoDirectGitHubMutation(
  root: string,
  relativePath: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  const files = await collectFiles(path.join(root, relativePath));
  const regex = /\bgh\s+(?:pr|issue|api)\b/;
  const offenders: string[] = [];
  for (const filePath of files) {
    const contents = await readFile(filePath, "utf8");
    if (regex.test(contents)) {
      offenders.push(path.relative(root, filePath));
    }
  }
  checks.push({
    status: offenders.length === 0 ? "pass" : "fail",
    message: offenders.length === 0
      ? "docs tools do not bypass the thread adapter with direct gh mutation"
      : `direct gh mutation detected in ${offenders.join(", ")}`,
  });
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function initDogfoodRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dogfood@example.com"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dogfood Runner"], { cwd: repoRoot, stdio: "ignore" });
  await writeFile(path.join(repoRoot, "README.md"), "# EasyLLM\n\nStarter docs.\n", "utf8");
  await writeFile(path.join(repoRoot, "docs/getting-started.md"), "# Getting Started\n\nPlaceholder content.\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
}

async function writeDogfoodControlThread(threadPath: string): Promise<Record<string, unknown>> {
  const thread = {
    kind: "runx.thread.v1",
    adapter: {
      type: "file",
      adapter_ref: threadPath,
    },
    thread_kind: "work_item",
    thread_locator: "github://sourcey/sourcey.com/issues/2",
    canonical_uri: "https://github.com/sourcey/sourcey.com/issues/2",
    title: "EasyLLM docs refresh review",
    entries: [],
    decisions: [],
    outbox: [],
    source_refs: [],
  };
  await writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`, "utf8");
  return thread;
}

function buildDogfoodDocsPrPacket(): Record<string, unknown> {
  return {
    status: "generated",
    scan: {
      target: {
        repo_slug: "philschmid/easyllm",
        repo_url: "https://github.com/philschmid/easyllm",
        default_branch: "main",
      },
      adoption_profile: {
        lane: "general-docs",
      },
      quality_assessment: {
        quality_band: "thin",
      },
    },
    integration_decision: {
      pathway: "native_patch",
      recommended_handoff: "pull_request",
      upstream_change_shape: "Patch the repository's native docs stack in place.",
      why_this_path: "The repo already has a native docs surface to improve.",
    },
    before_after_evidence: {
      build_url: "https://sourcey.com/previews/easyllm/index.html",
      preview_screenshot_url: "https://sourcey.com/previews/easyllm/preview.png",
      current_docs_url: "https://github.com/philschmid/easyllm#readme",
      summary: "Rendered docs build verified successfully with 2 authored file changes.",
    },
    migration_bundle: {
      summary: "Prepared a focused docs refresh for the README quickstart and getting started page.",
      files: [
        { path: "README.md", contents: DOGFOOD_README_CONTENTS },
        { path: "docs/getting-started.md", contents: DOGFOOD_GETTING_STARTED_CONTENTS },
      ],
    },
    operator_summary: {
      should_open_pr: true,
      rationale: "The current docs are thin and the generated build is materially stronger.",
    },
    maintainer_handoff: {
      pr_title: "docs: refresh README quickstart and getting started guide",
      commit_subject: "docs: refresh quickstart and getting started guide",
    },
    project_brief: {
      current_docs_audit: {
        verdict: "Thin quickstart coverage with no real getting-started path.",
        preserve: ["Keep the repository README as the first landing surface."],
        gaps_addressed: ["Turn the placeholder getting-started page into a real path with setup and first-run guidance."],
      },
    },
  };
}

function buildDogfoodDocsOutreachPacket(): Record<string, unknown> {
  return {
    status: "generated",
    scan: {
      target: {
        repo_slug: "philschmid/easyllm",
        repo_url: "https://github.com/philschmid/easyllm",
        default_branch: "main",
      },
      adoption_profile: {
        lane: "docs_engagement",
      },
      quality_assessment: {
        quality_band: "thin",
      },
    },
    integration_decision: {
      pathway: "outreach_only",
      recommended_handoff: "outreach",
      upstream_change_shape: "Lead with a hosted preview and propose the lowest-friction adoption path before requesting a patch.",
      why_this_path: "The maintainer may prefer to review the hosted preview before choosing an adoption path.",
    },
    before_after_evidence: {
      build_url: "https://sourcey.com/previews/easyllm/index.html",
      preview_screenshot_url: "https://sourcey.com/previews/easyllm/preview.png",
      current_docs_url: "https://github.com/philschmid/easyllm#readme",
      summary: "Prepared a hosted preview plus a substantive docs bundle for maintainer review.",
    },
    migration_bundle: {
      summary: "Prepared a README quickstart and getting-started refresh bundle for maintainer review.",
      files: [
        { path: "README.md", contents: DOGFOOD_README_CONTENTS },
        { path: "docs/getting-started.md", contents: DOGFOOD_GETTING_STARTED_CONTENTS },
      ],
    },
    operator_summary: {
      recommended_handoff: "outreach",
      rationale: "Lead with the hosted preview and let maintainers choose whether they want a PR, a sidecar docs site, or a smaller starter patch.",
    },
    maintainer_handoff: {
      outreach_subject: "Preview a refreshed docs experience for EasyLLM",
    },
  };
}

const DOGFOOD_README_CONTENTS = `# EasyLLM

## Quickstart

Use the generated docs preview to give maintainers a full proposed docs experience before opening an upstream PR.

1. Install the project dependencies.
2. Export the provider credentials required for local runs.
3. Run the sample notebook or script from docs/getting-started.md.
`;

const DOGFOOD_GETTING_STARTED_CONTENTS = `# Getting Started

## Setup

Install the project dependencies and configure the provider credentials before running the examples.

## First Run

Execute the sample script and compare the output to the hosted Sourcey preview so maintainers can review the exact documentation proposal before merge.
`;

function readStringInput(inputs: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = inputs[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readBooleanInput(
  inputs: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fallback: boolean,
): boolean {
  for (const key of keys) {
    const value = inputs[key];
    if (value === true || value === "true") {
      return true;
    }
    if (value === false || value === "false") {
      return false;
    }
  }
  return fallback;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStringFromRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  pathSegments: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const segment of pathSegments) {
    const record = readRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return firstNonEmptyString(current);
}

function readBooleanFromRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  pathSegments: readonly string[],
): boolean | undefined {
  let current: unknown = value;
  for (const segment of pathSegments) {
    const record = readRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return typeof current === "boolean" ? current : undefined;
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pruneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}

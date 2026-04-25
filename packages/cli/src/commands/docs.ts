import { existsSync } from "node:fs";

import { resolvePathFromUserInput } from "@runxhq/core/config";
import type { Caller } from "@runxhq/core/runner-local";

import {
  buildDocsSignalOutboxEntry,
  buildDocsStatusResult,
  buildMaintainerContact,
  buildSignalSourceRef,
  loadDocsControlState,
  refreshDocsStatusComment,
  resolveDocsTaskId,
  selectDocsLane,
  synthesizeHandoffRef,
  withDocsRepoBinding,
  writeDocsRepoBinding,
} from "./docs-control.js";
import { handleDocsDoctorAction, handleDocsDogfoodAction } from "./docs-health.js";
import {
  executeDocsSkill,
  loadThreadAdapterModule,
  normalizeDocsRepoRoot,
  resolveDocsThreadCwd,
  resolveOptionalSourceyRoot,
  resolveSourceyRoot,
  toDocsSkillFailure,
} from "./docs-runtime.js";
import type {
  DocsCommandArgs,
  DocsCommandDeps,
  DocsCommandResult,
} from "./docs-shared.js";
import {
  firstNonEmptyString,
  pruneRecord,
  readBooleanFromRecord,
  readBooleanInput,
  readRecord,
  readStringFromRecord,
  readStringInput,
} from "./docs-shared.js";

export type { DocsCommandArgs, DocsCommandDeps, DocsCommandResult } from "./docs-shared.js";

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
  control: import("./docs-shared.js").DocsControlState,
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

  if (parsed.docsAction === "push-pr" && readStringFromRecord(control.handoffState, ["status"]) !== "approved_to_send") {
    return {
      status: "failure",
      action: parsed.docsAction,
      issue: control.issueRef.issue_url,
      phase: "review",
      message: "The control thread is not approved for PR push yet. Record an explicit send approval with `runx docs signal --disposition approved_to_send ...` after acceptance before using `runx docs push-pr`.",
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
  const refreshedControl = await withDocsRepoBinding(
    await loadDocsControlState(control.issueRef.adapter_ref, env, sourceyRoot),
    sourceyRoot,
  );
  await refreshDocsStatusComment(refreshedControl, env, sourceyRoot);
  const finalControl = await withDocsRepoBinding(
    await loadDocsControlState(control.issueRef.adapter_ref, env, sourceyRoot),
    sourceyRoot,
  );
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
    thread: finalControl.thread,
  };
}

async function handleDocsBindRepoAction(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  sourceyRoot: string,
  control: import("./docs-shared.js").DocsControlState,
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
  control: import("./docs-shared.js").DocsControlState,
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
  if (signalDisposition === "approved_to_send" && readStringFromRecord(control.handoffState, ["status"]) !== "accepted") {
    throw new Error("runx docs signal --disposition approved_to_send requires the control thread to already be in accepted state.");
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
  const signalOutboxEntry = buildDocsSignalOutboxEntry(control, {
    handoffRef: readRecord(signalPacket.data.handoff_ref),
    handoffSignal: readRecord(signalPacket.data.handoff_signal),
    handoffState: readRecord(signalPacket.data.handoff_state),
    suppressionRecord: readRecord(signalPacket.data.suppression_record),
  });
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

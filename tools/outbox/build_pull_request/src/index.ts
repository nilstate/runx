import {
  defineTool,
  firstNonEmptyString,
  isRecord,
  prune,
  recordInput,
  stringInput,
} from "@runxhq/authoring";
import { sanitizePublicMarkdown } from "../../../public_markdown.mjs";

export default defineTool({
  name: "outbox.build_pull_request",
  description: "Build a provider-agnostic draft pull-request packet and outbox entry from native scafld surfaces.",
  inputs: {
    task_id: stringInput({ description: "scafld task id that produced the completed engineering state." }),
    thread_title: stringInput({ optional: true, description: "Canonical thread title when the caller already has one." }),
    thread_locator: stringInput({ optional: true, description: "Canonical thread locator for the bounded work item." }),
    thread: recordInput({ optional: true, description: "Optional hydrated thread that may already carry a pull_request outbox entry." }),
    outbox_entry: recordInput({ optional: true, description: "Optional current pull_request outbox entry when refreshing an existing draft." }),
    target_repo: stringInput({ optional: true, description: "Intended repository slug when the caller already knows it." }),
    branch: stringInput({ optional: true, description: "Explicit head branch for provider publication." }),
    fix_bundle: recordInput({ optional: true, description: "Bounded fix bundle used to derive the governed file list for provider publication." }),
    handoff_markdown: stringInput({ description: "Native markdown emitted by `scafld handoff`." }),
    build_result: recordInput({ description: "Native scafld build result payload." }),
    review_result: recordInput({ description: "Native scafld review result payload." }),
    completion_result: recordInput({ description: "Native scafld complete result payload." }),
    status_snapshot: recordInput({ optional: true, description: "Native scafld status result payload." }),
    current_branch: recordInput({ optional: true, description: "Current git branch packet from git.current_branch." }),
    base: stringInput({ optional: true, description: "Base ref for the draft pull request." }),
  },
  output: {
    named_emits: {
      draft_pull_request: "draft_pull_request_packet",
      outbox_entry: "outbox_entry",
    },
    outputs: {
      draft_pull_request: {
        packet: "runx.outbox.draft_pull_request.v1",
      },
      outbox_entry: {
        packet: "runx.outbox.entry.v1",
      },
    },
  },
  scopes: ["runx:repo:package"],
  run: runBuildPullRequest,
});

function runBuildPullRequest({ inputs }) {
  const taskId = inputs.task_id;
  const handoffMarkdown = inputs.handoff_markdown;
  const buildResult = unwrapRecord(inputs.build_result) ?? {};
  const reviewResult = unwrapRecord(inputs.review_result) ?? {};
  const completionResult = unwrapRecord(inputs.completion_result) ?? {};
  const statusSnapshot = unwrapRecord(inputs.status_snapshot);
  const currentBranch = unwrapRecord(inputs.current_branch);
  const thread = optionalRecord(inputs.thread);
  const explicitOutboxEntry = optionalRecord(inputs.outbox_entry);
  const fixBundle = unwrapRecord(inputs.fix_bundle);

  const threadContext = thread ?? {};
  const changedFiles = normalizeChangedFiles(fixBundle);

  const existingOutboxEntry =
    normalizePullRequestOutbox(explicitOutboxEntry) ??
    latestPullRequestOutbox(thread);

  const threadLocator = firstNonEmptyString(
    inputs.thread_locator,
    existingOutboxEntry?.thread_locator,
    threadContext.thread_locator,
  );

  const title = firstNonEmptyString(
    completionResult.title,
    statusSnapshot?.title,
    inputs.thread_title,
    threadContext.title,
    taskId,
  );

  const targetRepo = firstNonEmptyString(
    inputs.target_repo,
    parseRepoSlug(firstNonEmptyString(threadContext.canonical_uri)),
  );

  const action = existingOutboxEntry ? "refresh" : "create";
  const reviewVerdict = firstNonEmptyString(
    reviewResult.verdict,
    optionalRecord(completionResult.review)?.verdict,
    optionalRecord(completionResult.review)?.status,
  );
  const check = buildCheck(buildResult);
  const checkStatus = firstNonEmptyString(check.status);
  const syncStatus = firstNonEmptyString(statusSnapshot?.session_ok === false ? "degraded" : "ok");
  const pushReady =
    firstNonEmptyString(completionResult.status, statusSnapshot?.status) === "completed" &&
    checkStatus === "success" &&
    !isFailingReview(reviewVerdict);
  const branch = firstNonEmptyString(
    inputs.branch,
    currentBranch?.branch,
  );
  const base = firstNonEmptyString(inputs.base);

  const draftPullRequest = prune({
    schema_version: "runx.pull-request-draft.v1",
    action,
    push_ready: pushReady,
    task_id: taskId,
    thread: prune({
      thread_locator: threadLocator,
      thread_kind: firstNonEmptyString(threadContext.thread_kind),
      title: firstNonEmptyString(
        inputs.thread_title,
        threadContext.title,
        title,
      ),
      canonical_uri: firstNonEmptyString(threadContext.canonical_uri),
    }),
    target: prune({
      repo: targetRepo,
      branch,
      base,
      remote: "origin",
    }),
    pull_request: {
      title,
      body_markdown: buildReviewerPullRequestBody({
        taskId,
        title,
        threadLocator,
        threadContext,
        handoffMarkdown,
        buildResult,
        reviewResult,
        completionResult,
        statusSnapshot,
        check,
        reviewVerdict,
        branch,
        base,
      }),
      is_draft: true,
    },
    engineering_summary_markdown: sanitizePublicMarkdown(firstNonEmptyText(handoffMarkdown)) ?? "",
    checks: Object.keys(check).length > 0 ? check : undefined,
    governance: prune({
      status: firstNonEmptyString(
        completionResult.status,
        statusSnapshot?.status,
      ),
      review_verdict: reviewVerdict,
      blocking_count: reviewFindingCount(reviewResult, "blocking"),
      non_blocking_count: reviewFindingCount(reviewResult, "non_blocking"),
      sync_status: syncStatus,
      build_passed: numberOrUndefined(buildResult.passed),
      build_failed: numberOrUndefined(buildResult.failed),
      changed_files: changedFiles,
    }),
  });

  const outboxEntry = prune({
    entry_id: firstNonEmptyString(
      existingOutboxEntry?.entry_id,
      `pull_request:${taskId}`,
    ),
    kind: "pull_request",
    locator: firstNonEmptyString(existingOutboxEntry?.locator),
    title,
    status: firstNonEmptyString(
      existingOutboxEntry?.status,
      existingOutboxEntry?.locator ? "draft" : "proposed",
    ),
    thread_locator: threadLocator,
    metadata: prune({
      schema_version: "runx.outbox-entry.pull-request.v1",
      packet_schema_version: draftPullRequest.schema_version,
      action,
      task_id: taskId,
      repo: draftPullRequest.target?.repo,
      branch: draftPullRequest.target?.branch,
      base: draftPullRequest.target?.base,
      title,
      review_verdict: reviewVerdict,
      check_status: checkStatus,
      sync_status: syncStatus,
      push_ready: pushReady,
      changed_files: changedFiles,
      human_merge_gate: "required",
      post_merge_observation: "provider_state_update",
      story_milestones: [
        "intake",
        "triage",
        "spec",
        "build",
        "review",
        "pull_request",
        "merge_gate",
        "outcome",
      ],
    }),
  });

  return {
    draft_pull_request: draftPullRequest,
    outbox_entry: outboxEntry,
  };
}

function optionalRecord(value) {
  return isRecord(value) ? value : undefined;
}

function unwrapRecord(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (isRecord(value.data)) {
    return value.data;
  }
  return value;
}

function buildCheck(buildResult) {
  const passed = numberOrUndefined(buildResult.passed);
  const failed = numberOrUndefined(buildResult.failed);
  const status = failed !== undefined
    ? failed === 0 ? "success" : "failure"
    : firstNonEmptyString(buildResult.status);
  return prune({
    status,
    summary: status ? `scafld build ${status}` : undefined,
    passed,
    failed,
  });
}

function reviewFindingCount(reviewResult, severity) {
  const explicit = numberOrUndefined(reviewResult[`${severity}_count`]);
  if (explicit !== undefined) {
    return explicit;
  }
  if (!Array.isArray(reviewResult.findings)) {
    return undefined;
  }
  return reviewResult.findings
    .filter((finding) => isRecord(finding) && finding.severity === severity)
    .length;
}

function isFailingReview(value) {
  const verdict = firstNonEmptyString(value);
  return verdict === "fail" || verdict === "blocked" || verdict === "failure";
}

function buildReviewerPullRequestBody(options) {
  const {
    taskId,
    title,
    threadLocator,
    threadContext,
    handoffMarkdown,
    buildResult,
    reviewResult,
    completionResult,
    statusSnapshot,
    check,
    reviewVerdict,
    branch,
    base,
  } = options;
  const sourceTitle = sanitizePublicMarkdown(firstNonEmptyString(
    threadContext.title,
    title,
  ));
  const sourceLocator = sanitizePublicMarkdown(firstNonEmptyString(
    threadLocator,
    threadContext.thread_locator,
  ));
  const handoff = sanitizePublicMarkdown(firstNonEmptyText(handoffMarkdown));
  const checkStatus = firstNonEmptyString(check.status, buildResult.status);
  const buildPassed = numberOrUndefined(buildResult.passed);
  const buildFailed = numberOrUndefined(buildResult.failed);
  const blockingCount = reviewFindingCount(reviewResult, "blocking");
  const nonBlockingCount = reviewFindingCount(reviewResult, "non_blocking");
  const completedStatus = firstNonEmptyString(completionResult.status, statusSnapshot?.status);
  const lines = [
    `# ${sanitizePublicMarkdown(title) ?? taskId}`,
    "",
    "## Source Thread",
    `- Thread: ${sourceLocator ? `\`${sourceLocator}\`` : "not provided"}`,
    `- Request: ${sourceTitle ?? "not provided"}`,
    "",
    "## Scoped Change",
    `- Task: \`${taskId}\``,
    `- Branch: ${branch ? `\`${sanitizePublicMarkdown(branch)}\`` : "not reported"}`,
    `- Base: ${base ? `\`${sanitizePublicMarkdown(base)}\`` : "not reported"}`,
    `- Governance status: ${completedStatus ?? "not reported"}`,
    "",
    "## Validation",
    `- scafld build: ${checkStatus ?? "not reported"}`,
    `- Passed: ${buildPassed ?? "not reported"}`,
    `- Failed: ${buildFailed ?? "not reported"}`,
    "",
    "## Review",
    `- Verdict: ${sanitizePublicMarkdown(reviewVerdict) ?? "not reported"}`,
    `- Blocking findings: ${blockingCount ?? "not reported"}`,
    `- Non-blocking findings: ${nonBlockingCount ?? "not reported"}`,
    "",
    "## Human Merge Gate",
    "- This PR is generated and reviewable; runx will not merge it.",
    "- A human reviewer must merge, close, or request changes.",
    "- After provider state changes, the source thread can be updated with the observed outcome.",
    "",
    "## scafld Handoff",
    handoff ?? "No scafld handoff was reported.",
  ];
  return `${lines.join("\n")}\n`;
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (entry) => typeof entry === "string" && entry.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function normalizePullRequestOutbox(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.kind !== "pull_request") {
    return undefined;
  }
  const entryId = firstNonEmptyString(value.entry_id);
  if (!entryId) {
    return undefined;
  }
  return {
    entry_id: entryId,
    kind: "pull_request",
    locator: firstNonEmptyString(value.locator),
    status: firstNonEmptyString(value.status),
    thread_locator: firstNonEmptyString(value.thread_locator),
  };
}

function normalizeChangedFiles(fixBundle) {
  const files = Array.isArray(fixBundle?.files) ? fixBundle.files : [];
  const paths = files
    .filter(isRecord)
    .map((file) => firstNonEmptyString(file.path))
    .filter((filePath) => filePath !== undefined);
  return paths.length > 0 ? [...new Set(paths)] : undefined;
}

function latestPullRequestOutbox(state) {
  const outbox = Array.isArray(state?.outbox) ? state.outbox : [];
  for (let index = outbox.length - 1; index >= 0; index -= 1) {
    const candidate = normalizePullRequestOutbox(outbox[index]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function parseRepoSlug(remoteUrl) {
  const value = firstNonEmptyString(remoteUrl);
  if (!value) {
    return undefined;
  }
  const sshMatch = value.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!sshMatch) {
    return undefined;
  }
  return sshMatch[1];
}

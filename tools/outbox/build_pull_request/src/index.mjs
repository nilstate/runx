import {
  defineTool,
  firstNonEmptyString,
  isRecord,
  prune,
} from "@runxhq/extension-sdk";
import {
  sanitizePublicMarkdown,
  summarizePublicHandoffMarkdown,
  renderIssueToPrReviewerMarkdown,
} from "../../markdown.mjs";
import {
  ISSUE_TO_PR_STORY_MILESTONES,
} from "../../story.mjs";
import { admitOperationalPolicyRequest } from "@runxhq/contracts";

const build_pull_request_canonical_story_milestones = [...ISSUE_TO_PR_STORY_MILESTONES];

export default defineTool({
  name: "outbox.build_pull_request",
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
  const harnessContext = optionalRecord(inputs.harness_context);
  const explicitOutboxEntry = optionalRecord(inputs.outbox_entry);
  const fixBundle = unwrapRecord(inputs.fix_bundle);

  const threadContext = thread ?? {};
  const changedFiles = normalizeChangedFiles(fixBundle);

  const existingOutboxEntry =
    normalizePullRequestOutbox(explicitOutboxEntry) ??
    latestPullRequestOutbox(thread);

  const threadLocator = assertNoPublicLeakage(firstNonEmptyString(
    inputs.thread_locator,
    existingOutboxEntry?.thread_locator,
    threadContext.thread_locator,
  ), "thread_locator");
  const sourceThreadLocator = assertNoPublicLeakage(firstNonEmptyString(
    inputs.source_thread_locator,
    threadLocator,
  ), "source_thread_locator");
  if (threadLocator && sourceThreadLocator && threadLocator !== sourceThreadLocator) {
    throw new Error("thread_locator must match source_thread_locator.");
  }

  const title = assertNoPublicLeakage(firstNonEmptyString(
    completionResult.title,
    statusSnapshot?.title,
    inputs.thread_title,
    threadContext.title,
    taskId,
  ), "title");

  const targetRepo = assertNoPublicLeakage(firstNonEmptyString(
    inputs.target_repo,
    parseRepoSlug(firstNonEmptyString(threadContext.canonical_uri)),
  ), "target_repo");
  const policyAdmission = admitPolicyRequest({
    policy: optionalRecord(inputs.operational_policy),
    sourceId: inputs.source_id,
    targetRepo,
    runnerId: inputs.runner_id,
    policyAction: inputs.policy_action,
    sourceThreadLocator,
  });

  const action = existingOutboxEntry ? "refresh" : "create";
  const reviewVerdict = firstNonEmptyString(
    reviewResult.verdict,
    optionalRecord(completionResult.review)?.verdict,
    optionalRecord(completionResult.review)?.status,
  );
  const check = buildCheck(buildResult);
  const qualityGate = buildQualityGate({
    changedFiles,
    buildResult,
    threadBody: inputs.thread_body,
    repoContext: inputs.repo_context,
    handoffMarkdown,
  });
  const checkStatus = firstNonEmptyString(check.status);
  const syncStatus = firstNonEmptyString(statusSnapshot?.session_ok === false ? "degraded" : "ok");
  const pushReady =
    firstNonEmptyString(completionResult.status, statusSnapshot?.status) === "completed" &&
    checkStatus === "success" &&
    !isFailingReview(reviewVerdict);
  const branch = assertNoPublicLeakage(firstNonEmptyString(
    inputs.branch,
    currentBranch?.branch,
  ), "branch");
  const base = assertNoPublicLeakage(firstNonEmptyString(inputs.base), "base");
  const dedupe = buildPullRequestDedupe({
    existingOutboxEntry,
    taskId,
    targetRepo,
    branch,
    threadLocator,
  });

  const draftPullRequest = prune({
    schema_version: "runx.pull-request-draft.v1",
    action,
    push_ready: pushReady,
    task_id: taskId,
    thread: prune({
      thread_locator: threadLocator,
      thread_kind: firstNonEmptyString(threadContext.thread_kind),
      title: assertNoPublicLeakage(firstNonEmptyString(
        inputs.thread_title,
        threadContext.title,
        title,
      ), "thread.title"),
      canonical_uri: firstNonEmptyString(threadContext.canonical_uri),
    }),
    target: prune({
      repo: targetRepo,
      branch,
      base,
      remote: "origin",
    }),
    harness_context: summarizeHarnessContext(harnessContext),
    operational_policy: summarizePolicyAdmission(policyAdmission),
    pull_request: {
      title,
      body_markdown: buildReviewerPullRequestBody({
        taskId,
        title,
        threadLocator,
        threadContext,
        threadBody: inputs.thread_body,
        handoffMarkdown,
        buildResult,
        reviewResult,
        completionResult,
        statusSnapshot,
        check,
        reviewVerdict,
        branch,
        base,
        changedFiles,
        qualityGate,
      }),
      is_draft: true,
    },
    engineering_summary_markdown: summarizePublicHandoffMarkdown(firstNonEmptyText(handoffMarkdown)) ?? "",
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
      quality_gate: qualityGate,
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
      harness_context: summarizeHarnessContext(harnessContext),
      operational_policy: summarizePolicyAdmission(policyAdmission),
      title,
      review_verdict: reviewVerdict,
      check_status: checkStatus,
      sync_status: syncStatus,
      push_ready: pushReady,
      changed_files: changedFiles,
      quality_gate: qualityGate,
      dedupe,
      source_thread: buildSourceThreadMetadata(sourceThreadLocator),
      human_merge_gate: "required",
      provider_outcome_observation: "provider_state_update",
      story_milestones: build_pull_request_canonical_story_milestones,
    }),
  });

  return {
    draft_pull_request: draftPullRequest,
    outbox_entry: outboxEntry,
  };
}

function admitPolicyRequest({
  policy,
  sourceId,
  targetRepo,
  runnerId,
  policyAction,
  sourceThreadLocator,
}) {
  if (!policy) {
    return undefined;
  }
  const admission = admitOperationalPolicyRequest(policy, {
    source_id: firstNonEmptyString(sourceId),
    target_repo: targetRepo,
    action: firstNonEmptyString(policyAction) ?? "issue-to-pr",
    runner_id: firstNonEmptyString(runnerId),
    source_thread_locator: firstNonEmptyString(sourceThreadLocator),
  });
  if (admission.status === "deny") {
    const codes = admission.findings.map((finding) => finding.code).join(", ");
    throw new Error(`operational policy denied pull request packaging: ${codes}`);
  }
  return admission;
}

function summarizePolicyAdmission(admission) {
  if (!admission) {
    return undefined;
  }
  return prune({
    policy_id: admission.policy_id,
    source_id: admission.source_id,
    target_repo: admission.target_repo,
    runner_id: admission.runner_id,
    owner_route_id: admission.owner_route_id,
    owner_count: Array.isArray(admission.owners) ? admission.owners.length : undefined,
    dedupe_strategy: admission.dedupe_strategy,
    outcome_close_mode: admission.outcome_close_mode,
    source_thread_required: admission.source_thread_required,
    mutate_target_repo: admission.mutate_target_repo,
    require_human_merge_gate: admission.require_human_merge_gate,
  });
}

function buildPullRequestDedupe({
  existingOutboxEntry,
  taskId,
  targetRepo,
  branch,
  threadLocator,
}) {
  const branchKey = targetRepo && branch ? `${targetRepo}:${branch}` : undefined;
  return prune({
    strategy: branchKey ? "branch" : "source_fingerprint",
    key: firstNonEmptyString(branchKey, threadLocator, `task:${taskId}`),
    result: existingOutboxEntry ? "reused" : "created",
    existing_entry_id: existingOutboxEntry?.entry_id,
    existing_locator: existingOutboxEntry?.locator,
  });
}

function summarizeHarnessContext(harnessContext) {
  if (!harnessContext) {
    return undefined;
  }
  const harness = optionalRecord(harnessContext.harness);
  const signal = optionalRecord(harnessContext.signal);
  const decision = optionalRecord(harnessContext.decision);
  const fingerprint = optionalRecord(signal?.fingerprint);
  return prune({
    harness_id: firstNonEmptyString(harness?.harness_id),
    state: firstNonEmptyString(harness?.state),
    signal: signal
      ? prune({
          signal_id: firstNonEmptyString(signal.signal_id),
          signal_type: firstNonEmptyString(signal.signal_type),
          fingerprint: firstNonEmptyString(fingerprint?.value),
        })
      : undefined,
    decision: decision
      ? prune({
          decision_id: firstNonEmptyString(decision.decision_id),
          choice: firstNonEmptyString(decision.choice),
          selected_act_id: firstNonEmptyString(decision.selected_act_id),
        })
      : undefined,
  });
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
  if (severity === "blocking") {
    return reviewResult.findings
      .filter((finding) => isRecord(finding) && finding.blocks_completion === true)
      .length;
  }
  if (severity === "non_blocking") {
    return reviewResult.findings
      .filter((finding) => isRecord(finding) && finding.blocks_completion === false)
      .length;
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
    threadBody,
    handoffMarkdown,
    buildResult,
    reviewResult,
    completionResult,
    statusSnapshot,
    check,
    reviewVerdict,
    branch,
    base,
    changedFiles,
    qualityGate,
  } = options;
  const sourceTitle = sanitizePublicMarkdown(firstNonEmptyString(
    threadContext.title,
    title,
  ));
  const sourceLocator = sanitizePublicMarkdown(firstNonEmptyString(
    threadLocator,
    threadContext.thread_locator,
  ));
  const handoff = firstNonEmptyText(handoffMarkdown);
  const checkStatus = firstNonEmptyString(check.status, buildResult.status);
  const buildPassed = numberOrUndefined(buildResult.passed);
  const buildFailed = numberOrUndefined(buildResult.failed);
  const blockingCount = reviewFindingCount(reviewResult, "blocking");
  const nonBlockingCount = reviewFindingCount(reviewResult, "non_blocking");
  const completedStatus = firstNonEmptyString(completionResult.status, statusSnapshot?.status);
  return renderIssueToPrReviewerMarkdown({
    taskId,
    title,
    sourceTitle,
    sourceLocator,
    sourceSummary: summarizeSourceContext(threadBody),
    branch,
    base,
    governanceStatus: completedStatus,
    checkStatus,
    buildPassed,
    buildFailed,
    reviewVerdict,
    blockingCount,
    nonBlockingCount,
    changedFiles,
    qualityGateSummary: qualityGate?.summary,
    handoffMarkdown: handoff,
  });
}

function buildQualityGate({ changedFiles, buildResult, threadBody, repoContext, handoffMarkdown }) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const codeFiles = files.filter((filePath) => isCodeFile(filePath) && !isTestFile(filePath));
  const testFiles = files.filter((filePath) => isTestFile(filePath));
  const requiresRegressionCoverage = sourceRequiresRegressionCoverage(threadBody);
  const passed = numberOrUndefined(buildResult.passed);
  const failed = numberOrUndefined(buildResult.failed);
  const validationCount = (passed ?? 0) + (failed ?? 0);
  const contextSummary = firstNonEmptyString(repoContext, handoffMarkdown);

  if (codeFiles.length > 0 && requiresRegressionCoverage && testFiles.length === 0) {
    throw new Error(
      "pull request quality gate failed: source/spec requested regression coverage, but the fix bundle changed code without a test/spec file.",
    );
  }

  if (codeFiles.length > 0 && validationCount === 0 && testFiles.length === 0) {
    throw new Error(
      "pull request quality gate failed: code PRs must publish with either scafld validation evidence or a test/spec file.",
    );
  }

  return prune({
    status: "passed",
    summary: qualityGateSummary({
      codeFileCount: codeFiles.length,
      testFileCount: testFiles.length,
      requiresRegressionCoverage,
      validationCount,
      hasContext: typeof contextSummary === "string" && contextSummary.trim().length > 0,
    }),
    code_file_count: codeFiles.length,
    test_file_count: testFiles.length,
    required_regression_coverage: requiresRegressionCoverage,
    validation_check_count: validationCount,
    scafld_validation_check_count: validationCount,
    validation_source: validationCount > 0 ? "scafld" : testFiles.length > 0 ? "test_file" : undefined,
  });
}

function qualityGateSummary({ codeFileCount, testFileCount, requiresRegressionCoverage, validationCount, hasContext }) {
  if (codeFileCount === 0) {
    return "No code files changed; code validation gate not required.";
  }
  const parts = validationCount > 0
    ? [`${validationCount} scafld validation check${validationCount === 1 ? "" : "s"}`]
    : ["scafld validation count unavailable"];
  if (requiresRegressionCoverage || testFileCount > 0) {
    parts.push(`${testFileCount} test/spec file${testFileCount === 1 ? "" : "s"}`);
  }
  if (hasContext) {
    parts.push("source context present");
  }
  return `Code quality gate passed with ${parts.join(", ")}.`;
}

function sourceRequiresRegressionCoverage(value) {
  const text = firstNonEmptyString(value)?.toLowerCase() ?? "";
  if (!text) {
    return false;
  }
  return /\b(?:regression coverage|focused (?:request\/service )?coverage|request\/service coverage|automated coverage|add(?:ed)? (?:focused )?(?:tests?|specs?)|update(?:d)? (?:focused )?(?:tests?|specs?)|with (?:focused )?(?:tests?|specs?)|coverage)\b/u.test(text);
}

function summarizeSourceContext(value) {
  const sanitized = sanitizePublicMarkdown(firstNonEmptyText(value));
  if (!sanitized) {
    return undefined;
  }
  const lines = sanitized
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^<!--/.test(line.trim()));
  const summary = lines.slice(0, 18).join("\n").slice(0, 1600).trim();
  return summary.length > 0 ? summary : undefined;
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
    .filter((filePath) => filePath !== undefined)
    .map((filePath) => normalizeChangedFilePath(filePath));
  return paths.length > 0 ? [...new Set(paths)] : undefined;
}

function buildSourceThreadMetadata(threadLocator) {
  const locator = assertNoPublicLeakage(threadLocator, "source_thread.thread_locator");
  if (!locator) {
    return undefined;
  }
  return {
    required: true,
    publish_mode: "reply",
    missing_behavior: "fail_closed",
    thread_locator: locator,
  };
}

function normalizeChangedFilePath(value) {
  const raw = assertNoPublicLeakage(value, "changed_files");
  const normalized = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new Error("outbox changed file path must be a relative path inside the workspace.");
  }
  return normalized;
}

function isCodeFile(filePath) {
  return /\.(?:rb|[cm]?[jt]sx?|py|go|rs|java|kt|php|cs)$/u.test(filePath);
}

function isTestFile(filePath) {
  return /(^|\/)(?:spec|test|tests|__tests__)\//u.test(filePath)
    || /(?:_spec|_test)\.[^.]+$/u.test(filePath)
    || /\.(?:spec|test)\.[^.]+$/u.test(filePath);
}

function assertNoPublicLeakage(value, label) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  if (containsLocalFilesystemPath(text)) {
    throw new Error(`${label} must not contain local filesystem paths.`);
  }
  if (containsSecretMaterial(text)) {
    throw new Error(`${label} must not contain secret material.`);
  }
  return text;
}

function containsLocalFilesystemPath(value) {
  return /(?:^|[\s=("'`])(?:\/Users|\/home|\/var|\/private|\/tmp)\/[^\s)"'`]+/.test(value) ||
    /[A-Za-z]:\\[^\s)"'`]+/.test(value);
}

function containsSecretMaterial(value) {
  return /\b(gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/.test(value) ||
    /\b((?:bearer|authorization)\s+)[A-Za-z0-9._:-]{6,}\b/i.test(value) ||
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|MATERIAL[_-]?REF)[A-Z0-9_]*=/.test(value);
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

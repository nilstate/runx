import {
  defineTool,
  firstNonEmptyString,
  isRecord,
  prune,
  recordInput,
  stringInput,
} from "@runxhq/authoring";
import { buildThreadPullRequestReviewerPacketMarkdown } from "@runxhq/core/knowledge";

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

  const threadContext = thread ?? {};

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
    currentBranch?.branch,
    inputs.branch,
  );
  const base = firstNonEmptyString(inputs.base);
  const handoffText = firstNonEmptyText(handoffMarkdown);
  const reviewerPacketMarkdown = buildThreadPullRequestReviewerPacketMarkdown({
    title,
    summary: summarizeHandoff(handoffText, title),
    source: threadLocator
      ? {
          label: "Source thread",
          uri: firstNonEmptyString(threadContext.canonical_uri, threadLocator),
        }
      : undefined,
    targetRepo,
    branch,
    base,
    status: firstNonEmptyString(
      completionResult.status,
      statusSnapshot?.status,
    ),
    reviewVerdict,
    checks: buildReviewPacketChecks(check),
    risks: buildReviewPacketRisks(reviewResult),
    handoffReference: "Full native scafld handoff is retained in `engineering_summary_markdown` on this draft pull-request packet.",
    nextAction: "Review the implementation, validation, and source thread. Merge manually only when the human gate is satisfied.",
  });

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
      body_markdown: reviewerPacketMarkdown,
      is_draft: true,
    },
    engineering_summary_markdown:
      handoffText ?? "",
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
    }),
  });

  return {
    draft_pull_request: draftPullRequest,
    outbox_entry: outboxEntry,
  };
}

function summarizeHandoff(handoffMarkdown, fallbackTitle) {
  const summarySection = extractMarkdownSection(handoffMarkdown, "Summary");
  if (summarySection) {
    return summarySection;
  }
  const firstParagraph = firstNonEmptyText(
    ...String(handoffMarkdown ?? "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph
        .split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed.length > 0
            && !trimmed.startsWith("#")
            && !/^status:/i.test(trimmed)
            && !/^next:/i.test(trimmed);
        })
        .join("\n")
        .trim()),
  );
  return firstParagraph ?? `Runx prepared a governed change for ${fallbackTitle}.`;
}

function extractMarkdownSection(markdown, heading) {
  const text = firstNonEmptyText(markdown);
  if (!text) {
    return undefined;
  }
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^#{2,6}\\s+${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s+|$)`, "im");
  const match = text.match(pattern);
  return firstNonEmptyText(match?.[1]);
}

function buildReviewPacketChecks(check) {
  const lines = [];
  if (firstNonEmptyString(check.status)) {
    lines.push(`scafld build ${check.status}`);
  }
  const passed = numberOrUndefined(check.passed);
  const failed = numberOrUndefined(check.failed);
  if (passed !== undefined || failed !== undefined) {
    lines.push(`${passed ?? 0} passed / ${failed ?? 0} failed`);
  }
  return lines;
}

function buildReviewPacketRisks(reviewResult) {
  const blocking = reviewFindingCount(reviewResult, "blocking");
  const nonBlocking = reviewFindingCount(reviewResult, "non_blocking");
  const lines = [];
  if (blocking !== undefined) {
    lines.push(`${blocking} blocking review finding${blocking === 1 ? "" : "s"}`);
  }
  if (nonBlocking !== undefined) {
    lines.push(`${nonBlocking} non-blocking review finding${nonBlocking === 1 ? "" : "s"}`);
  }
  return lines;
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
      .filter((finding) => isRecord(finding) && (finding.blocks_completion === true || finding.severity === "blocking"))
      .length;
  }
  if (severity === "non_blocking") {
    return reviewResult.findings
      .filter((finding) => isRecord(finding) && (finding.blocks_completion === false || finding.severity === "non_blocking"))
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

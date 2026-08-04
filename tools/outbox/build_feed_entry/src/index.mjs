import {
  defineTool,
  firstNonEmptyString,
  isRecord,
  prune,
} from "@runxhq/extension-sdk";
import {
  assertStoryMilestoneId,
  buildFeedStoryOutboxEntry,
  canonicalStoryEntryIdForRefresh,
  renderFeedStoryMarkdown,
  storyMilestoneRefreshesPublishedEntry,
} from "../../story.mjs";

export default defineTool({
  name: "outbox.build_feed_entry",
  run: runBuildFeedStory,
});

function runBuildFeedStory({ inputs }) {
  const thread = optionalRecord(inputs.thread);
  const harnessContext = optionalRecord(inputs.harness_context) ?? {};
  const harness = optionalRecord(harnessContext.harness);
  const signal = optionalRecord(harnessContext.signal);
  const decision = optionalRecord(harnessContext.decision);
  const signalSource = optionalRecord(signal?.source_ref);
  const signalThread = optionalRecord(signal?.thread_ref);
  const signalFingerprint = optionalRecord(signal?.fingerprint);
  const decisionJustification = optionalRecord(decision?.justification);
  const buildResult = unwrapRecord(inputs.build_result) ?? {};
  const reviewResult = unwrapRecord(inputs.review_result) ?? {};
  const completionResult = unwrapRecord(inputs.completion_result) ?? {};
  const statusSnapshot = unwrapRecord(inputs.status_snapshot) ?? {};
  const draftPullRequest = unwrapRecord(inputs.draft_pull_request) ?? {};
  const pullRequestOutboxEntry = unwrapRecord(inputs.pull_request_outbox_entry) ?? {};
  const pushResult = unwrapRecord(inputs.push_result) ?? {};
  const draftThread = optionalRecord(draftPullRequest.thread) ?? {};
  const draftPullRequestBody = optionalRecord(draftPullRequest.pull_request) ?? {};
  const pullRequestMetadata = optionalRecord(pullRequestOutboxEntry.metadata) ?? {};
  const threadLocator = firstNonEmptyString(
    inputs.thread_locator,
    signalThread?.uri,
    signalSource?.uri,
    thread?.thread_locator,
    draftThread.thread_locator,
    pullRequestOutboxEntry.thread_locator,
  );
  if (!threadLocator) {
    throw new Error("source thread locator is required to build an issue-to-PR feed entry.");
  }
  const taskId = firstNonEmptyString(inputs.task_id, draftPullRequest.task_id, pullRequestMetadata.task_id);
  const title = firstNonEmptyString(
    inputs.thread_title,
    signal?.title,
    thread?.title,
    draftPullRequestBody.title,
    pullRequestOutboxEntry.title,
    statusSnapshot.title,
    completionResult.title,
    taskId,
  );
  const reviewVerdict = firstNonEmptyString(
    reviewResult.verdict,
    optionalRecord(completionResult.review)?.verdict,
    optionalRecord(completionResult.review)?.status,
  );
  const buildStatus = firstNonEmptyString(
    buildResult.failed === 0 ? "success" : undefined,
    buildResult.status,
  );
  const providerPushStatus = firstNonEmptyString(pushResult.status, "not reported");
  const pullRequest = optionalRecord(pushResult.pull_request) ?? {};
  const threadPullRequestOutboxEntry = latestPullRequestOutbox(thread);
  const pullRequestUrl = firstNonEmptyString(
    pullRequest.url,
    pullRequestOutboxEntry.locator,
    threadPullRequestOutboxEntry?.locator,
  );
  const providerOutcome = observeProviderOutcome({
    pullRequest,
    pullRequestOutboxEntry,
    threadPullRequestOutboxEntry,
  });
  const outcomeObserved = Boolean(providerOutcome);
  const story = prune({
    thread_locator: threadLocator,
    title,
    next_action: outcomeObserved
      ? "Provider outcome has been observed; the source thread now carries the final PR state."
      : pullRequestUrl
      ? "Human reviewer reviews and merges the PR when satisfied; runx observes the provider outcome and updates the source thread."
      : "Human reviewer reviews the draft PR when it is published; runx does not merge generated PRs.",
    milestones: [
      {
        kind: "accepted",
        status: "completed",
        summary: firstNonEmptyString(signal?.body_preview, "Source signal captured as the harness input."),
        details: [
          `Thread: ${threadLocator}`,
          signal?.signal_id ? `Signal: ${signal.signal_id}` : undefined,
          harness?.harness_id ? `Harness: ${harness.harness_id}` : undefined,
          harness?.state ? `State: ${harness.state}` : undefined,
          signalFingerprint?.value ? `Fingerprint: ${signalFingerprint.value}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "triaged",
        status: "passed",
        summary: decisionJustification?.summary
          ? `Decision ${firstNonEmptyString(decision?.choice, "selected a runx lane")}: ${decisionJustification.summary}`
          : "Issue accepted as bounded scafld-governed engineering work.",
        details: [
          decision?.decision_id ? `Decision: ${decision.decision_id}` : undefined,
          decision?.selected_act_id ? `Selected act: ${decision.selected_act_id}` : undefined,
          "Repo-specific Slack, Sentry, owner, and channel policy remains outside runx core.",
        ].filter(Boolean),
      },
      {
        kind: "spec_ready",
        status: completionResult.status === "completed" || statusSnapshot.status === "completed" ? "completed" : "ready",
        summary: `scafld task '${taskId}' completed the governed lifecycle.`,
        details: statusSnapshot.status ? [`Final status: ${statusSnapshot.status}`] : [],
      },
      {
        kind: "build_started",
        status: buildStatus === "failure" ? "failed" : buildStatus === "success" ? "passed" : "ready",
        summary: buildStatus ? `scafld build ${buildStatus}.` : "scafld build evidence recorded.",
        details: [
          buildResult.passed !== undefined ? `Passed checks: ${buildResult.passed}` : undefined,
          buildResult.failed !== undefined ? `Failed checks: ${buildResult.failed}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "review_requested",
        status: reviewVerdict && !isPassingReview(reviewVerdict) ? "failed" : reviewVerdict ? "passed" : "ready",
        summary: reviewVerdict ? `Review verdict: ${reviewVerdict}.` : "Review gate completed.",
        details: [
          reviewFindingCount(reviewResult, "blocking") !== undefined ? `Blocking findings: ${reviewFindingCount(reviewResult, "blocking")}` : undefined,
          reviewFindingCount(reviewResult, "non_blocking") !== undefined ? `Non-blocking findings: ${reviewFindingCount(reviewResult, "non_blocking")}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "change_request_created",
        status: pullRequestUrl ? "ready" : "pending",
        summary: pullRequestUrl ? "Draft PR is linked for human review." : `Draft pull request packaging status: ${providerPushStatus}.`,
        details: [
          pullRequestUrl ? `PR: ${pullRequestUrl}` : undefined,
          pullRequestMetadata.branch ? `Branch: ${pullRequestMetadata.branch}` : undefined,
          pullRequestMetadata.base ? `Base: ${pullRequestMetadata.base}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "human_gate",
        status: outcomeObserved ? "completed" : "ready",
        summary: outcomeObserved
          ? "Human merge gate has a provider outcome recorded; runx did not auto-merge the PR."
          : "Human merge gate is required; runx will not auto-merge the generated PR.",
        details: outcomeObserved
          ? ["Provider state was observed externally and packaged as an outcome update."]
          : ["After merge or close, provider state should update the source thread outcome."],
      },
      outcomeObserved
        ? {
            kind: "final_outcome",
            status: "completed",
            summary: `Provider outcome observed: ${providerOutcome.kind}.`,
            details: [
              providerOutcome.state ? `Provider state: ${providerOutcome.state}` : undefined,
              providerOutcome.mergedAt ? `Merged at: ${providerOutcome.mergedAt}` : undefined,
              pullRequestUrl ? `PR: ${pullRequestUrl}` : undefined,
            ].filter(Boolean),
          }
        : {
            kind: "final_outcome",
            status: "pending",
            summary: "No final provider outcome has been observed yet.",
            details: ["Refresh the source thread after the PR is merged or closed to publish the final outcome."],
          },
    ],
  });
  const bodyMarkdown = renderFeedStoryMarkdown(story);
  const milestoneKind = outcomeObserved ? "final_outcome" : "human_gate";
  const outboxEntry = buildFeedStoryOutboxEntry({
    taskId,
    threadLocator,
    title: outcomeObserved ? "Issue-to-PR outcome" : "Issue-to-PR story",
    milestone: {
      kind: milestoneKind,
      status: outcomeObserved ? "completed" : "ready",
      summary: outcomeObserved
        ? `Provider outcome observed: ${providerOutcome.kind}.`
        : "Human merge gate is ready with the feed entry attached.",
    },
    bodyMarkdown,
    updatedAt: new Date().toISOString(),
  });

  return {
    feed_entry: {
      schema: "runx.feed_entry.v1",
      data: story,
    },
    outbox_entry: preserveTrustedStoryProviderState(thread, outboxEntry),
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

function isPassingReview(value) {
  const verdict = firstNonEmptyString(value);
  return verdict === "pass" || verdict === "pass_with_issues";
}

function reviewFindingCount(reviewResult, kind) {
  const explicit = numberOrUndefined(reviewResult[`${kind}_count`]);
  if (explicit !== undefined) {
    return explicit;
  }
  if (!Array.isArray(reviewResult.findings)) {
    return undefined;
  }
  if (kind === "blocking") {
    return reviewResult.findings
      .filter((finding) => isRecord(finding) && finding.blocks_completion === true)
      .length;
  }
  if (kind === "non_blocking") {
    return reviewResult.findings
      .filter((finding) => isRecord(finding) && finding.blocks_completion === false)
      .length;
  }
  return undefined;
}

function latestPullRequestOutbox(state) {
  const outbox = Array.isArray(state?.outbox) ? state.outbox : [];
  for (let index = outbox.length - 1; index >= 0; index -= 1) {
    const candidate = optionalRecord(outbox[index]);
    if (candidate?.kind === "pull_request") {
      return candidate;
    }
  }
  return undefined;
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function preserveTrustedStoryProviderState(thread, outboxEntry) {
  const existing = latestTrustedStoryOutbox(thread, outboxEntry);
  if (!existing) {
    return outboxEntry;
  }
  const existingMetadata = optionalRecord(existing.metadata) ?? {};
  const nextMetadata = optionalRecord(outboxEntry.metadata) ?? {};
  return prune({
    ...outboxEntry,
    locator: firstNonEmptyString(existing.locator, outboxEntry.locator),
    metadata: prune({
      ...existingMetadata,
      ...nextMetadata,
      channel: firstNonEmptyString(existingMetadata.channel, nextMetadata.channel),
      comment_id: firstNonEmptyString(existingMetadata.comment_id, nextMetadata.comment_id),
      outbox_receipt_id: firstNonEmptyString(existingMetadata.outbox_receipt_id, nextMetadata.outbox_receipt_id),
    }),
  });
}

function latestTrustedStoryOutbox(state, outboxEntry) {
  const outbox = Array.isArray(state?.outbox) ? state.outbox.filter(isRecord) : [];
  const adapter = optionalRecord(state?.adapter) ?? {};
  const adapterType = firstNonEmptyString(adapter.type);
  const requestedMetadata = optionalRecord(outboxEntry.metadata) ?? {};
  const requestedMilestone = assertStoryMilestoneId(
    firstNonEmptyString(requestedMetadata.milestone_kind),
    "outbox_entry.metadata.milestone_kind",
  );
  const requestedEntryId = firstNonEmptyString(outboxEntry.entry_id);
  for (let index = outbox.length - 1; index >= 0; index -= 1) {
    const candidate = outbox[index];
    const candidateMetadata = optionalRecord(candidate.metadata) ?? {};
    const candidateMilestone = firstNonEmptyString(candidateMetadata.milestone_kind);
    if (
      candidate.kind === "message" &&
      canonicalStoryEntryIdForRefresh(
        firstNonEmptyString(candidate.entry_id),
        candidateMilestone,
        requestedMilestone,
      ) === requestedEntryId &&
      firstNonEmptyString(candidate.locator) &&
      storyProviderStateIsTrusted(adapterType, candidateMetadata) &&
      firstNonEmptyString(candidateMetadata.schema_version) === "runx.outbox-entry.feed-entry.v1" &&
      storyMilestoneRefreshesPublishedEntry(
        candidateMilestone,
        requestedMilestone,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

function storyProviderStateIsTrusted(adapterType, metadata) {
  if (adapterType === "file") {
    return true;
  }
  return Boolean(firstNonEmptyString(metadata.outbox_receipt_id));
}

function observeProviderOutcome({
  pullRequest,
  pullRequestOutboxEntry,
  threadPullRequestOutboxEntry,
}) {
  const pullRequestMetadata = optionalRecord(pullRequestOutboxEntry.metadata) ?? {};
  const threadPullRequestMetadata = optionalRecord(threadPullRequestOutboxEntry?.metadata) ?? {};
  const explicitOutcome = firstNonEmptyString(
    pullRequestMetadata.provider_outcome,
    threadPullRequestMetadata.provider_outcome,
  );
  const mergedAt = firstNonEmptyString(
    pullRequest.mergedAt,
    pullRequest.merged_at,
    pullRequestMetadata.merged_at,
    threadPullRequestMetadata.merged_at,
  );
  const state = firstNonEmptyString(
    pullRequest.state,
    pullRequestMetadata.state,
    threadPullRequestMetadata.state,
  );
  const status = firstNonEmptyString(
    pullRequestOutboxEntry.status,
    threadPullRequestOutboxEntry?.status,
  );
  const normalizedOutcome = normalizeProviderOutcome(explicitOutcome);

  if (normalizedOutcome) {
    return prune({
      kind: normalizedOutcome,
      state,
      mergedAt,
    });
  }
  if (mergedAt) {
    return prune({
      kind: "merged",
      state: firstNonEmptyString(state, "MERGED"),
      mergedAt,
    });
  }
  if (String(state ?? "").toUpperCase() === "CLOSED" || status === "closed") {
    return prune({
      kind: "closed",
      state: firstNonEmptyString(state, "CLOSED"),
    });
  }
  return undefined;
}

function normalizeProviderOutcome(value) {
  const outcome = firstNonEmptyString(value)?.toLowerCase();
  if (outcome === "merged" || outcome === "closed" || outcome === "superseded") {
    return outcome;
  }
  return undefined;
}

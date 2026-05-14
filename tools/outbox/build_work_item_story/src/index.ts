import {
  defineTool,
  firstNonEmptyString,
  isRecord,
  prune,
  recordInput,
  stringInput,
} from "@runxhq/authoring";
import {
  buildWorkItemStoryOutboxEntry,
  renderWorkItemStoryMarkdown,
} from "@runxhq/core/knowledge";

export default defineTool({
  name: "outbox.build_work_item_story",
  description: "Build a concise source-thread lifecycle story message from native scafld and outbox surfaces.",
  inputs: {
    task_id: stringInput({ description: "scafld task id that produced the lifecycle state." }),
    thread_title: stringInput({ optional: true, description: "Canonical source thread title." }),
    thread_locator: stringInput({ optional: true, description: "Canonical source thread locator." }),
    thread: recordInput({ optional: true, description: "Optional hydrated source thread." }),
    build_result: recordInput({ optional: true, description: "Native scafld build result payload." }),
    review_result: recordInput({ optional: true, description: "Native scafld review result payload." }),
    completion_result: recordInput({ optional: true, description: "Native scafld completion payload." }),
    status_snapshot: recordInput({ optional: true, description: "Native scafld status payload." }),
    draft_pull_request: recordInput({ optional: true, description: "Draft pull-request packet from outbox.build_pull_request." }),
    pull_request_outbox_entry: recordInput({ optional: true, description: "Published or refreshed pull-request outbox entry." }),
    push_result: recordInput({ optional: true, description: "Provider push result from thread.push_outbox." }),
  },
  output: {
    named_emits: {
      story: "work_item_story",
      outbox_entry: "outbox_entry",
    },
    outputs: {
      story: {
        packet: "runx.work-item-story.v1",
      },
      outbox_entry: {
        packet: "runx.outbox.entry.v1",
      },
    },
  },
  scopes: ["runx:repo:package"],
  run: runBuildWorkItemStory,
});

function runBuildWorkItemStory({ inputs }) {
  const thread = optionalRecord(inputs.thread);
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
    thread?.thread_locator,
    draftThread.thread_locator,
    pullRequestOutboxEntry.thread_locator,
    "thread:not-provided",
  );
  const taskId = firstNonEmptyString(inputs.task_id, draftPullRequest.task_id, pullRequestMetadata.task_id);
  const title = firstNonEmptyString(
    inputs.thread_title,
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
        kind: "intake",
        status: "completed",
        summary: "Source thread captured as the work item's control surface.",
        details: [`Thread: ${threadLocator}`],
      },
      {
        kind: "triage",
        status: "passed",
        summary: "Issue accepted as bounded scafld-governed engineering work.",
        details: ["Repo-specific Slack, Sentry, owner, and channel policy remains outside runx core."],
      },
      {
        kind: "spec",
        status: completionResult.status === "completed" || statusSnapshot.status === "completed" ? "completed" : "ready",
        summary: `scafld task '${taskId}' completed the governed lifecycle.`,
        details: statusSnapshot.status ? [`Final status: ${statusSnapshot.status}`] : [],
      },
      {
        kind: "build",
        status: buildStatus === "failure" ? "failed" : buildStatus === "success" ? "passed" : "ready",
        summary: buildStatus ? `scafld build ${buildStatus}.` : "scafld build evidence recorded.",
        details: [
          buildResult.passed !== undefined ? `Passed checks: ${buildResult.passed}` : undefined,
          buildResult.failed !== undefined ? `Failed checks: ${buildResult.failed}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "review",
        status: reviewVerdict && !isPassingReview(reviewVerdict) ? "failed" : reviewVerdict ? "passed" : "ready",
        summary: reviewVerdict ? `Review verdict: ${reviewVerdict}.` : "Review gate completed.",
        details: [
          reviewResult.blocking_count !== undefined ? `Blocking findings: ${reviewResult.blocking_count}` : undefined,
          reviewResult.non_blocking_count !== undefined ? `Non-blocking findings: ${reviewResult.non_blocking_count}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "pull_request",
        status: pullRequestUrl ? "ready" : "pending",
        summary: pullRequestUrl ? "Draft PR is linked for human review." : `Draft pull request packaging status: ${providerPushStatus}.`,
        details: [
          pullRequestUrl ? `PR: ${pullRequestUrl}` : undefined,
          pullRequestMetadata.branch ? `Branch: ${pullRequestMetadata.branch}` : undefined,
          pullRequestMetadata.base ? `Base: ${pullRequestMetadata.base}` : undefined,
        ].filter(Boolean),
      },
      {
        kind: "merge_gate",
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
            kind: "outcome",
            status: "completed",
            summary: `Provider outcome observed: ${providerOutcome.kind}.`,
            details: [
              providerOutcome.state ? `Provider state: ${providerOutcome.state}` : undefined,
              providerOutcome.mergedAt ? `Merged at: ${providerOutcome.mergedAt}` : undefined,
              pullRequestUrl ? `PR: ${pullRequestUrl}` : undefined,
            ].filter(Boolean),
          }
        : {
            kind: "outcome",
            status: "pending",
            summary: "No final provider outcome has been observed yet.",
            details: ["Refresh the source thread after the PR is merged or closed to publish the final outcome."],
          },
    ],
  });
  const bodyMarkdown = renderWorkItemStoryMarkdown(story);
  const milestoneKind = outcomeObserved ? "outcome" : "merge_gate";

  return {
    story: {
      schema: "runx.work-item-story.v1",
      data: story,
    },
    outbox_entry: buildWorkItemStoryOutboxEntry({
      taskId,
      threadLocator,
      title: outcomeObserved ? "Issue-to-PR outcome" : "Issue-to-PR story",
      milestone: {
        kind: milestoneKind,
        status: outcomeObserved ? "completed" : "ready",
        summary: outcomeObserved
          ? `Provider outcome observed: ${providerOutcome.kind}.`
          : "Human merge gate is ready with the lifecycle story attached.",
      },
      bodyMarkdown,
      updatedAt: new Date().toISOString(),
    }),
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

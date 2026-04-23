import {
  defineTool,
  firstNonEmptyString,
  isRecord,
  prune,
  recordInput,
  stringInput,
} from "../../_lib/harness.mjs";

const tool = defineTool({
  name: "outbox.build_pull_request",
  inputs: {
    task_id: stringInput(),
    thread_title: stringInput({ optional: true }),
    thread_locator: stringInput({ optional: true }),
    thread: recordInput({ optional: true }),
    outbox_entry: recordInput({ optional: true }),
    target_repo: stringInput({ optional: true }),
    summary_projection: recordInput(),
    checks_projection: recordInput(),
    pr_body_projection: recordInput(),
    completion_result: recordInput(),
    completion_state: recordInput({ optional: true }),
    status_snapshot: recordInput({ optional: true }),
  },
  run: runBuildPullRequest,
});

await tool.main();

function runBuildPullRequest({ inputs }) {
  const taskId = inputs.task_id;
  const summaryProjection = inputs.summary_projection;
  const checksProjection = inputs.checks_projection;
  const prBodyProjection = inputs.pr_body_projection;
  const completionResult = inputs.completion_result;
  const completionState = optionalRecord(inputs.completion_state);
  const statusSnapshot = optionalRecord(inputs.status_snapshot);
  const thread = optionalRecord(inputs.thread);
  const explicitOutboxEntry = optionalRecord(inputs.outbox_entry);

  const summaryModel = optionalRecord(summaryProjection.model);
  const prBodyModel = optionalRecord(prBodyProjection.model);
  const summaryOrigin = optionalRecord(summaryModel?.origin) ?? {};
  const prBodyOrigin = optionalRecord(prBodyModel?.origin) ?? {};
  const origin = {
    ...summaryOrigin,
    ...prBodyOrigin,
    git: {
      ...(optionalRecord(summaryOrigin.git) ?? {}),
      ...(optionalRecord(prBodyOrigin.git) ?? {}),
    },
    repo: {
      ...(optionalRecord(summaryOrigin.repo) ?? {}),
      ...(optionalRecord(prBodyOrigin.repo) ?? {}),
    },
    source: {
      ...(optionalRecord(summaryOrigin.source) ?? {}),
      ...(optionalRecord(prBodyOrigin.source) ?? {}),
    },
  };
  const model = {
    ...(summaryModel ?? {}),
    ...(prBodyModel ?? {}),
    origin,
  };
  const originGit = optionalRecord(origin.git) ?? {};
  const originRepo = optionalRecord(origin.repo) ?? {};
  const originSource = optionalRecord(origin.source) ?? {};
  const check = optionalRecord(checksProjection.check) ?? {};
  const sync =
    optionalRecord(statusSnapshot?.sync) ?? optionalRecord(model.sync) ?? {};
  const reviewState =
    optionalRecord(statusSnapshot?.review_state) ??
    optionalRecord(model.review) ??
    {};
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
    model.title,
    inputs.thread_title,
    threadContext.title,
    taskId,
  );

  const targetRepo = firstNonEmptyString(
    inputs.target_repo,
    parseRepoSlug(firstNonEmptyString(originRepo.remote_url)),
    originRepo.remote_url,
    originRepo.remote,
  );

  const action = existingOutboxEntry ? "refresh" : "create";
  const reviewVerdict = firstNonEmptyString(
    completionState?.review_verdict,
    reviewState.verdict,
    reviewState.round_status,
  );
  const specPath = firstNonEmptyString(
    completionResult.archive_path,
    statusSnapshot?.file,
  );
  const reviewFile = firstNonEmptyString(completionResult.review_file);
  const checkStatus = firstNonEmptyString(check.status);
  const syncStatus = firstNonEmptyString(sync.status);
  const pushReady =
    firstNonEmptyString(completionState?.status, "unknown") === "completed" &&
    checkStatus !== "failure";

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
      branch: firstNonEmptyString(originGit.branch),
      base: firstNonEmptyString(originGit.base_ref),
      remote: firstNonEmptyString(originRepo.remote),
      remote_url: firstNonEmptyString(originRepo.remote_url),
    }),
    source: prune({
      system: firstNonEmptyString(originSource.system),
      kind: firstNonEmptyString(originSource.kind),
      id: firstNonEmptyString(originSource.id),
      title: firstNonEmptyString(originSource.title),
      url: firstNonEmptyString(originSource.url),
    }),
    pull_request: {
      title,
      body_markdown:
        firstNonEmptyText(prBodyProjection.markdown) ?? `# ${title}\n`,
      is_draft: true,
    },
    engineering_summary_markdown:
      firstNonEmptyText(summaryProjection.markdown) ?? "",
    checks: Object.keys(check).length > 0 ? check : undefined,
    governance: prune({
      status: firstNonEmptyString(
        completionState?.status,
        statusSnapshot?.status,
      ),
      review_verdict: reviewVerdict,
      blocking_count: numberOrUndefined(completionResult.blocking_count),
      non_blocking_count: numberOrUndefined(
        completionResult.non_blocking_count,
      ),
      sync_status: syncStatus,
      sync_reasons: stringArray(sync.reasons),
      spec_path: specPath,
      review_file: reviewFile,
      review_round: numberOrUndefined(completionResult.review_round),
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
      spec_path: specPath,
      review_file: reviewFile,
      push_ready: pushReady,
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

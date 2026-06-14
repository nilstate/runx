import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizePublicMarkdown } from "../public_markdown.mjs";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function optionalRecord(value) {
  return isRecord(value) ? value : undefined;
}

export function prune(value) {
  if (Array.isArray(value)) {
    const items = value.map((entry) => prune(entry)).filter((entry) => entry !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!isRecord(value)) {
    return value === undefined ? undefined : value;
  }
  const entries = Object.entries(value)
    .map(([key, nested]) => [key, prune(nested)])
    .filter(([, nested]) => nested !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function parseGitHubIssueRef(...values) {
  for (const value of values) {
    const text = firstNonEmptyString(value);
    if (!text) {
      continue;
    }
    const httpsMatch = text.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/i);
    if (httpsMatch) {
      return buildGitHubIssueRef(httpsMatch[1], httpsMatch[2]);
    }
    const locatorMatch = text.match(/^github:\/\/([^/]+\/[^/]+)\/issues\/(\d+)$/i);
    if (locatorMatch) {
      return buildGitHubIssueRef(locatorMatch[1], locatorMatch[2]);
    }
    const adapterMatch = text.match(/^([^/]+\/[^/]+)#issue\/(\d+)$/i);
    if (adapterMatch) {
      return buildGitHubIssueRef(adapterMatch[1], adapterMatch[2]);
    }
    const shortMatch = text.match(/^([^/]+\/[^/]+)#(\d+)$/i);
    if (shortMatch) {
      return buildGitHubIssueRef(shortMatch[1], shortMatch[2]);
    }
  }
  throw new Error("unable to resolve a GitHub issue reference from thread.adapter.adapter_ref, thread_locator, or canonical_uri.");
}

export function markdownReferencesGitHubIssue(bodyMarkdown, issueRef) {
  const body = firstNonEmptyText(bodyMarkdown);
  if (!body) {
    return false;
  }
  const expected = normalizeGitHubIssueRef(issueRef);
  for (const reference of findGitHubIssueRefs(body)) {
    if (
      reference.repo_slug.toLowerCase() === expected.repo_slug.toLowerCase()
      && reference.issue_number === expected.issue_number
    ) {
      return true;
    }
  }
  return false;
}

export function findGitHubIssueRefs(value) {
  const text = firstNonEmptyText(value);
  if (!text) {
    return [];
  }
  const refs = [];
  const seen = new Set();
  const patterns = [
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?(?=$|[\s)\].,;:"'<>#?])/gi,
    /github:\/\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?(?=$|[\s)\].,;:"'<>#?])/gi,
    /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#issue\/(\d+)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const ref = buildGitHubIssueRef(match[1], match[2]);
      const key = `${ref.repo_slug.toLowerCase()}#${ref.issue_number}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

export function buildGitHubIssueRef(repoSlug, issueNumber) {
  const normalizedRepo = firstNonEmptyString(repoSlug);
  const normalizedIssue = firstNonEmptyString(issueNumber);
  if (!normalizedRepo || !normalizedIssue) {
    throw new Error("repo slug and issue number are required.");
  }
  return {
    repo_slug: normalizedRepo,
    issue_number: normalizedIssue,
    adapter_ref: `${normalizedRepo}#issue/${normalizedIssue}`,
    thread_locator: `github://${normalizedRepo}/issues/${normalizedIssue}`,
    issue_url: `https://github.com/${normalizedRepo}/issues/${normalizedIssue}`,
  };
}

function normalizeGitHubIssueRef(issueRef) {
  if (isRecord(issueRef) && issueRef.repo_slug && issueRef.issue_number) {
    return buildGitHubIssueRef(issueRef.repo_slug, issueRef.issue_number);
  }
  return parseGitHubIssueRef(issueRef);
}

export function ensureGitHubIssueReference(bodyMarkdown, issueRef) {
  const body = firstNonEmptyText(bodyMarkdown) ?? "";
  const marker = gitHubIssueReferenceMarker(issueRef);
  if (body.includes(marker) || markdownReferencesGitHubIssue(body, issueRef)) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${marker}\n` : `${marker}\n`;
}

export function gitHubIssueReferenceMarker(issueRef) {
  return `Source issue: ${issueRef.issue_url}`;
}

export function gitHubIssueSearchQuery(issueRef) {
  const normalized = normalizeGitHubIssueRef(issueRef);
  return `"${normalized.issue_url}" in:body`;
}

export function gitHubOutboxEntryMarker(entryId) {
  const normalized = firstNonEmptyString(entryId);
  if (!normalized) {
    throw new Error("outbox entry id is required.");
  }
  return `<!-- runx-outbox-entry: ${normalized} -->`;
}

export function gitHubOutboxEnvelopeMarker() {
  return "<!-- runx-outbox-envelope: v1 -->";
}

export function gitHubOutboxMetadataMarker(metadata) {
  const persisted = normalizeGitHubPersistedOutboxMetadata(metadata);
  if (!persisted) {
    return undefined;
  }
  const encoded = Buffer.from(JSON.stringify(persisted), "utf8").toString("base64url");
  return `<!-- runx-outbox-metadata: ${encoded} -->`;
}

export function parseGitHubOutboxEntryMarker(value) {
  return parseGitHubOutboxEnvelope(value)?.entry_id;
}

export function ensureGitHubOutboxEntryMarker(bodyMarkdown, entryId) {
  const body = stripTrailingGitHubOutboxEnvelope(firstNonEmptyText(bodyMarkdown) ?? "", {
    requireReceipt: false,
  }) ?? "";
  const marker = gitHubOutboxEntryMarker(entryId);
  const envelope = [
    gitHubOutboxEnvelopeMarker(),
    marker,
  ].join("\n");
  const trimmed = body.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${envelope}\n` : `${envelope}\n`;
}

export function parseGitHubOutboxMetadataMarker(value) {
  return parseGitHubOutboxEnvelope(value)?.metadata;
}

export function ensureGitHubOutboxMetadataMarker(bodyMarkdown, metadata) {
  const parsedEnvelope = parseGitHubOutboxEnvelope(bodyMarkdown);
  const marker = gitHubOutboxMetadataMarker(metadata);
  const body = stripTrailingGitHubOutboxEnvelope(firstNonEmptyText(bodyMarkdown) ?? "", {
    requireReceipt: false,
  }) ?? "";
  const envelope = [
    gitHubOutboxEnvelopeMarker(),
    parsedEnvelope?.entry_id ? gitHubOutboxEntryMarker(parsedEnvelope.entry_id) : undefined,
    marker,
  ].filter(Boolean).join("\n");
  if (!envelope) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${envelope}\n` : `${envelope}\n`;
}

export function stripGitHubOutboxEntryMarker(value) {
  return stripTrailingGitHubOutboxEnvelope(value, { requireReceipt: false });
}

export function parseGitHubOutboxEnvelope(value) {
  const text = firstNonEmptyText(value);
  if (!text) {
    return undefined;
  }
  const marker = gitHubOutboxEnvelopeMarker();
  const start = text.lastIndexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const envelopeText = text.slice(start).trim();
  const parsed = parseGitHubOutboxEnvelopeBlock(envelopeText);
  return parsed
    ? {
        ...parsed,
        start,
        end: text.length,
      }
    : undefined;
}

function stripTrailingGitHubOutboxEnvelope(value, options = {}) {
  const text = firstNonEmptyText(value);
  if (!text) {
    return undefined;
  }
  const envelope = parseGitHubOutboxEnvelope(text);
  const shouldStrip = envelope && (!options.requireReceipt || gitHubOutboxEnvelopeHasReceipt(envelope));
  const stripped = shouldStrip ? text.slice(0, envelope.start) : text;
  const normalized = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseGitHubOutboxEnvelopeBlock(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines[0] !== gitHubOutboxEnvelopeMarker()) {
    return undefined;
  }
  let entryId;
  let metadata;
  for (const line of lines.slice(1)) {
    const entryMatch = line.match(/^<!--\s*runx-outbox-entry:\s*([^>\n]+?)\s*-->$/i);
    if (entryMatch) {
      entryId = firstNonEmptyString(entryMatch[1]);
      continue;
    }
    const metadataMatch = line.match(/^<!--\s*runx-outbox-metadata:\s*([^>\n]+?)\s*-->$/i);
    if (metadataMatch) {
      metadata = parseGitHubOutboxMetadataValue(metadataMatch[1]);
      continue;
    }
    return undefined;
  }
  if (!entryId && !metadata) {
    return undefined;
  }
  return prune({
    entry_id: entryId,
    metadata,
  });
}

function parseGitHubOutboxMetadataValue(value) {
  const encoded = firstNonEmptyString(value);
  if (!encoded) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function gitHubOutboxEnvelopeHasReceipt(envelope) {
  const metadata = optionalRecord(envelope?.metadata);
  return Boolean(envelope?.entry_id && firstNonEmptyString(metadata?.outbox_receipt_id));
}

export function parseGitHubPullRequestNumber(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  const urlMatch = text.match(/\/pull\/(\d+)(?:\/)?$/);
  if (urlMatch) {
    return urlMatch[1];
  }
  const numberMatch = text.match(/^pr-(\d+)$/i);
  if (numberMatch) {
    return numberMatch[1];
  }
  if (/^\d+$/.test(text)) {
    return text;
  }
  return undefined;
}

export function mapGitHubPullRequestStatus(pullRequest) {
  if (firstNonEmptyString(pullRequest.mergedAt)) {
    return "closed";
  }
  if (pullRequest.state && String(pullRequest.state).toUpperCase() !== "OPEN") {
    return "closed";
  }
  if (pullRequest.isDraft === true) {
    return "draft";
  }
  return "published";
}

export function mapGitHubPullRequestToOutboxEntry(pullRequest, threadLocator) {
  const number = firstNonEmptyString(pullRequest.number);
  if (!number) {
    throw new Error("GitHub pull request number is required.");
  }
  return prune({
    entry_id: `pr-${number}`,
    kind: "pull_request",
    locator: firstNonEmptyString(pullRequest.url),
    title: firstNonEmptyString(pullRequest.title),
    status: mapGitHubPullRequestStatus(pullRequest),
    thread_locator: threadLocator,
    metadata: prune({
      schema_version: "runx.outbox-entry.pull-request.v1",
      action: "refresh",
      repo: firstNonEmptyString(
        pullRequest.repo,
        optionalRecord(pullRequest.headRepositoryOwner)?.login && pullRequest.headRefName
          ? `${optionalRecord(pullRequest.headRepositoryOwner)?.login}/${pullRequest.headRefName}`
          : undefined,
      ),
      number,
      branch: firstNonEmptyString(pullRequest.headRefName),
      base: firstNonEmptyString(pullRequest.baseRefName),
      state: firstNonEmptyString(pullRequest.state),
      is_draft: pullRequest.isDraft === true,
      merged_at: firstNonEmptyString(pullRequest.mergedAt),
      provider_outcome: firstNonEmptyString(pullRequest.mergedAt)
        ? "merged"
        : String(pullRequest.state ?? "").toUpperCase() === "CLOSED"
          ? "closed"
          : undefined,
      updated_at: firstNonEmptyString(pullRequest.updatedAt),
      merged_at: firstNonEmptyString(pullRequest.mergedAt, pullRequest.merged_at),
    }),
  });
}

export function selectPreferredGitHubPullRequest(pullRequests, preferredBranch) {
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
    return undefined;
  }
  return [...pullRequests]
    .filter(isRecord)
    .sort((left, right) => {
      const branchScore = gitHubPullRequestBranchScore(right, preferredBranch) - gitHubPullRequestBranchScore(left, preferredBranch);
      if (branchScore !== 0) {
        return branchScore;
      }
      const stateScore = gitHubPullRequestStateRank(left) - gitHubPullRequestStateRank(right);
      if (stateScore !== 0) {
        return stateScore;
      }
      return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    })[0];
}

export function hydrateGitHubIssueThread({ adapterRef, issue, pullRequests }) {
  const issueRef = parseGitHubIssueRef(adapterRef, issue?.url);
  const issueRecord = asRecord(issue, "issue");
  const comments = Array.isArray(issueRecord.comments) ? issueRecord.comments.filter(isRecord) : [];
  const normalizedPullRequests = dedupeGitHubPullRequests(pullRequests).map((pullRequest) => ({
    ...pullRequest,
    repo: issueRef.repo_slug,
  }));
  const entries = [];
  const messageOutbox = [];
  const createdAt = firstNonEmptyString(issueRecord.createdAt) ?? new Date().toISOString();
  const updatedAt = firstNonEmptyString(issueRecord.updatedAt, createdAt);
  const issueBody = stripGitHubOutboxEntryMarker(firstNonEmptyText(issueRecord.body));

  if (issueBody) {
    entries.push(prune({
      entry_id: `issue-${issueRef.issue_number}`,
      entry_kind: "message",
      recorded_at: createdAt,
      actor: normalizeGitHubActor(issueRecord.author),
      body: issueBody,
      source_ref: {
        type: "github_issue",
        uri: issueRef.issue_url,
        recorded_at: createdAt,
      },
      labels: normalizeLabelNames(issueRecord.labels),
    }));
  }

  for (const comment of comments) {
    const commentId = firstNonEmptyString(
      comment.databaseId,
      parseGitHubIssueCommentId(comment.url),
      comment.id,
      `${entries.length + 1}`,
    );
    const recordedAt = firstNonEmptyString(comment.createdAt, comment.updatedAt, updatedAt) ?? updatedAt;
    const outboxEnvelope = parseGitHubOutboxEnvelope(comment.body);
    const outboxEntryId = gitHubOutboxEnvelopeHasReceipt(outboxEnvelope)
      ? outboxEnvelope.entry_id
      : undefined;
    const commentBody = stripGitHubOutboxEntryMarker(firstNonEmptyText(comment.body));
    entries.push(prune({
      entry_id: `comment-${commentId}`,
      entry_kind: "message",
      recorded_at: recordedAt,
      actor: normalizeGitHubActor(comment.author),
      body: commentBody,
      source_ref: prune({
        type: "github_issue_comment",
        uri: firstNonEmptyString(comment.url, issueRef.issue_url),
        recorded_at: recordedAt,
      }),
    }));
    if (outboxEntryId) {
      messageOutbox.push(mapGitHubCommentToOutboxEntry(
        comment,
        issueRef.thread_locator,
        outboxEntryId,
      ));
    }
  }

  const sourceRefs = [
    prune({
      type: "provider_thread",
      uri: issueRef.issue_url,
      recorded_at: updatedAt,
    }),
    ...normalizedPullRequests.map((pullRequest) =>
      prune({
        type: "provider_pull_request",
        uri: firstNonEmptyString(pullRequest.url),
        recorded_at: firstNonEmptyString(pullRequest.updatedAt),
      })),
  ].filter(Boolean);

  return prune({
    kind: "runx.thread.v1",
    adapter: {
      type: "github",
      provider: "github",
      surface: "issue_thread",
      adapter_ref: issueRef.adapter_ref,
      cursor: buildGitHubIssueCursor(issueRecord, comments, normalizedPullRequests),
    },
    thread_kind: "signal",
    thread_locator: issueRef.thread_locator,
    title: firstNonEmptyString(issueRecord.title),
    canonical_uri: issueRef.issue_url,
    metadata: prune({
      repo: issueRef.repo_slug,
      issue_number: issueRef.issue_number,
      state: firstNonEmptyString(issueRecord.state),
    }),
    entries,
    decisions: [],
    outbox: [
      ...messageOutbox,
      ...normalizedPullRequests.map((pullRequest) =>
        mapGitHubPullRequestToOutboxEntry(pullRequest, issueRef.thread_locator)),
    ],
    source_refs: sourceRefs,
    generated_at: new Date().toISOString(),
    watermark: firstNonEmptyString(
      normalizedPullRequests.at(-1)?.updatedAt,
      comments.at(-1)?.updatedAt,
      comments.at(-1)?.createdAt,
      issueRecord.updatedAt,
      issueRecord.createdAt,
    ),
  });
}

export function fetchGitHubIssueThread({ adapterRef, env, cwd }) {
  const issueRef = parseGitHubIssueRef(adapterRef);
  const issue = runGhJson([
    "issue",
    "view",
    issueRef.issue_number,
    "--repo",
    issueRef.repo_slug,
    "--comments",
    "--json",
    "author,body,closedByPullRequestsReferences,comments,createdAt,labels,number,state,title,updatedAt,url",
  ], { env, cwd }, { tokenFallback: true });
  const pullRequests = dedupeGitHubPullRequests([
    ...normalizeGitHubPullRequestArray(issue.closedByPullRequestsReferences),
    ...normalizeGitHubPullRequestArray(runGhJson([
      "pr",
      "list",
      "--repo",
      issueRef.repo_slug,
      "--state",
      "all",
      "--search",
      gitHubIssueSearchQuery(issueRef),
      "--json",
      "baseRefName,headRefName,isDraft,mergedAt,number,state,title,updatedAt,url",
    ], { env, cwd }, { tokenFallback: true })),
  ]);
  return hydrateGitHubIssueThread({
    adapterRef: issueRef.adapter_ref,
    issue,
    pullRequests,
  });
}

export function pushGitHubPullRequest({
  thread,
  draftPullRequest,
  outboxEntry,
  workspacePath,
  nextStatus,
  env,
}) {
  const state = asRecord(thread, "thread");
  const draft = asRecord(draftPullRequest, "draft_pull_request");
  const outbox = asRecord(outboxEntry, "outbox_entry");
  const issueRef = parseGitHubIssueRef(
    optionalRecord(state.adapter)?.adapter_ref,
    state.canonical_uri,
    state.thread_locator,
  );
  const target = asRecord(draft.target, "draft_pull_request.target");
  const pullRequest = asRecord(draft.pull_request, "draft_pull_request.pull_request");
  const repoSlug = firstNonEmptyString(target.repo, issueRef.repo_slug);
  const branch = firstNonEmptyString(target.branch);
  const base = firstNonEmptyString(target.base);
  const remote = firstNonEmptyString(target.remote, "origin");
  const title = firstNonEmptyString(pullRequest.title, outbox.title, state.title);
  const commitMessage = buildGitHubCommitMessage(draft, title, outbox);

  if (!workspacePath) {
    throw new Error("workspace_path is required to push a GitHub pull request.");
  }
  if (!repoSlug) {
    throw new Error("draft_pull_request.target.repo is required for GitHub push.");
  }
  if (!branch) {
    throw new Error("draft_pull_request.target.branch is required for GitHub push.");
  }
  if (!title) {
    throw new Error("draft_pull_request.pull_request.title is required for GitHub push.");
  }

  const body = ensureGitHubIssueReference(
    sanitizePublicMarkdown(firstNonEmptyText(pullRequest.body_markdown, `# ${title}\n`)),
    issueRef,
  );

  assertWorkspaceOnBranch({
    workspacePath,
    expectedBranch: branch,
    env,
  });

  commitGovernedWorkspaceChanges({
    workspacePath,
    env,
    draft,
    outbox,
    commitMessage,
  });

  pushGitHubBranch({
    workspacePath,
    remote,
    branch,
    env,
  });

  const existingNumber = parseGitHubPullRequestNumber(outbox.locator)
    ?? parseGitHubPullRequestNumber(optionalRecord(outbox.metadata)?.number);
  const existingByBranch = existingNumber
    ? undefined
    : findGitHubPullRequestByHead(repoSlug, branch, workspacePath, env, { state: "open" });
  let pullRequestRef = existingNumber;
  if (!pullRequestRef && existingByBranch) {
    pullRequestRef = firstNonEmptyString(existingByBranch.url, existingByBranch.number);
  }

  if (pullRequestRef) {
    editGitHubPullRequest({
      repoSlug,
      pullRequestRef,
      title,
      body,
      base,
      workspacePath,
      env,
    });
  } else {
    try {
      pullRequestRef = runGitHubPullRequestCreate({
        repoSlug,
        branch,
        base,
        title,
        body,
        workspacePath,
        env,
      });
    } catch (error) {
      const fallback = findGitHubPullRequestByHead(repoSlug, branch, workspacePath, env, { state: "open" });
      if (!fallback) {
        throw error;
      }
      pullRequestRef = firstNonEmptyString(fallback.url, fallback.number);
    }
  }

  const pullRequestView = runGhJson([
    "pr",
    "view",
    pullRequestRef,
    "--repo",
    repoSlug,
    "--json",
    "baseRefName,headRefName,isDraft,mergedAt,number,state,title,updatedAt,url",
  ], {
    cwd: workspacePath,
    env,
  }, { tokenFallback: true });
  const refreshedEntry = mapGitHubPullRequestToOutboxEntry(
    {
      ...pullRequestView,
      repo: repoSlug,
    },
    firstNonEmptyString(state.thread_locator, issueRef.thread_locator),
  );
  return {
    outbox_entry: prune({
      ...refreshedEntry,
      status: firstNonEmptyString(nextStatus, refreshedEntry.status),
      metadata: prune({
        ...optionalRecord(refreshedEntry.metadata),
        action: firstNonEmptyString(draft.action, "refresh"),
        pushed_at: new Date().toISOString(),
      }),
    }),
    pull_request: pullRequestView,
  };
}

function assertWorkspaceOnBranch({ workspacePath, expectedBranch, env }) {
  const currentBranch = runCommand("git", ["branch", "--show-current"], {
    cwd: workspacePath,
    env,
  }).trim();
  if (!currentBranch) {
    throw new Error(`GitHub PR publication requires workspace to be on branch '${expectedBranch}', but the checkout is detached or unknown.`);
  }
  if (currentBranch !== expectedBranch) {
    throw new Error(`GitHub PR publication target branch '${expectedBranch}' does not match workspace branch '${currentBranch}'. Check out the target branch before pushing.`);
  }
}

export function pushGitHubMessage({
  thread,
  outboxEntry,
  workspacePath,
  nextStatus,
  env,
}) {
  const state = asRecord(thread, "thread");
  const outbox = asRecord(outboxEntry, "outbox_entry");
  const metadata = optionalRecord(outbox.metadata) ?? {};
  const issueRef = parseGitHubIssueRef(
    optionalRecord(state.adapter)?.adapter_ref,
    state.canonical_uri,
    state.thread_locator,
  );
  const existingEntry = selectExistingGitHubMessageOutboxEntry(state, outbox);
  const existingMetadata = optionalRecord(existingEntry?.metadata) ?? {};
  const outboxReceiptId = firstNonEmptyString(
    metadata.outbox_receipt_id,
    existingMetadata.outbox_receipt_id,
    randomUUID(),
  );
  const repoSlug = firstNonEmptyString(optionalRecord(state.metadata)?.repo, issueRef.repo_slug);
  const bodyMarkdown = sanitizePublicMarkdown(firstNonEmptyText(metadata.body_markdown, metadata.body));
  const commentId = firstNonEmptyString(
    parseGitHubIssueCommentId(outbox.locator),
    normalizeGitHubIssueCommentId(metadata.comment_id),
    normalizeGitHubIssueCommentId(optionalRecord(metadata.message)?.comment_id),
    normalizeGitHubIssueCommentId(optionalRecord(metadata.comment)?.id),
    normalizeGitHubIssueCommentId(optionalRecord(metadata.comment)?.database_id),
    parseGitHubIssueCommentId(existingEntry?.locator),
    normalizeGitHubIssueCommentId(existingMetadata.comment_id),
  );
  const locator = firstNonEmptyString(
    outbox.locator,
    existingEntry?.locator,
    commentId ? `${issueRef.issue_url}#issuecomment-${commentId}` : undefined,
  );
  const commentBody = ensureGitHubOutboxEntryMarker(bodyMarkdown, outbox.entry_id);
  const shouldPublish = !commentId;

  if (!repoSlug) {
    throw new Error("GitHub issue repo slug is required to push a message outbox entry.");
  }
  if (!bodyMarkdown) {
    throw new Error("outbox_entry.metadata.body_markdown is required for GitHub message push.");
  }

  const commentMetadata = normalizeGitHubPersistedOutboxMetadata({
    ...metadata,
    outbox_receipt_id: outboxReceiptId,
  });
  const commentBodyWithMetadata = ensureGitHubOutboxMetadataMarker(commentBody, commentMetadata);
  if (shouldPublish) {
    runGhCommand([
      "issue",
      "comment",
      issueRef.issue_number,
      "--repo",
      repoSlug,
      "--body",
      commentBodyWithMetadata,
    ], {
      cwd: workspacePath ?? process.cwd(),
      env,
    }, { tokenFallback: true });
  } else {
    runGhCommand([
      "api",
      `repos/${repoSlug}/issues/comments/${commentId}`,
      "--method",
      "PATCH",
      "-f",
      `body=${commentBodyWithMetadata}`,
    ], {
      cwd: workspacePath ?? process.cwd(),
      env,
    }, { tokenFallback: true });
  }

  return {
    outbox_entry: prune({
      ...outbox,
      status: firstNonEmptyString(nextStatus, "published", outbox.status),
      locator,
      thread_locator: firstNonEmptyString(outbox.thread_locator, state.thread_locator, issueRef.thread_locator),
      metadata: prune({
        ...metadata,
        schema_version: firstNonEmptyString(metadata.schema_version, "runx.outbox-entry.message.v1"),
        channel: firstNonEmptyString(metadata.channel, "github_issue_comment"),
        body_markdown: bodyMarkdown,
        comment_id: commentId,
        outbox_receipt_id: outboxReceiptId,
        pushed_at: new Date().toISOString(),
      }),
    }),
    message: prune({
      locator,
      comment_id: commentId,
    }),
  };
}

export function pushGitHubCreateIssue({
  thread,
  outboxEntry,
  workspacePath,
  nextStatus,
  env,
}) {
  const state = asRecord(thread, "thread");
  const outbox = asRecord(outboxEntry, "outbox_entry");
  const metadata = optionalRecord(outbox.metadata) ?? {};
  const repoSlug = firstNonEmptyString(metadata.target_repo, optionalRecord(state.metadata)?.repo);
  const title = firstNonEmptyString(metadata.title, outbox.title, state.title);
  const bodyMarkdown = sanitizePublicMarkdown(firstNonEmptyText(metadata.body_markdown, metadata.body));
  const labels = stringList(metadata.labels);
  const cwd = workspacePath ?? process.cwd();

  if (!repoSlug) {
    throw new Error("provider_thread_create requires outbox_entry.metadata.target_repo.");
  }
  if (!title) {
    throw new Error("provider_thread_create requires outbox_entry.metadata.title.");
  }
  if (!bodyMarkdown) {
    throw new Error("provider_thread_create requires outbox_entry.metadata.body_markdown.");
  }

  const issueBody = ensureGitHubOutboxMetadataMarker(
    ensureGitHubOutboxEntryMarker(bodyMarkdown, outbox.entry_id),
    normalizeGitHubPersistedOutboxMetadata({
      ...metadata,
      outbox_receipt_id: firstNonEmptyString(metadata.outbox_receipt_id, outbox.entry_id),
    }),
  );
  const existingIssue = findGitHubIssueByOutboxEntry({
    repoSlug,
    entryId: outbox.entry_id,
    cwd,
    env,
  });

  let issueRef;
  let existingLabels = [];
  let created = false;
  if (existingIssue) {
    issueRef = buildGitHubIssueRef(repoSlug, existingIssue.number);
    existingLabels = normalizeLabelNames(existingIssue.labels) ?? [];
    runGhCommand([
      "issue",
      "edit",
      issueRef.issue_number,
      "--repo",
      repoSlug,
      "--title",
      title,
      "--body",
      issueBody,
    ], {
      cwd,
      env,
    }, { tokenFallback: true });
  } else {
    const issueUrl = runGhCommand([
      "issue",
      "create",
      "--repo",
      repoSlug,
      "--title",
      title,
      "--body",
      issueBody,
    ], {
      cwd,
      env,
    }, { tokenFallback: true }).trim();
    issueRef = parseGitHubIssueRef(issueUrl);
    created = true;
  }

  const labelResult = applyGitHubLabelChanges({
    repoSlug,
    issueNumber: issueRef.issue_number,
    addLabels: labels,
    removeLabels: [],
    existingLabels,
    cwd,
    env,
  });

  return {
    outbox_entry: prune({
      ...outbox,
      status: firstNonEmptyString(nextStatus, "published", outbox.status),
      locator: firstNonEmptyString(outbox.locator, issueRef.issue_url),
      thread_locator: issueRef.thread_locator,
      metadata: prune({
        ...metadata,
        schema_version: firstNonEmptyString(
          metadata.schema_version,
          "runx.outbox-entry.provider-thread-create.v1",
        ),
        channel: firstNonEmptyString(metadata.channel, "github_issue"),
        provider_thread_id: issueRef.issue_number,
        provider_thread_url: issueRef.issue_url,
        created,
        pushed_at: new Date().toISOString(),
      }),
    }),
    provider_thread: prune({
      locator: issueRef.issue_url,
      thread_locator: issueRef.thread_locator,
      issue_number: issueRef.issue_number,
      created,
      added_labels: labelResult.addedLabels,
    }),
  };
}

export function pushGitHubLifecycleIntent({
  thread,
  outboxEntry,
  workspacePath,
  nextStatus,
  env,
}) {
  const state = asRecord(thread, "thread");
  const outbox = asRecord(outboxEntry, "outbox_entry");
  const metadata = optionalRecord(outbox.metadata) ?? {};
  const issueRef = parseGitHubIssueRef(
    optionalRecord(state.adapter)?.adapter_ref,
    state.canonical_uri,
    state.thread_locator,
  );
  const repoSlug = firstNonEmptyString(optionalRecord(state.metadata)?.repo, issueRef.repo_slug);
  const cwd = workspacePath ?? process.cwd();
  const issueState = getGitHubIssueState({
    repoSlug,
    issueNumber: issueRef.issue_number,
    cwd,
    env,
  });
  const addLabels = stringList(metadata.add_labels);
  const removeLabels = stringList(metadata.remove_labels);
  const closeReason = firstNonEmptyString(metadata.close_reason, "completed");

  if (!repoSlug) {
    throw new Error("GitHub issue repo slug is required to push a provider thread lifecycle entry.");
  }
  if (addLabels.length === 0 && removeLabels.length === 0 && metadata.action !== "close") {
    throw new Error("provider_thread_lifecycle requires label changes or a close action.");
  }

  const labelResult = applyGitHubLabelChanges({
    repoSlug,
    issueNumber: issueRef.issue_number,
    addLabels,
    removeLabels,
    existingLabels: stringList(issueState.labels),
    cwd,
    env,
  });

  const shouldClose = firstNonEmptyString(metadata.action) === "close";
  if (shouldClose && String(issueState.state ?? "").toUpperCase() !== "CLOSED") {
    runGhCommand([
      "issue",
      "close",
      issueRef.issue_number,
      "--repo",
      repoSlug,
      "--reason",
      closeReason === "not_planned" ? "not planned" : "completed",
    ], {
      cwd,
      env,
    }, { tokenFallback: true });
  }

  return {
    outbox_entry: prune({
      ...outbox,
      status: firstNonEmptyString(nextStatus, "published", outbox.status),
      locator: firstNonEmptyString(outbox.locator, issueRef.issue_url),
      thread_locator: firstNonEmptyString(outbox.thread_locator, state.thread_locator, issueRef.thread_locator),
      metadata: prune({
        ...metadata,
        schema_version: firstNonEmptyString(
          metadata.schema_version,
          "runx.outbox-entry.provider-thread-lifecycle.v1",
        ),
        channel: firstNonEmptyString(metadata.channel, "github_issue"),
        pushed_at: new Date().toISOString(),
      }),
    }),
    lifecycle: prune({
      locator: issueRef.issue_url,
      added_labels: labelResult.addedLabels,
      removed_labels: labelResult.removedLabels,
      closed: shouldClose,
      close_reason: shouldClose ? closeReason : undefined,
    }),
  };
}

function findGitHubIssueByOutboxEntry({ repoSlug, entryId, cwd, env }) {
  const normalizedEntryId = firstNonEmptyString(entryId);
  if (!normalizedEntryId) {
    throw new Error("outbox entry id is required to find an existing GitHub issue.");
  }
  const issues = runGhJson([
    "issue",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "all",
    "--search",
    `"${normalizedEntryId}" in:body`,
    "--json",
    "labels,number,state,title,url",
  ], {
    cwd,
    env,
  }, { tokenFallback: true });
  return Array.isArray(issues) ? issues.find(isRecord) : undefined;
}

function applyGitHubLabelChanges({
  repoSlug,
  issueNumber,
  addLabels,
  removeLabels,
  existingLabels,
  cwd,
  env,
}) {
  const labels = new Set(stringList(existingLabels));
  const addedLabels = [];
  const removedLabels = [];

  for (const label of addLabels) {
    ensureGitHubLabel({
      repoSlug,
      label,
      cwd,
      env,
    });
    if (labels.has(label)) {
      continue;
    }
    runGhCommand([
      "issue",
      "edit",
      issueNumber,
      "--repo",
      repoSlug,
      "--add-label",
      label,
    ], {
      cwd,
      env,
    }, { tokenFallback: true });
    labels.add(label);
    addedLabels.push(label);
  }

  for (const label of removeLabels) {
    if (!labels.has(label)) {
      continue;
    }
    runGhCommand([
      "issue",
      "edit",
      issueNumber,
      "--repo",
      repoSlug,
      "--remove-label",
      label,
    ], {
      cwd,
      env,
    }, { tokenFallback: true });
    labels.delete(label);
    removedLabels.push(label);
  }

  return { addedLabels, removedLabels };
}

function selectExistingGitHubMessageOutboxEntry(thread, outboxEntry) {
  const existingOutbox = Array.isArray(thread.outbox) ? thread.outbox.filter(isRecord) : [];
  const requestedMetadata = optionalRecord(outboxEntry.metadata) ?? {};
  const requestedReceiptId = firstNonEmptyString(requestedMetadata.outbox_receipt_id);
  const matches = existingOutbox
    .filter((entry) => firstNonEmptyString(entry.kind) === "message")
    .filter((entry) => {
      const sameLocator =
        firstNonEmptyString(outboxEntry.locator) &&
        firstNonEmptyString(entry.locator) === firstNonEmptyString(outboxEntry.locator);
      if (sameLocator) {
        return true;
      }
      const candidateReceiptId = firstNonEmptyString(optionalRecord(entry.metadata)?.outbox_receipt_id);
      const sameEntryId =
        requestedReceiptId &&
        candidateReceiptId === requestedReceiptId &&
        firstNonEmptyString(outboxEntry.entry_id) &&
        firstNonEmptyString(entry.entry_id) === firstNonEmptyString(outboxEntry.entry_id);
      return Boolean(sameEntryId);
    });

  return matches
    .slice()
    .sort((left, right) => {
      const leftScore = gitHubMessageOutboxMatchScore(left, outboxEntry);
      const rightScore = gitHubMessageOutboxMatchScore(right, outboxEntry);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      const leftCommentId = Number.parseInt(firstNonEmptyString(
        optionalRecord(left.metadata)?.comment_id,
        parseGitHubIssueCommentId(left.locator),
      ) ?? "", 10);
      const rightCommentId = Number.parseInt(firstNonEmptyString(
        optionalRecord(right.metadata)?.comment_id,
        parseGitHubIssueCommentId(right.locator),
      ) ?? "", 10);
      if (Number.isFinite(leftCommentId) && Number.isFinite(rightCommentId) && leftCommentId !== rightCommentId) {
        return leftCommentId - rightCommentId;
      }
      const leftUpdated = firstNonEmptyString(
        optionalRecord(left.metadata)?.updated_at,
        optionalRecord(left.metadata)?.pushed_at,
        left.locator,
        left.entry_id,
      );
      const rightUpdated = firstNonEmptyString(
        optionalRecord(right.metadata)?.updated_at,
        optionalRecord(right.metadata)?.pushed_at,
        right.locator,
        right.entry_id,
      );
      return String(leftUpdated).localeCompare(String(rightUpdated));
    })[0];
}

function gitHubMessageOutboxMatchScore(candidate, outboxEntry) {
  const candidateLocator = firstNonEmptyString(candidate.locator);
  const requestedLocator = firstNonEmptyString(outboxEntry.locator);
  if (candidateLocator && requestedLocator && candidateLocator === requestedLocator) {
    return 3;
  }
  const candidateEntryId = firstNonEmptyString(candidate.entry_id);
  const requestedEntryId = firstNonEmptyString(outboxEntry.entry_id);
  const candidateReceiptId = firstNonEmptyString(optionalRecord(candidate.metadata)?.outbox_receipt_id);
  const requestedReceiptId = firstNonEmptyString(optionalRecord(outboxEntry.metadata)?.outbox_receipt_id);
  if (
    candidateEntryId &&
    requestedEntryId &&
    candidateEntryId === requestedEntryId &&
    candidateReceiptId &&
    requestedReceiptId &&
    candidateReceiptId === requestedReceiptId
  ) {
    return 2;
  }
  return 1;
}

function getGitHubIssueState({ repoSlug, issueNumber, cwd, env }) {
  const issue = runGhJson([
    "issue",
    "view",
    issueNumber,
    "--repo",
    repoSlug,
    "--json",
    "labels,state,url",
  ], {
    cwd,
    env,
  }, { tokenFallback: true });
  return {
    state: firstNonEmptyString(issue.state, "OPEN"),
    url: firstNonEmptyString(issue.url),
    labels: normalizeLabelNames(issue.labels) ?? [],
  };
}

const knownGitHubLabels = new Set();

function ensureGitHubLabel({ repoSlug, label, cwd, env }) {
  if (!label.startsWith("frantic:")) {
    return;
  }
  const cacheKey = `${repoSlug}:${label}`;
  if (knownGitHubLabels.has(cacheKey)) {
    return;
  }
  const existingLabels = runGhJson([
    "label",
    "list",
    "--repo",
    repoSlug,
    "--search",
    label,
    "--json",
    "name",
  ], {
    cwd,
    env,
  }, { tokenFallback: true });
  if (Array.isArray(existingLabels) && existingLabels.some((entry) => firstNonEmptyString(entry?.name) === label)) {
    knownGitHubLabels.add(cacheKey);
    return;
  }
  runGhCommand([
    "label",
    "create",
    label,
    "--repo",
    repoSlug,
    "--color",
    "0969DA",
    "--description",
    "Frantic lifecycle",
    "--force",
  ], {
    cwd,
    env,
  }, { tokenFallback: true });
  knownGitHubLabels.add(cacheKey);
}

export function resolveGhBinary(env) {
  return firstNonEmptyString(env?.RUNX_GH_BIN, process.env.RUNX_GH_BIN, "gh");
}

function asRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function normalizeGitHubActor(value) {
  const actor = optionalRecord(value);
  const actorId = firstNonEmptyString(actor?.login, actor?.id);
  if (!actorId) {
    return undefined;
  }
  return prune({
    actor_id: actorId,
    display_name: firstNonEmptyString(actor?.name, actorId),
    role: "user",
    provider_identity: firstNonEmptyString(actor?.login, actorId),
  });
}

function normalizeLabelNames(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const labels = value
    .map((entry) => (isRecord(entry) ? firstNonEmptyString(entry.name) : undefined))
    .filter((entry) => entry !== undefined);
  return labels.length > 0 ? labels : undefined;
}

function buildGitHubIssueCursor(issue, comments, pullRequests) {
  const issueRecord = optionalRecord(issue) ?? {};
  const lastComment = [...comments].reverse().find(isRecord);
  const lastPullRequest = [...pullRequests].reverse().find(isRecord);
  return firstNonEmptyString(
    lastPullRequest?.updatedAt && `pr:${lastPullRequest.updatedAt}`,
    firstNonEmptyString(lastComment?.updatedAt, lastComment?.createdAt) && `comment:${firstNonEmptyString(lastComment?.updatedAt, lastComment?.createdAt)}`,
    issueRecord.updatedAt && `issue:${issueRecord.updatedAt}`,
  );
}

function normalizeGitHubPullRequestArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function mapGitHubCommentToOutboxEntry(comment, threadLocator, entryId) {
  const commentRecord = asRecord(comment, "comment");
  const commentId = firstNonEmptyString(
    commentRecord.databaseId,
    parseGitHubIssueCommentId(commentRecord.url),
    commentRecord.id,
  );
  const recordedAt = firstNonEmptyString(commentRecord.updatedAt, commentRecord.createdAt);
  const persistedMetadata = parseGitHubOutboxMetadataMarker(commentRecord.body);
  const body = stripGitHubOutboxEntryMarker(firstNonEmptyText(commentRecord.body));

  return prune({
    entry_id: entryId,
    kind: "message",
    locator: firstNonEmptyString(commentRecord.url),
    status: "published",
    thread_locator: threadLocator,
    metadata: prune({
      ...persistedMetadata,
      schema_version: "runx.outbox-entry.message.v1",
      channel: "github_issue_comment",
      comment_id: commentId,
      author: firstNonEmptyString(optionalRecord(commentRecord.author)?.login),
      body_markdown: body,
      updated_at: recordedAt,
    }),
  });
}

function dedupeGitHubPullRequests(pullRequests) {
  const byKey = new Map();
  const merged = [];
  for (const pullRequest of normalizeGitHubPullRequestArray(pullRequests)) {
    const key = firstNonEmptyString(pullRequest.number, pullRequest.url);
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      mergeGitHubPullRequest(existing, pullRequest);
      continue;
    }
    const copy = { ...pullRequest };
    byKey.set(key, copy);
    merged.push(copy);
  }
  return merged;
}

function mergeGitHubPullRequest(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      continue;
    }
    target[key] = value;
  }
  return target;
}

function gitHubPullRequestBranchScore(pullRequest, preferredBranch) {
  if (!preferredBranch) {
    return 0;
  }
  return firstNonEmptyString(pullRequest.headRefName) === preferredBranch ? 1 : 0;
}

function gitHubPullRequestStateRank(pullRequest) {
  if (String(pullRequest.state ?? "").toUpperCase() !== "OPEN") {
    return 2;
  }
  return pullRequest.isDraft === true ? 0 : 1;
}

function parseGitHubIssueCommentId(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  const match = text.match(/#issuecomment-(\d+)$/i);
  return firstNonEmptyString(match?.[1]);
}

function normalizeGitHubIssueCommentId(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  return /^\d+$/.test(text) ? text : undefined;
}

function normalizeGitHubPersistedOutboxMetadata(value) {
  const metadata = optionalRecord(value);
  if (!metadata) {
    return undefined;
  }
  const {
    body,
    body_markdown,
    comment_id,
    pushed_at,
    updated_at,
    ...rest
  } = metadata;
  void body;
  void body_markdown;
  void comment_id;
  void pushed_at;
  void updated_at;
  return prune(rest);
}

function buildGitHubCommitMessage(draftPullRequest, title, outboxEntry) {
  const reviewedCommitSubject = firstNonEmptyString(
    optionalRecord(draftPullRequest.pull_request)?.commit_subject,
    optionalRecord(outboxEntry.metadata)?.commit_subject,
  );
  if (reviewedCommitSubject) {
    return reviewedCommitSubject;
  }
  const existingTitle = firstNonEmptyString(title);
  if (existingTitle && /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?: /i.test(existingTitle)) {
    return existingTitle;
  }
  return `chore(issue-to-pr): apply ${firstNonEmptyString(draftPullRequest.task_id, existingTitle, "runx-change")}`;
}

function findGitHubPullRequestByHead(repoSlug, branch, workspacePath, env, options = {}) {
  const state = firstNonEmptyString(options.state, "open");
  let pulls;
  try {
    pulls = runGhJson([
      "pr",
      "list",
      "--repo",
      repoSlug,
      "--head",
      branch,
      "--state",
      state,
      "--json",
      "baseRefName,headRefName,isDraft,mergedAt,number,state,title,updatedAt,url",
    ], {
      cwd: workspacePath,
      env,
    }, { tokenFallback: true });
  } catch {
    return undefined;
  }
  const candidates = Array.isArray(pulls) ? pulls.filter(isRecord) : [];
  return candidates
    .filter((pull) =>
      firstNonEmptyString(pull.headRefName) === branch
      && !firstNonEmptyString(pull.mergedAt)
      && (
        state === "all"
        || String(pull.state ?? "").toUpperCase() === String(state).toUpperCase()
      )
    )
    .sort((left, right) => {
      const stateScore = gitHubPullRequestOpenScore(right) - gitHubPullRequestOpenScore(left);
      if (stateScore !== 0) {
        return stateScore;
      }
      return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    })[0];
}

function gitHubPullRequestOpenScore(pullRequest) {
  return String(pullRequest?.state ?? "").toUpperCase() === "OPEN" ? 2 : 1;
}

function editGitHubPullRequest({ repoSlug, pullRequestRef, title, body, base, workspacePath, env }) {
  const number = parseGitHubPullRequestNumber(pullRequestRef);
  if (!number) {
    const args = [
      "pr",
      "edit",
      pullRequestRef,
      "--repo",
      repoSlug,
      "--title",
      title,
      "--body",
      body,
    ];
    if (base) {
      args.push("--base", base);
    }
    runGhCommand(args, {
      cwd: workspacePath,
      env,
    }, { tokenFallback: true });
    return;
  }

  const args = [
    "api",
    `repos/${repoSlug}/pulls/${number}`,
    "--method",
    "PATCH",
    "-f",
    `title=${title}`,
    "-f",
    `body=${body}`,
  ];
  if (base) {
    args.push("-f", `base=${base}`);
  }
  runGhCommand(args, {
    cwd: workspacePath,
    env,
  }, { tokenFallback: true });
}

function runGitHubPullRequestCreate({ repoSlug, branch, base, title, body, workspacePath, env }) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      let restError;
      let restCreated;
      try {
        restCreated = runGitHubPullRequestCreateRest({
          repoSlug,
          branch,
          base,
          title,
          body,
          env,
        });
      } catch (error) {
        restError = error;
      }
      if (restCreated) {
        return restCreated;
      }
      let apiError;
      try {
        return runGitHubPullRequestCreateGh({
          repoSlug,
          branch,
          base,
          title,
          body,
          workspacePath,
          env,
        });
      } catch (error) {
        apiError = error;
      }
      try {
        return runGitHubPullRequestCreateCli({
          repoSlug,
          branch,
          base,
          title,
          body,
          workspacePath,
          env,
        });
      } catch (error) {
        throw new Error([
          error.message,
          "gh api create failed first:",
          apiError.message,
          restError ? `REST create failed first:\n${restError.message}` : undefined,
        ].filter(Boolean).join("\n"));
      }
    } catch (error) {
      lastError = error;
      if (attempt === 3) {
        throw error;
      }
      sleepSync(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

function runGitHubPullRequestCreateRest({ repoSlug, branch, base, title, body, env }) {
  if (firstNonEmptyString(env?.RUNX_GH_BIN)) {
    return undefined;
  }
  const tokens = githubTokenCandidates(env);
  if (tokens.length === 0) {
    return undefined;
  }
  const payload = JSON.stringify(prune({
    title,
    head: branch,
    base,
    body,
    draft: true,
  }));
  const failures = [];
  for (const token of tokens) {
    const result = spawnSync("curl", [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--url",
      `https://api.github.com/repos/${repoSlug}/pulls`,
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      "--header",
      `Authorization: Bearer ${token.value}`,
      "--data-binary",
      "@-",
    ], {
      input: payload,
      env: env ?? process.env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failures.push(`${token.name}: ${result.stderr || result.stdout || "unknown failure"}`);
      continue;
    }
    const parsed = JSON.parse(result.stdout);
    const url = firstNonEmptyString(parsed.html_url, parsed.url);
    if (!url) {
      throw new Error("GitHub pull request create response did not include html_url.");
    }
    return url;
  }
  throw new Error(`command failed: curl GitHub pull request create\n${failures.join("\n")}`);
}

function runGitHubPullRequestCreateGh({ repoSlug, branch, base, title, body, workspacePath, env }) {
  const args = buildGitHubPullRequestCreateArgs({
    repoSlug,
    branch,
    base,
    title,
    body,
  });
  const tokens = githubTokenCandidates(env);
  if (tokens.length === 0) {
    return runCommand(resolveGhBinary(env), args, {
      cwd: workspacePath,
      env,
    }).trim();
  }
  const failures = [];
  for (const token of tokens) {
    const candidateEnv = githubTokenCandidateEnv(env, token.value);
    try {
      return runCommand(resolveGhBinary(candidateEnv), args, {
        cwd: workspacePath,
        env: candidateEnv,
      }).trim();
    } catch (error) {
      failures.push(`${token.name}: ${error.message}`);
    }
  }
  throw new Error(`command failed: gh GitHub pull request create\n${failures.join("\n")}`);
}

function runGitHubPullRequestCreateCli({ repoSlug, branch, base, title, body, workspacePath, env }) {
  const args = [
    "pr",
    "create",
    "--repo",
    repoSlug,
    "--head",
    branch,
    "--title",
    title,
    "--body-file",
    "-",
    "--draft",
  ];
  if (base) {
    args.push("--base", base);
  }
  const tokens = githubTokenCandidates(env);
  if (tokens.length === 0) {
    return runCommand(resolveGhBinary(env), args, {
      cwd: workspacePath,
      env,
      input: body,
    }).trim();
  }
  const failures = [];
  for (const token of tokens) {
    const candidateEnv = githubTokenCandidateEnv(env, token.value);
    try {
      return runCommand(resolveGhBinary(candidateEnv), args, {
        cwd: workspacePath,
        env: candidateEnv,
        input: body,
      }).trim();
    } catch (error) {
      failures.push(`${token.name}: ${error.message}`);
    }
  }
  throw new Error(`command failed: gh pr create\n${failures.join("\n")}`);
}

function githubTokenCandidates(env) {
  const candidates = [
    ["GH_TOKEN", env?.GH_TOKEN],
    ["GITHUB_TOKEN", env?.GITHUB_TOKEN],
    ["RUNX_GITHUB_TOKEN", env?.RUNX_GITHUB_TOKEN],
  ];
  const seen = new Set();
  const tokens = [];
  for (const [name, value] of candidates) {
    const token = firstNonEmptyString(value);
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push({ name, value: token });
  }
  return tokens;
}

function buildGitHubPullRequestCreateArgs({ repoSlug, branch, base, title, body }) {
  const args = [
    "api",
    `repos/${repoSlug}/pulls`,
    "--method",
    "POST",
    "-f",
    `title=${title}`,
    "-f",
    `head=${branch}`,
    "-f",
    `body=${body}`,
    "-F",
    "draft=true",
    "--jq",
    ".html_url",
  ];
  if (base) {
    args.push("-f", `base=${base}`);
  }
  return args;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runGhJson(args, options, runOptions = {}) {
  return JSON.parse(runGhCommand(args, options, runOptions));
}

function runGhCommand(args, options, runOptions = {}) {
  if (runOptions.tokenFallback !== true) {
    return runCommand(resolveGhBinary(options?.env), args, options);
  }
  const tokens = githubTokenCandidates(options?.env);
  if (tokens.length === 0) {
    return runCommand(resolveGhBinary(options?.env), args, options);
  }
  const failures = [];
  for (const token of tokens) {
    const candidateEnv = githubTokenCandidateEnv(options?.env, token.value);
    try {
      return runCommand(resolveGhBinary(candidateEnv), args, {
        ...options,
        env: candidateEnv,
      });
    } catch (error) {
      failures.push(`${token.name}: ${error.message}`);
    }
  }
  throw new Error(`command failed: gh ${args.join(" ")}\n${failures.join("\n")}`);
}

function githubTokenCandidateEnv(env, token) {
  return {
    ...(env ?? process.env),
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

function commitGovernedWorkspaceChanges({ workspacePath, env, draft, outbox, commitMessage }) {
  const dirtyPaths = gitDirtyPaths(workspacePath, env);
  if (dirtyPaths.length === 0) {
    return;
  }

  const governedFiles = governedChangedFiles(draft, outbox);
  if (governedFiles.length === 0) {
    throw new Error(
      "draft_pull_request.governance.changed_files is required before committing dirty workspace changes for GitHub publication.",
    );
  }

  const governed = new Set(governedFiles);
  const blocking = dirtyPaths.filter((filePath) =>
    !governed.has(filePath) && !isIgnoredPublicationDirtyPath(filePath),
  );
  if (blocking.length > 0) {
    throw new Error(
      "dirty workspace contains files outside draft_pull_request.governance.changed_files: " +
      blocking.join(", "),
    );
  }

  const stagedPaths = dirtyPaths.filter((filePath) => governed.has(filePath));
  if (stagedPaths.length === 0) {
    return;
  }
  runCommand("git", ["add", "--", ...stagedPaths], {
    cwd: workspacePath,
    env,
  });
  if (!repoHasStagedChanges(workspacePath, env)) {
    return;
  }
  ensureGitCommitIdentity(workspacePath, env);
  runCommand("git", ["commit", "-m", commitMessage], {
    cwd: workspacePath,
    env,
  });
}

function gitDirtyPaths(workspacePath, env) {
  const output = runCommand("git", ["status", "--porcelain=v1", "-z"], {
    cwd: workspacePath,
    env,
  });
  if (!output) {
    return [];
  }
  const entries = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    paths.push(filePath);
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      index += 1;
    }
  }
  return [...new Set(paths.map(normalizeRepoPath).filter(Boolean))].sort();
}

function governedChangedFiles(draft, outbox) {
  const governance = optionalRecord(draft.governance) ?? {};
  const metadata = optionalRecord(outbox.metadata) ?? {};
  return [
    ...stringList(governance.changed_files),
    ...stringList(draft.changed_files),
    ...stringList(metadata.changed_files),
  ]
    .map(normalizeRepoPath)
    .filter((filePath) => filePath && !filePath.startsWith("../") && !path.posix.isAbsolute(filePath))
    .filter((filePath, index, all) => all.indexOf(filePath) === index)
    .sort();
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => firstNonEmptyString(entry)).filter(Boolean)
    : [];
}

function normalizeRepoPath(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  return path.posix.normalize(text.replace(/\\/g, "/"));
}

function isIgnoredPublicationDirtyPath(filePath) {
  return filePath === ".scafld" || filePath.startsWith(".scafld/");
}

function repoHasStagedChanges(workspacePath, env) {
  const result = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: workspacePath,
    env: env ?? process.env,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return false;
  }
  if (result.status === 1) {
    return true;
  }
  throw new Error(`command failed: git diff --cached --quiet\n${result.stderr || result.stdout || "unknown failure"}`);
}

function ensureGitCommitIdentity(workspacePath, env) {
  const configuredName = readGitConfig(workspacePath, "user.name", env);
  const configuredEmail = readGitConfig(workspacePath, "user.email", env);

  if (!configuredName) {
    runCommand("git", ["config", "user.name", defaultGitUserName(env)], {
      cwd: workspacePath,
      env,
    });
  }

  if (!configuredEmail) {
    runCommand("git", ["config", "user.email", defaultGitUserEmail(env)], {
      cwd: workspacePath,
      env,
    });
  }
}

function readGitConfig(workspacePath, key, env) {
  const result = spawnSync("git", ["config", "--local", "--get", key], {
    cwd: workspacePath,
    env: env ?? process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return undefined;
  }
  return firstNonEmptyString(result.stdout.trim());
}

function defaultGitUserName(env) {
  return firstNonEmptyString(
    env?.RUNX_GIT_AUTHOR_NAME,
    env?.GIT_AUTHOR_NAME,
    env?.GITHUB_ACTIONS === "true" ? "github-actions[bot]" : undefined,
    "runx",
  );
}

function defaultGitUserEmail(env) {
  return firstNonEmptyString(
    env?.RUNX_GIT_AUTHOR_EMAIL,
    env?.GIT_AUTHOR_EMAIL,
    env?.GITHUB_ACTIONS === "true" ? "41898282+github-actions[bot]@users.noreply.github.com" : undefined,
    "runx@example.invalid",
  );
}

function pushGitHubBranch({ workspacePath, remote, branch, env }) {
  try {
    runCommand("git", ["push", "--set-upstream", remote, branch], {
      cwd: workspacePath,
      env,
    });
    return;
  } catch (error) {
    if (!isRunxGeneratedBranch(branch)) {
      throw error;
    }
    const remoteSha = readRemoteBranchSha({ workspacePath, remote, branch, env });
    if (!remoteSha) {
      throw error;
    }
    runCommand("git", [
      "push",
      "--set-upstream",
      `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
      remote,
      branch,
    ], {
      cwd: workspacePath,
      env,
    });
  }
}

function readRemoteBranchSha({ workspacePath, remote, branch, env }) {
  const stdout = runCommand("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
    cwd: workspacePath,
    env,
  });
  const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  const sha = line?.split(/\s+/)[0];
  return /^[0-9a-f]{40}$/i.test(sha ?? "") ? sha : undefined;
}

function isRunxGeneratedBranch(branch) {
  return typeof branch === "string" && branch.startsWith("runx/");
}

function runCommand(command, args, options) {
  const commandEnv = command === "git"
    ? gitCommandEnv(options?.env)
    : options?.env ?? process.env;
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    env: commandEnv,
    input: options?.input,
    encoding: "utf8",
    stdio: options?.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: ${command} ${args.join(" ")}\n${result.stderr || result.stdout || "unknown failure"}`,
    );
  }
  return result.stdout;
}

function gitCommandEnv(env) {
  const baseEnv = env ?? process.env;
  const token = githubTokenCandidates(baseEnv)[0]?.value;
  if (!token) {
    return baseEnv;
  }
  const tmpRoot = firstNonEmptyString(baseEnv.TMPDIR, baseEnv.TMP, baseEnv.TEMP);
  if (!tmpRoot) {
    return {
      ...baseEnv,
      GIT_TERMINAL_PROMPT: "0",
    };
  }
  const askpassDir = path.join(tmpRoot, "runx-git-askpass");
  mkdirSync(askpassDir, { recursive: true, mode: 0o700 });
  const askpassPath = path.join(askpassDir, `askpass-${process.pid}-${randomUUID()}.sh`);
  writeFileSync(
    askpassPath,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' 'x-access-token' ;;",
      "  *) printf '%s\\n' \"$RUNX_GIT_ASKPASS_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(askpassPath, 0o700);
  return {
    ...baseEnv,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    RUNX_GIT_ASKPASS_TOKEN: token,
  };
}

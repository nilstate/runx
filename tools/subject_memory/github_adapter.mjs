import { spawnSync } from "node:child_process";

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
  throw new Error("unable to resolve a GitHub issue reference from subject_memory.adapter.adapter_ref, subject_locator, or canonical_uri.");
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
    subject_locator: `github://${normalizedRepo}/issues/${normalizedIssue}`,
    issue_url: `https://github.com/${normalizedRepo}/issues/${normalizedIssue}`,
  };
}

export function ensureGitHubIssueReference(bodyMarkdown, issueRef) {
  const body = firstNonEmptyText(bodyMarkdown) ?? "";
  const marker = gitHubIssueReferenceMarker(issueRef);
  if (body.includes(marker) || body.includes(issueRef.issue_url)) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${marker}\n` : `${marker}\n`;
}

export function gitHubIssueReferenceMarker(issueRef) {
  return `Source issue: ${issueRef.issue_url}`;
}

export function gitHubIssueSearchQuery(issueRef) {
  return `"${gitHubIssueReferenceMarker(issueRef)}" in:body`;
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
  if (pullRequest.state && String(pullRequest.state).toUpperCase() !== "OPEN") {
    return "closed";
  }
  if (pullRequest.isDraft === true) {
    return "draft";
  }
  return "published";
}

export function mapGitHubPullRequestToOutboxEntry(pullRequest, subjectLocator) {
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
    subject_locator: subjectLocator,
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
      updated_at: firstNonEmptyString(pullRequest.updatedAt),
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

export function hydrateGitHubIssueSubjectMemory({ adapterRef, issue, pullRequests }) {
  const issueRef = parseGitHubIssueRef(adapterRef, issue?.url);
  const issueRecord = asRecord(issue, "issue");
  const comments = Array.isArray(issueRecord.comments) ? issueRecord.comments.filter(isRecord) : [];
  const normalizedPullRequests = dedupeGitHubPullRequests(pullRequests).map((pullRequest) => ({
    ...pullRequest,
    repo: issueRef.repo_slug,
  }));
  const entries = [];
  const createdAt = firstNonEmptyString(issueRecord.createdAt) ?? new Date().toISOString();
  const updatedAt = firstNonEmptyString(issueRecord.updatedAt, createdAt);
  const issueBody = firstNonEmptyText(issueRecord.body);

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
    const commentId = firstNonEmptyString(comment.id, comment.databaseId, comment.url, `${entries.length + 1}`);
    const recordedAt = firstNonEmptyString(comment.createdAt, comment.updatedAt, updatedAt) ?? updatedAt;
    entries.push(prune({
      entry_id: `comment-${commentId}`,
      entry_kind: "message",
      recorded_at: recordedAt,
      actor: normalizeGitHubActor(comment.author),
      body: firstNonEmptyText(comment.body),
      source_ref: prune({
        type: "github_issue_comment",
        uri: firstNonEmptyString(comment.url, issueRef.issue_url),
        recorded_at: recordedAt,
      }),
    }));
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
    kind: "runx.subject-memory.v1",
    adapter: {
      type: "github",
      provider: "github",
      surface: "issue_thread",
      adapter_ref: issueRef.adapter_ref,
      cursor: buildGitHubIssueCursor(issueRecord, comments, normalizedPullRequests),
    },
    subject: {
      subject_kind: "work_item",
      subject_locator: issueRef.subject_locator,
      title: firstNonEmptyString(issueRecord.title),
      canonical_uri: issueRef.issue_url,
      metadata: prune({
        repo: issueRef.repo_slug,
        issue_number: issueRef.issue_number,
        state: firstNonEmptyString(issueRecord.state),
      }),
    },
    entries,
    decisions: [],
    subject_outbox: normalizedPullRequests.map((pullRequest) =>
      mapGitHubPullRequestToOutboxEntry(pullRequest, issueRef.subject_locator)),
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

export function fetchGitHubIssueSubjectMemory({ adapterRef, env, cwd }) {
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
  ], { env, cwd });
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
      "baseRefName,headRefName,isDraft,number,state,title,updatedAt,url",
    ], { env, cwd })),
  ]);
  return hydrateGitHubIssueSubjectMemory({
    adapterRef: issueRef.adapter_ref,
    issue,
    pullRequests,
  });
}

export function pushGitHubPullRequest({
  subjectMemory,
  draftPullRequest,
  outboxEntry,
  workspacePath,
  nextStatus,
  env,
}) {
  const memory = asRecord(subjectMemory, "subject_memory");
  const draft = asRecord(draftPullRequest, "draft_pull_request");
  const outbox = asRecord(outboxEntry, "outbox_entry");
  const issueRef = parseGitHubIssueRef(
    optionalRecord(memory.adapter)?.adapter_ref,
    optionalRecord(memory.subject)?.canonical_uri,
    optionalRecord(memory.subject)?.subject_locator,
  );
  const target = asRecord(draft.target, "draft_pull_request.target");
  const pullRequest = asRecord(draft.pull_request, "draft_pull_request.pull_request");
  const repoSlug = firstNonEmptyString(target.repo, issueRef.repo_slug);
  const branch = firstNonEmptyString(target.branch);
  const base = firstNonEmptyString(target.base);
  const remote = firstNonEmptyString(target.remote, "origin");
  const title = firstNonEmptyString(pullRequest.title, outbox.title, optionalRecord(memory.subject)?.title);
  const commitMessage = buildGitHubCommitMessage(draft, title);

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
    firstNonEmptyText(pullRequest.body_markdown, `# ${title}\n`),
    issueRef,
  );

  if (repoHasUncommittedChanges(workspacePath, env)) {
    runCommand("git", ["add", "-A"], {
      cwd: workspacePath,
      env,
    });
    runCommand("git", ["commit", "-m", commitMessage], {
      cwd: workspacePath,
      env,
    });
  }

  runCommand("git", ["push", "--set-upstream", remote, branch], {
    cwd: workspacePath,
    env,
  });

  const existingNumber = parseGitHubPullRequestNumber(outbox.locator)
    ?? parseGitHubPullRequestNumber(optionalRecord(outbox.metadata)?.number);
  let pullRequestRef = existingNumber;

  if (pullRequestRef) {
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
    runCommand(resolveGhBinary(env), args, {
      cwd: workspacePath,
      env,
    });
  } else {
    const args = [
      "pr",
      "create",
      "--repo",
      repoSlug,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
      "--draft",
    ];
    if (base) {
      args.push("--base", base);
    }
    pullRequestRef = runCommand(resolveGhBinary(env), args, {
      cwd: workspacePath,
      env,
    }).trim();
  }

  const pullRequestView = runGhJson([
    "pr",
    "view",
    pullRequestRef,
    "--repo",
    repoSlug,
    "--json",
    "baseRefName,headRefName,isDraft,number,state,title,updatedAt,url",
  ], {
    cwd: workspacePath,
    env,
  });
  const refreshedEntry = mapGitHubPullRequestToOutboxEntry(
    {
      ...pullRequestView,
      repo: repoSlug,
    },
    firstNonEmptyString(optionalRecord(memory.subject)?.subject_locator, issueRef.subject_locator),
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

function dedupeGitHubPullRequests(pullRequests) {
  const seen = new Set();
  const merged = [];
  for (const pullRequest of normalizeGitHubPullRequestArray(pullRequests)) {
    const key = firstNonEmptyString(pullRequest.number, pullRequest.url);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(pullRequest);
  }
  return merged;
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

function buildGitHubCommitMessage(draftPullRequest, title) {
  const existingTitle = firstNonEmptyString(title);
  if (existingTitle && /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?: /i.test(existingTitle)) {
    return existingTitle;
  }
  return `chore(issue-to-pr): apply ${firstNonEmptyString(draftPullRequest.task_id, existingTitle, "runx-change")}`;
}

function runGhJson(args, options) {
  return JSON.parse(runCommand(resolveGhBinary(options?.env), args, options));
}

function repoHasUncommittedChanges(workspacePath, env) {
  return runCommand("git", ["status", "--short"], {
    cwd: workspacePath,
    env,
  }).trim().length > 0;
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: ${command} ${args.join(" ")}\n${result.stderr || result.stdout || "unknown failure"}`,
    );
  }
  return result.stdout;
}

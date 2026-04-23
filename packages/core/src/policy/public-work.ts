export interface PublicWorkPolicy {
  readonly blocked_author_patterns?: readonly string[];
  readonly blocked_head_ref_prefixes?: readonly string[];
  readonly blocked_exact_labels?: readonly string[];
  readonly blocked_label_prefixes?: readonly string[];
  readonly trust_recovery_statuses?: readonly string[];
  readonly require_welcome_signal_for_pull_request_comments?: boolean;
}

export interface PublicPullRequestCandidateRequest {
  readonly authorLogin?: string;
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly headRefName?: string;
}

export interface PublicCommentOpportunityRequest extends PublicPullRequestCandidateRequest {
  readonly source?: string;
  readonly lane?: string;
  readonly authorAssociation?: string;
  readonly commentsCount?: number;
  readonly reviewCommentsCount?: number;
  readonly recentOutcomes?: ReadonlyArray<{ readonly status?: string | null } | null | undefined>;
}

export interface PublicPolicyDecision {
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

export interface PublicCommentPolicyDecision extends PublicPolicyDecision {
  readonly welcome_signal: boolean;
}

export function evaluatePublicPullRequestCandidate(
  request: PublicPullRequestCandidateRequest,
  policy: PublicWorkPolicy = {},
): PublicPolicyDecision {
  const normalized = normalizePublicWorkPolicy(policy);
  const reasons: string[] = [];
  if (isBlockedAuthor(request.authorLogin, normalized)) {
    reasons.push("bot_authored_pull_request");
  }
  if (isDependencyUpdatePullRequest(request, normalized)) {
    reasons.push("dependency_update_pull_request");
  }
  if (hasBlockedPullRequestLabels(request.labels, normalized)) {
    reasons.push("internal_or_build_only_pull_request");
  }
  return {
    blocked: reasons.length > 0,
    reasons,
  };
}

export function evaluatePublicCommentOpportunity(
  request: PublicCommentOpportunityRequest,
  policy: PublicWorkPolicy = {},
): PublicCommentPolicyDecision {
  const normalized = normalizePublicWorkPolicy(policy);
  const reasons = [...evaluatePublicPullRequestCandidate(request, normalized).reasons];
  const welcomeSignal = hasWelcomeSignal(request, normalized);
  if (
    request.source === "github_pull_request"
    && request.lane === "issue-triage"
    && normalized.require_welcome_signal_for_pull_request_comments
    && !welcomeSignal
  ) {
    reasons.push("comment_without_welcome_signal");
  }
  if (request.lane === "issue-triage" && isCommentLaneInTrustRecovery(request.recentOutcomes, normalized)) {
    reasons.push("comment_lane_in_trust_recovery");
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    welcome_signal: welcomeSignal,
  };
}

export function normalizePublicWorkPolicy(policy: PublicWorkPolicy = {}): Required<PublicWorkPolicy> {
  return {
    blocked_author_patterns: normalizeValues(policy.blocked_author_patterns, DEFAULT_PUBLIC_WORK_POLICY.blocked_author_patterns),
    blocked_head_ref_prefixes: normalizeValues(policy.blocked_head_ref_prefixes, DEFAULT_PUBLIC_WORK_POLICY.blocked_head_ref_prefixes),
    blocked_exact_labels: normalizeValues(policy.blocked_exact_labels, DEFAULT_PUBLIC_WORK_POLICY.blocked_exact_labels),
    blocked_label_prefixes: normalizeValues(policy.blocked_label_prefixes, DEFAULT_PUBLIC_WORK_POLICY.blocked_label_prefixes),
    trust_recovery_statuses: normalizeValues(policy.trust_recovery_statuses, DEFAULT_PUBLIC_WORK_POLICY.trust_recovery_statuses),
    require_welcome_signal_for_pull_request_comments:
      policy.require_welcome_signal_for_pull_request_comments
      ?? DEFAULT_PUBLIC_WORK_POLICY.require_welcome_signal_for_pull_request_comments,
  };
}

function isBlockedAuthor(authorLogin: string | undefined, policy: Required<PublicWorkPolicy>): boolean {
  const login = String(authorLogin ?? "").trim().toLowerCase();
  return login.length > 0 && policy.blocked_author_patterns.some((pattern) => login.includes(pattern));
}

function isDependencyUpdatePullRequest(
  request: PublicPullRequestCandidateRequest,
  policy: Required<PublicWorkPolicy>,
): boolean {
  const normalizedLabels = normalizeLabels(request.labels);
  const normalizedTitle = String(request.title ?? "").trim().toLowerCase();
  const normalizedHead = String(request.headRefName ?? "").trim().toLowerCase();
  if (policy.blocked_head_ref_prefixes.some((prefix) => normalizedHead.startsWith(prefix))) {
    return true;
  }
  if (normalizedLabels.some((label) => policy.blocked_exact_labels.includes(label))) {
    return true;
  }
  if (/(^|\b)(update|upgrade|bump)(\b|:)/.test(normalizedTitle) && /\bv?\d+\.\d+/.test(normalizedTitle)) {
    return true;
  }
  return /dependency|dependencies|deps\b/.test(normalizedTitle);
}

function hasBlockedPullRequestLabels(labels: readonly string[] | undefined, policy: Required<PublicWorkPolicy>): boolean {
  const normalizedLabels = normalizeLabels(labels);
  return normalizedLabels.some((label) => {
    return policy.blocked_exact_labels.includes(label) || policy.blocked_label_prefixes.some((prefix) => label.startsWith(prefix));
  });
}

function hasWelcomeSignal(
  request: Pick<PublicCommentOpportunityRequest, "source" | "authorAssociation" | "commentsCount" | "reviewCommentsCount">,
  policy: Required<PublicWorkPolicy>,
): boolean {
  if (!policy.require_welcome_signal_for_pull_request_comments || request.source !== "github_pull_request") {
    return true;
  }
  if (["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"].includes(String(request.authorAssociation ?? "").toUpperCase())) {
    return true;
  }
  return Number(request.commentsCount ?? 0) + Number(request.reviewCommentsCount ?? 0) > 0;
}

function isCommentLaneInTrustRecovery(
  recentOutcomes: PublicCommentOpportunityRequest["recentOutcomes"],
  policy: Required<PublicWorkPolicy>,
): boolean {
  return Array.isArray(recentOutcomes)
    && recentOutcomes.some((entry) => policy.trust_recovery_statuses.includes(String(entry?.status ?? "").trim().toLowerCase()));
}

function normalizeLabels(labels: readonly string[] | undefined): readonly string[] {
  return Array.isArray(labels)
    ? labels.map((label) => String(label ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function normalizeValues(values: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  return Array.isArray(values)
    ? values.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean)
    : fallback;
}

export const DEFAULT_PUBLIC_WORK_POLICY: Required<PublicWorkPolicy> = {
  blocked_author_patterns: ["[bot]", "app/", "renovate", "dependabot", "github-actions", "github-actions[bot]"],
  blocked_head_ref_prefixes: ["renovate/", "dependabot/", "runx/issue-", "runx/evidence-projection-derive"],
  blocked_exact_labels: [
    "dependencies",
    "dependency",
    "deps",
    "rust dependencies",
    "javascript dependencies",
    "python dependencies",
    "artifact drift",
    "artifact-update",
    "artifact update",
    "internal",
  ],
  blocked_label_prefixes: ["build:", "release:"],
  trust_recovery_statuses: ["spam", "minimized", "harmful"],
  require_welcome_signal_for_pull_request_comments: true,
};

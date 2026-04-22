export interface GitHubIssueRef {
  readonly repo_slug: string;
  readonly issue_number: string;
  readonly adapter_ref: string;
  readonly subject_locator: string;
  readonly issue_url: string;
}

export interface GitHubHydratedSubjectMemory {
  readonly kind: string;
  readonly adapter: Record<string, unknown>;
  readonly subject: Record<string, unknown>;
  readonly entries: readonly Record<string, unknown>[];
  readonly subject_outbox: readonly Record<string, unknown>[];
  readonly source_refs: readonly Record<string, unknown>[];
  readonly generated_at?: string;
  readonly watermark?: string;
}

export function firstNonEmptyString(...values: readonly unknown[]): string | undefined;
export function parseGitHubIssueRef(...values: readonly unknown[]): GitHubIssueRef;
export function ensureGitHubIssueReference(bodyMarkdown: string | undefined, issueRef: GitHubIssueRef): string;
export function gitHubIssueSearchQuery(issueRef: GitHubIssueRef): string;
export function hydrateGitHubIssueSubjectMemory(options: {
  readonly adapterRef: string;
  readonly issue: unknown;
  readonly pullRequests?: readonly unknown[];
}): GitHubHydratedSubjectMemory;
export function fetchGitHubIssueSubjectMemory(options: {
  readonly adapterRef: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): GitHubHydratedSubjectMemory;
export function selectPreferredGitHubPullRequest<T extends Record<string, unknown>>(
  pullRequests: readonly T[],
  preferredBranch?: string,
): T | undefined;

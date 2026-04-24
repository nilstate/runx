export interface GitHubIssueRef {
  readonly repo_slug: string;
  readonly issue_number: string;
  readonly adapter_ref: string;
  readonly thread_locator: string;
  readonly issue_url: string;
}

export interface GitHubHydratedThread {
  readonly kind: string;
  readonly adapter: Record<string, unknown>;
  readonly thread_kind: string;
  readonly thread_locator: string;
  readonly title?: string;
  readonly canonical_uri?: string;
  readonly metadata?: Record<string, unknown>;
  readonly entries: readonly Record<string, unknown>[];
  readonly outbox: readonly Record<string, unknown>[];
  readonly source_refs: readonly Record<string, unknown>[];
  readonly generated_at?: string;
  readonly watermark?: string;
}

export function firstNonEmptyString(...values: readonly unknown[]): string | undefined;
export function parseGitHubIssueRef(...values: readonly unknown[]): GitHubIssueRef;
export function ensureGitHubIssueReference(bodyMarkdown: string | undefined, issueRef: GitHubIssueRef): string;
export function gitHubIssueSearchQuery(issueRef: GitHubIssueRef): string;
export function gitHubOutboxEntryMarker(entryId: string): string;
export function gitHubOutboxMetadataMarker(metadata: Record<string, unknown> | undefined): string | undefined;
export function parseGitHubOutboxMetadataMarker(value: string | undefined): Record<string, unknown> | undefined;
export function ensureGitHubOutboxMetadataMarker(
  bodyMarkdown: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string;
export function hydrateGitHubIssueThread(options: {
  readonly adapterRef: string;
  readonly issue: unknown;
  readonly pullRequests?: readonly unknown[];
}): GitHubHydratedThread;
export function fetchGitHubIssueThread(options: {
  readonly adapterRef: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): GitHubHydratedThread;
export function selectPreferredGitHubPullRequest<T extends Record<string, unknown>>(
  pullRequests: readonly T[],
  preferredBranch?: string,
): T | undefined;

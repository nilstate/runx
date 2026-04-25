import type { ParsedArgs } from "../index.js";

export type DocsCommandArgs = Partial<ParsedArgs> & {
  readonly command?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly receiptDir?: string;
  readonly docsAction?: "rerun" | "push-pr" | "signal" | "status" | "doctor" | "dogfood" | "bind-repo";
};

export interface GitHubIssueRef {
  readonly repo_slug: string;
  readonly issue_number: string;
  readonly adapter_ref: string;
  readonly thread_locator: string;
  readonly issue_url: string;
}

export interface GitHubHydratedThread {
  readonly thread_locator: string;
  readonly canonical_uri?: string;
  readonly outbox?: readonly unknown[];
}

export interface DocsCommandDeps {
  readonly resolveRegistryStoreForChains: (env: NodeJS.ProcessEnv) => Promise<import("@runxhq/core/registry").RegistryStore | undefined>;
}

export type DocsCommandResult =
  | {
      readonly status: "success";
      readonly action: "status" | "rerun" | "push-pr" | "signal" | "bind-repo";
      readonly issue: string;
      readonly thread_locator: string;
      readonly task_id?: string;
      readonly lane?: "pull_request" | "outreach";
      readonly target_repo?: string;
      readonly repo_root?: string;
      readonly preview_url?: string;
      readonly review_comment_url?: string;
      readonly pull_request_url?: string;
      readonly review_entry_id?: string;
      readonly summary: string;
      readonly thread: GitHubHydratedThread;
      readonly handoff_state?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "success";
      readonly action: "doctor" | "dogfood";
      readonly summary: string;
      readonly checks?: readonly {
        readonly status: "pass" | "fail";
        readonly message: string;
      }[];
      readonly receipts?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "needs_resolution" | "policy_denied" | "failure";
      readonly action: NonNullable<DocsCommandArgs["docsAction"]>;
      readonly issue?: string;
      readonly phase?: "scan" | "build" | "review" | "signal";
      readonly message: string;
      readonly result?: import("@runxhq/core/runner-local").RunLocalSkillResult;
    };

export interface DocsControlState {
  readonly issueRef: GitHubIssueRef;
  readonly thread: GitHubHydratedThread;
  readonly latestReview?: Record<string, unknown>;
  readonly latestSignal?: Record<string, unknown>;
  readonly latestPullRequest?: Record<string, unknown>;
  readonly taskId?: string;
  readonly lane?: "pull_request" | "outreach";
  readonly targetRepo?: string;
  readonly boundRepoRoot?: string;
  readonly handoffRef?: Record<string, unknown>;
  readonly handoffState?: Record<string, unknown>;
}

export interface ExecutedDocsSkill {
  readonly result: import("@runxhq/core/runner-local").RunLocalSkillResult;
  readonly packet?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
}

export function readStringInput(inputs: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = inputs[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function readBooleanInput(
  inputs: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fallback: boolean,
): boolean {
  for (const key of keys) {
    const value = inputs[key];
    if (value === true || value === "true") {
      return true;
    }
    if (value === false || value === "false") {
      return false;
    }
  }
  return fallback;
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readStringFromRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  pathSegments: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const segment of pathSegments) {
    const record = readRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return firstNonEmptyString(current);
}

export function readBooleanFromRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  pathSegments: readonly string[],
): boolean | undefined {
  let current: unknown = value;
  for (const segment of pathSegments) {
    const record = readRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return typeof current === "boolean" ? current : undefined;
}

export function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function pruneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}

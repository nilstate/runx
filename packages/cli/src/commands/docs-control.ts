import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DocsCommandResult, DocsControlState, GitHubHydratedThread } from "./docs-shared.js";
import {
  firstNonEmptyString,
  pruneRecord,
  readRecord,
  readStringFromRecord,
} from "./docs-shared.js";
import { loadThreadAdapterModule } from "./docs-runtime.js";

const DOCS_CONTROL_BINDINGS_PATH = path.join(".runx", "state", "docs-control-bindings.json");

export function buildDocsStatusResult(control: DocsControlState): DocsCommandResult {
  return {
    status: "success",
    action: "status",
    issue: control.issueRef.issue_url,
    thread_locator: control.issueRef.thread_locator,
    task_id: control.taskId,
    lane: control.lane,
    target_repo: control.targetRepo,
    repo_root: control.boundRepoRoot,
    review_comment_url: firstNonEmptyString(control.latestReview?.locator),
    pull_request_url: firstNonEmptyString(control.latestPullRequest?.locator),
    review_entry_id: firstNonEmptyString(control.latestReview?.entry_id),
    summary: firstNonEmptyString(
      readStringFromRecord(control.handoffState, ["summary"]),
      control.latestReview
        ? "Docs review state recovered from the control thread."
        : "No docs review comments have been published on this control thread yet.",
    ) ?? "No docs review comments have been published on this control thread yet.",
    handoff_state: control.handoffState,
    thread: control.thread,
  };
}

export async function loadDocsControlState(issueInput: string, env: NodeJS.ProcessEnv, cwd: string): Promise<DocsControlState> {
  const threadAdapter = await loadThreadAdapterModule(env);
  const issueRef = threadAdapter.parseGitHubIssueRef(issueInput);
  const thread = threadAdapter.fetchGitHubIssueThread({
    adapterRef: issueRef.adapter_ref,
    env,
    cwd,
  });
  const latestReview = findLatestDocsReviewEntry(thread);
  const latestSignal = findLatestDocsSignalEntry(thread);
  const latestPullRequest = findLatestPullRequestEntry(thread);
  const control = readDocsControlMetadata(latestReview);
  const signalControl = readDocsControlMetadata(latestSignal);
  const lane = inferDocsLane(latestReview);
  const handoffRef = readRecord(signalControl?.handoff_ref) ?? readRecord(control?.handoff_ref);
  return {
    issueRef,
    thread,
    latestReview,
    latestSignal,
    latestPullRequest,
    taskId: firstNonEmptyString(
      signalControl?.task_id,
      control?.task_id,
      parseDocsTaskId(firstNonEmptyString(latestReview?.entry_id)),
      parseDocsSignalTaskId(firstNonEmptyString(latestSignal?.entry_id)),
    ),
    lane,
    targetRepo: firstNonEmptyString(
      readStringFromRecord(handoffRef, ["target_repo"]),
      readStringFromRecord(signalControl, ["target_repo"]),
      readStringFromRecord(control, ["target_repo"]),
    ),
    handoffRef,
    handoffState: readRecord(signalControl?.handoff_state),
  };
}

export async function withDocsRepoBinding(control: DocsControlState, sourceyRoot: string | undefined): Promise<DocsControlState> {
  if (!sourceyRoot) {
    return control;
  }
  const bindings = await readDocsRepoBindings(sourceyRoot);
  const binding = readRecord(bindings[control.issueRef.thread_locator]);
  return {
    ...control,
    targetRepo: firstNonEmptyString(
      control.targetRepo,
      readStringFromRecord(binding, ["target_repo"]),
    ),
    boundRepoRoot: firstNonEmptyString(
      readStringFromRecord(binding, ["repo_root"]),
      control.boundRepoRoot,
    ),
  };
}

export function selectDocsLane(options: {
  readonly action: "rerun" | "push-pr";
  readonly explicit?: string;
  readonly priorLane?: "pull_request" | "outreach";
  readonly buildPacket: Readonly<Record<string, unknown>>;
}): "pull_request" | "outreach" {
  const explicit = firstNonEmptyString(options.explicit);
  if (explicit === "pr" || explicit === "pull_request") {
    return "pull_request";
  }
  if (explicit === "outreach") {
    return "outreach";
  }
  if (options.action === "push-pr") {
    return "pull_request";
  }
  if (options.priorLane) {
    return options.priorLane;
  }
  return readStringFromRecord(options.buildPacket, ["operator_summary", "recommended_handoff"]) === "outreach"
    ? "outreach"
    : "pull_request";
}

export function resolveDocsTaskId(
  explicit: string | undefined,
  previous: string | undefined,
  buildPacket: Readonly<Record<string, unknown>>,
  lane: "pull_request" | "outreach",
): string | undefined {
  return firstNonEmptyString(
    explicit,
    previous,
    buildTaskIdFromPacket(buildPacket, lane),
  );
}

export function buildMaintainerContact(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  return pruneRecord({
    channel: readStringInput(inputs, ["contact-channel", "contact_channel", "channel"]),
    email: readStringInput(inputs, ["maintainer-email", "maintainer_email", "email"]),
    display_name: readStringInput(inputs, ["maintainer-name", "maintainer_name", "name"]),
    locator: readStringInput(inputs, ["contact-locator", "contact_locator"]),
    handle: readStringInput(inputs, ["contact-handle", "contact_handle", "handle"]),
    subject: readStringInput(inputs, ["subject"]),
  });
}

export function buildSignalSourceRef(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const uri = readStringInput(inputs, ["source-ref", "source_ref", "source-uri", "source_uri"]);
  if (!uri) {
    return undefined;
  }
  return pruneRecord({
    type: readStringInput(inputs, ["source-ref-type", "source_ref_type"]) ?? "provider_comment",
    uri,
    label: readStringInput(inputs, ["source-ref-label", "source_ref_label"]),
    recorded_at: readStringInput(inputs, ["recorded-at", "recorded_at"]),
  });
}

export async function writeDocsRepoBinding(
  sourceyRoot: string,
  threadLocator: string,
  binding: Readonly<Record<string, unknown>>,
): Promise<void> {
  const bindingsPath = path.join(sourceyRoot, DOCS_CONTROL_BINDINGS_PATH);
  const bindingsDir = path.dirname(bindingsPath);
  const existing = await readDocsRepoBindings(sourceyRoot);
  await mkdir(bindingsDir, { recursive: true });
  await writeFile(
    bindingsPath,
    `${JSON.stringify({
      schema_version: "runx.docs-control-bindings.v1",
      bindings: {
        ...existing,
        [threadLocator]: pruneRecord(binding),
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

export function synthesizeHandoffRef(control: DocsControlState): Record<string, unknown> | undefined {
  if (!control.taskId || !control.lane) {
    return undefined;
  }
  return pruneRecord({
    handoff_id: control.lane === "pull_request" ? `sourcey.docs-pr:${control.taskId}` : `sourcey.docs-outreach:${control.taskId}`,
    boundary_kind: control.lane === "pull_request" ? "external_maintainer" : "external_contact",
    thread_locator: control.issueRef.thread_locator,
    target_locator: control.issueRef.thread_locator,
    outbox_entry_id: firstNonEmptyString(control.latestReview?.entry_id),
  });
}

export function buildDocsSignalOutboxEntry(
  control: DocsControlState,
  artifacts: {
    readonly handoffRef?: Record<string, unknown>;
    readonly handoffSignal?: Record<string, unknown>;
    readonly handoffState?: Record<string, unknown>;
    readonly suppressionRecord?: Record<string, unknown>;
  },
): Record<string, unknown> | undefined {
  if (!control.taskId) {
    return undefined;
  }
  const handoffRef = readRecord(artifacts.handoffRef);
  const handoffSignal = readRecord(artifacts.handoffSignal);
  const handoffState = readRecord(artifacts.handoffState);
  if (!handoffRef || !handoffSignal || !handoffState) {
    return undefined;
  }
  const suppressionRecord = readRecord(artifacts.suppressionRecord);
  const sourceRef = readRecord(handoffSignal.source_ref);
  const existing = control.latestSignal;
  const previewUrl = deriveDocsPreviewUrl(control.latestReview);
  const reviewUrl = firstNonEmptyString(control.latestReview?.locator);
  const targetRepo = firstNonEmptyString(
    readStringFromRecord(handoffRef, ["target_repo"]),
    control.targetRepo,
    parseTargetRepoFromPreviewUrl(previewUrl),
  );
  const status = readStringFromRecord(handoffState, ["status"]) ?? "unknown";
  const summary = firstNonEmptyString(readStringFromRecord(handoffState, ["summary"]));
  const bodyLines = [
    "Current control status for the active docs handoff.",
    "",
    "## Current State",
    targetRepo ? `Target repo: \`${targetRepo}\`` : undefined,
    `Status: \`${status}\``,
    summary ? `Summary: ${summary}` : undefined,
    previewUrl ? `Preview site: ${previewUrl}` : undefined,
    reviewUrl ? `Draft review: ${reviewUrl}` : undefined,
    "",
    "## Latest Signal",
    `Source: \`${readStringFromRecord(handoffSignal, ["source"]) ?? "unknown"}\``,
    `Disposition: \`${readStringFromRecord(handoffSignal, ["disposition"]) ?? "unknown"}\``,
    `Recorded at: \`${readStringFromRecord(handoffSignal, ["recorded_at"]) ?? "unknown"}\``,
    sourceRef
      ? `Source ref: ${readStringFromRecord(sourceRef, ["uri"]) ?? "unknown"}`
      : undefined,
    suppressionRecord
      ? `Suppression: \`${readStringFromRecord(suppressionRecord, ["scope"]) ?? "unknown"}\` / \`${readStringFromRecord(suppressionRecord, ["reason"]) ?? "unknown"}\``
      : undefined,
    "",
    "## Next Action",
    describeDocsNextAction(status),
  ].filter((line): line is string => typeof line === "string");

  return pruneRecord({
    entry_id: firstNonEmptyString(existing?.entry_id, `message:${control.taskId}:signal`),
    kind: "message",
    locator: firstNonEmptyString(existing?.locator),
    status: "draft",
    thread_locator: control.issueRef.thread_locator,
    metadata: pruneRecord({
      schema_version: "runx.outbox-entry.message.v1",
      channel: "github_issue_comment",
      comment_id: readStringFromRecord(existing, ["metadata", "comment_id"]),
      body_markdown: `${bodyLines.join("\n")}\n`,
      control: {
        schema_version: "sourcey.docs.control.v1",
        workflow: "docs",
        lane: "handoff_signal",
        task_id: control.taskId,
        handoff_lane: control.lane ?? "pull_request",
        handoff_ref: handoffRef,
        handoff_signal: handoffSignal,
        handoff_state: handoffState,
        suppression_record: suppressionRecord,
      },
    }),
  });
}

export function describeDocsNextAction(status: string): string {
  switch (status) {
    case "needs_revision":
      return "The refreshed draft is still gated by requested changes. Keep reviewing in-thread, leave more feedback if needed, or record acceptance once the draft is ready.";
    case "accepted":
      return "The draft content is accepted, but the upstream send is still gated. Record `approved_to_send` when you want `runx docs push-pr` to proceed.";
    case "approved_to_send":
      return "The control thread is explicitly approved to send. Trigger the upstream PR push when ready.";
    case "suppressed":
      return "Do not send follow-up outreach from this handoff unless an operator intentionally clears the suppression state.";
    default:
      return "Review the current handoff state and decide whether to revise, approve, or suppress the next outbound step.";
  }
}

export async function refreshDocsStatusComment(
  control: DocsControlState,
  env: NodeJS.ProcessEnv,
  sourceyRoot: string,
): Promise<void> {
  if (!control.latestSignal) {
    return;
  }
  const signalOutboxEntry = buildDocsSignalOutboxEntry(
    control,
    readDocsSignalArtifactsFromControl(control),
  );
  if (!signalOutboxEntry) {
    return;
  }
  const threadAdapter = await loadThreadAdapterModule(env);
  threadAdapter.pushGitHubMessage({
    thread: control.thread,
    outboxEntry: signalOutboxEntry,
    nextStatus: "published",
    env,
    workspacePath: sourceyRoot,
  });
}

function buildTaskIdFromPacket(buildPacket: Readonly<Record<string, unknown>>, lane: "pull_request" | "outreach"): string | undefined {
  const repoSlug = readStringFromRecord(buildPacket, ["scan", "target", "repo_slug"]);
  if (!repoSlug) {
    return undefined;
  }
  const normalizedRepo = repoSlug.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return lane === "outreach" ? `docs-outreach-${normalizedRepo}` : `docs-refresh-${normalizedRepo}`;
}

function findLatestDocsReviewEntry(thread: { readonly outbox?: readonly unknown[] } | Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const outbox = Array.isArray(thread.outbox) ? thread.outbox : [];
  const reviews = outbox
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => entry.kind === "message")
    .filter((entry) => {
      const entryId = firstNonEmptyString(entry.entry_id);
      if (!entryId) {
        return false;
      }
      const control = readDocsControlMetadata(entry);
      if (control?.workflow === "docs" && (control?.lane === "pr_review" || control?.lane === "outreach_review")) {
        return true;
      }
      return /^message:[^:]+:review$/i.test(entryId);
    });
  return reviews
    .slice()
    .sort((left, right) => {
      const leftUpdated = firstNonEmptyString(
        readStringFromRecord(left, ["metadata", "updated_at"]),
        readStringFromRecord(left, ["metadata", "pushed_at"]),
        readStringFromRecord(left, ["locator"]),
        readStringFromRecord(left, ["entry_id"]),
      );
      const rightUpdated = firstNonEmptyString(
        readStringFromRecord(right, ["metadata", "updated_at"]),
        readStringFromRecord(right, ["metadata", "pushed_at"]),
        readStringFromRecord(right, ["locator"]),
        readStringFromRecord(right, ["entry_id"]),
      );
      return String(rightUpdated).localeCompare(String(leftUpdated));
    })[0];
}

function findLatestDocsSignalEntry(thread: { readonly outbox?: readonly unknown[] } | Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const outbox = Array.isArray(thread.outbox) ? thread.outbox : [];
  const signals = outbox
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => entry.kind === "message")
    .filter((entry) => {
      const entryId = firstNonEmptyString(entry.entry_id);
      if (!entryId) {
        return false;
      }
      const control = readDocsControlMetadata(entry);
      if (control?.workflow === "docs" && control?.lane === "handoff_signal") {
        return true;
      }
      return /^message:[^:]+:signal$/i.test(entryId);
    });
  return signals
    .slice()
    .sort((left, right) => {
      const leftUpdated = firstNonEmptyString(
        readStringFromRecord(left, ["metadata", "updated_at"]),
        readStringFromRecord(left, ["metadata", "pushed_at"]),
        readStringFromRecord(left, ["locator"]),
        readStringFromRecord(left, ["entry_id"]),
      );
      const rightUpdated = firstNonEmptyString(
        readStringFromRecord(right, ["metadata", "updated_at"]),
        readStringFromRecord(right, ["metadata", "pushed_at"]),
        readStringFromRecord(right, ["locator"]),
        readStringFromRecord(right, ["entry_id"]),
      );
      return String(rightUpdated).localeCompare(String(leftUpdated));
    })[0];
}

function findLatestPullRequestEntry(thread: { readonly outbox?: readonly unknown[] } | Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const outbox = Array.isArray(thread.outbox) ? thread.outbox : [];
  return outbox
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => entry.kind === "pull_request")
    .slice()
    .sort((left, right) => {
      const leftUpdated = firstNonEmptyString(
        readStringFromRecord(left, ["metadata", "updated_at"]),
        readStringFromRecord(left, ["metadata", "pushed_at"]),
        readStringFromRecord(left, ["locator"]),
        readStringFromRecord(left, ["entry_id"]),
      );
      const rightUpdated = firstNonEmptyString(
        readStringFromRecord(right, ["metadata", "updated_at"]),
        readStringFromRecord(right, ["metadata", "pushed_at"]),
        readStringFromRecord(right, ["locator"]),
        readStringFromRecord(right, ["entry_id"]),
      );
      return String(rightUpdated).localeCompare(String(leftUpdated));
    })[0];
}

function inferDocsLane(entry: Record<string, unknown> | undefined): "pull_request" | "outreach" | undefined {
  const control = readDocsControlMetadata(entry);
  if (control?.lane === "pr_review") {
    return "pull_request";
  }
  if (control?.lane === "outreach_review") {
    return "outreach";
  }
  const body = readStringFromRecord(entry, ["metadata", "body_markdown"]);
  if (!body) {
    return undefined;
  }
  if (body.includes("## Exact PR Body")) {
    return "pull_request";
  }
  if (body.includes("## Exact Outreach Body")) {
    return "outreach";
  }
  return undefined;
}

function parseDocsTaskId(entryId: string | undefined): string | undefined {
  const text = firstNonEmptyString(entryId);
  if (!text) {
    return undefined;
  }
  const match = text.match(/^message:([^:]+):review$/i);
  return firstNonEmptyString(match?.[1]);
}

function parseDocsSignalTaskId(entryId: string | undefined): string | undefined {
  const text = firstNonEmptyString(entryId);
  if (!text) {
    return undefined;
  }
  const match = text.match(/^message:([^:]+):signal$/i);
  return firstNonEmptyString(match?.[1]);
}

function readDocsControlMetadata(entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const metadata = readRecord(entry?.metadata);
  return readRecord(metadata?.control);
}

function readDocsSignalArtifactsFromControl(control: DocsControlState): {
  readonly handoffRef?: Record<string, unknown>;
  readonly handoffSignal?: Record<string, unknown>;
  readonly handoffState?: Record<string, unknown>;
  readonly suppressionRecord?: Record<string, unknown>;
} {
  const latestSignalControl = readDocsControlMetadata(control.latestSignal);
  return {
    handoffRef: readRecord(latestSignalControl?.handoff_ref),
    handoffSignal: readRecord(latestSignalControl?.handoff_signal),
    handoffState: readRecord(latestSignalControl?.handoff_state),
    suppressionRecord: readRecord(latestSignalControl?.suppression_record),
  };
}

function deriveDocsPreviewUrl(entry: Record<string, unknown> | undefined): string | undefined {
  const direct = sanitizeDocsPreviewUrl(firstNonEmptyString(
    readStringFromRecord(entry, ["metadata", "build_url"]),
    readStringFromRecord(entry, ["metadata", "control", "build_url"]),
  ));
  if (direct) {
    return direct;
  }
  const body = readStringFromRecord(entry, ["metadata", "body_markdown"]);
  if (!body) {
    return undefined;
  }
  const match = body.match(/https:\/\/sourcey\.com\/previews\/[^\s)'"`]+/i);
  return sanitizeDocsPreviewUrl(firstNonEmptyString(match?.[0]));
}

function sanitizeDocsPreviewUrl(value: string | undefined): string | undefined {
  return firstNonEmptyString(value?.replace(/[.,;:!?]+$/u, ""));
}

function parseTargetRepoFromPreviewUrl(value: string | undefined): string | undefined {
  const previewUrl = firstNonEmptyString(value);
  if (!previewUrl) {
    return undefined;
  }
  const match = previewUrl.match(/\/previews\/([^/]+)\/([^/]+)\/?/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

async function readDocsRepoBindings(sourceyRoot: string): Promise<Readonly<Record<string, unknown>>> {
  const filePath = path.join(sourceyRoot, DOCS_CONTROL_BINDINGS_PATH);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const bindings = readRecord(parsed.bindings);
    return bindings ?? {};
  } catch {
    return {};
  }
}

function readStringInput(inputs: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = inputs[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

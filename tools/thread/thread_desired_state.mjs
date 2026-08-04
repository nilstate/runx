import { createHash } from "node:crypto";
import {
  firstNonEmptyString,
  isRecord,
  parseGitHubIssueRef,
  prune,
} from "./github_adapter.mjs";
import { sanitizePublicMarkdown } from "../public_markdown.mjs";

// Generic translator from a declarative desired-thread-state (see the
// thread_desired_state contract) into runx thread_outbox_provider frames. This
// engine knows only threads, labels, lifecycle, and comments. It carries NO
// notion of the source's domain: `identity_key` and `ref` are opaque, and the
// only tenant-specific value is `source`, supplied by the caller as config.
//
// One desired thread reconciles through up to three frame kinds, in order:
//   1. provider_thread_create     - find-or-create the issue (only when the
//                                   source has no known locator)
//   2. provider_thread_lifecycle  - set the full label set + open/closed state
//   3. message (xN)               - append any comment not already present
// The provider primitives are idempotent, so re-running converges with no churn.

const DEFAULT_ADAPTER_ID = "runx-github-thread-adapter";
const DEFAULT_SOURCE_ID = "tenant";
const PROTOCOL_VERSION = "runx.thread_outbox_provider.v1";

export function buildCreateFrame(thread, options = {}) {
  const t = normalizeThread(thread);
  const sourceId = firstNonEmptyString(options.sourceId, DEFAULT_SOURCE_ID);
  const pending = pendingLocator(t);
  const existingIssueRef = existingIssueRefFromLocator(t.thread_locator);
  const threadFrame = existingIssueRef
    ? locatedThreadFrame(t, existingIssueRef, sourceId)
    : {
        kind: "runx.thread.v1",
        adapter: {
          type: "github",
          provider: "github",
          surface: "issue_thread",
          adapter_ref: `${t.target_repo}#issue/new:${t.identity_key}`,
        },
        thread_kind: "signal",
        thread_locator: pending.locator,
        canonical_uri: pending.uri,
        title: t.title,
        metadata: {
          repo: t.target_repo,
          source: sourceId,
          source_ref: t.identity_key,
          pending_provider_thread: true,
        },
        entries: [],
        decisions: [],
        outbox: [],
        source_refs: [
          { type: "provider_repository", uri: `https://github.com/${t.target_repo}`, provider: "github" },
        ],
        generated_at: new Date().toISOString(),
      };
  const outboxEntry = {
    entry_id: t.identity_key,
    kind: "provider_thread_create",
    status: "pending",
    thread_locator: existingIssueRef?.thread_locator ?? pending.locator,
    title: t.title,
    metadata: prune({
      schema_version: "runx.outbox-entry.provider-thread-create.v1",
      channel: "github_issue",
      source: sourceId,
      source_ref: t.identity_key,
      action: "create",
      target_repo: t.target_repo,
      title: t.title,
      body_markdown: sanitizePublicMarkdown(t.body),
      labels: t.labels,
      dedupe_key: t.identity_key,
      outbox_receipt_id: t.identity_key,
    }),
  };
  return buildFrame({
    pushId: `thread-reconcile:${t.identity_key}:create`,
    idempotencyKey: `${t.identity_key}:create`,
    adapterId: options.adapterId,
    threadLocator: existingIssueRef
      ? providerThreadLocator(existingIssueRef)
      : { type: "provider_thread_target", provider: "github", uri: pending.uri, locator: pending.locator },
    outboxEntryId: t.identity_key,
    thread: threadFrame,
    outboxEntry,
  });
}

export function buildLifecycleFrame(thread, locator, options = {}) {
  const t = normalizeThread(thread);
  const sourceId = firstNonEmptyString(options.sourceId, DEFAULT_SOURCE_ID);
  const issueRef = parseGitHubIssueRef(locator);
  const desired = new Set(t.labels);
  const removeLabels = t.managed_labels.filter((label) => !desired.has(label));
  const action = t.state === "open" ? "open" : "close";
  const outboxEntry = {
    entry_id: `${t.identity_key}:lifecycle`,
    kind: "provider_thread_lifecycle",
    status: "pending",
    thread_locator: issueRef.thread_locator,
    metadata: prune({
      schema_version: "runx.outbox-entry.provider-thread-lifecycle.v1",
      channel: "github_issue",
      source: sourceId,
      source_ref: t.identity_key,
      action,
      add_labels: t.labels,
      remove_labels: removeLabels,
      close_reason: action === "close" ? t.close_reason ?? "completed" : undefined,
    }),
  };
  return buildFrame({
    pushId: `thread-reconcile:${t.identity_key}:lifecycle`,
    idempotencyKey: `${t.identity_key}:lifecycle`,
    adapterId: options.adapterId,
    threadLocator: providerThreadLocator(issueRef),
    outboxEntryId: `${t.identity_key}:lifecycle`,
    thread: locatedThreadFrame(t, issueRef, sourceId),
    outboxEntry,
  });
}

export function buildMessageFrame(thread, comment, locator, options = {}) {
  const t = normalizeThread(thread);
  const sourceId = firstNonEmptyString(options.sourceId, DEFAULT_SOURCE_ID);
  const issueRef = parseGitHubIssueRef(locator);
  const entryId = requiredString(comment?.entry_id, "comment.entry_id");
  const body = requiredString(comment?.body, "comment.body");
  const outboxEntry = {
    entry_id: entryId,
    kind: "message",
    status: "pending",
    thread_locator: issueRef.thread_locator,
    metadata: prune({
      schema_version: "runx.outbox-entry.message.v1",
      channel: "github_issue_comment",
      source: sourceId,
      source_ref: t.identity_key,
      body_markdown: sanitizePublicMarkdown(body),
      outbox_receipt_id: firstNonEmptyString(comment.receipt_ref, entryId),
    }),
  };
  return buildFrame({
    pushId: `thread-reconcile:${entryId}`,
    idempotencyKey: entryId,
    adapterId: options.adapterId,
    threadLocator: providerThreadLocator(issueRef),
    outboxEntryId: entryId,
    thread: locatedThreadFrame(t, issueRef, sourceId),
    outboxEntry,
  });
}

export function normalizeThread(thread) {
  if (!isRecord(thread)) {
    throw new Error("desired thread state must be an object.");
  }
  const provider = requiredString(thread.provider, "thread.provider");
  if (provider !== "github") {
    throw new Error(`unsupported thread provider '${provider}'.`);
  }
  return {
    provider,
    target_repo: requiredString(thread.target_repo, "thread.target_repo"),
    identity_key: requiredString(thread.identity_key, "thread.identity_key"),
    thread_locator: firstNonEmptyString(thread.thread_locator),
    title: requiredString(thread.title, "thread.title"),
    body: requiredString(thread.body, "thread.body"),
    labels: stringList(thread.labels),
    managed_labels: stringList(thread.managed_labels),
    state: thread.state === "closed" ? "closed" : "open",
    close_reason: firstNonEmptyString(thread.close_reason),
    comments: Array.isArray(thread.comments) ? thread.comments.filter(isRecord) : [],
    ref: isRecord(thread.ref) ? thread.ref : undefined,
  };
}

function locatedThreadFrame(t, issueRef, sourceId) {
  return {
    kind: "runx.thread.v1",
    adapter: {
      type: "github",
      provider: "github",
      surface: "issue_thread",
      adapter_ref: issueRef.adapter_ref,
    },
    thread_kind: "signal",
    thread_locator: issueRef.thread_locator,
    canonical_uri: issueRef.issue_url,
    title: t.title,
    metadata: {
      repo: issueRef.repo_slug,
      issue_number: issueRef.issue_number,
      source: sourceId,
      source_ref: t.identity_key,
    },
    entries: [],
    decisions: [],
    outbox: [],
    source_refs: [{ type: "provider_thread", uri: issueRef.issue_url, provider: "github" }],
    generated_at: new Date().toISOString(),
  };
}

function buildFrame({ pushId, idempotencyKey, adapterId, threadLocator, outboxEntryId, thread, outboxEntry }) {
  // The reconciler has already compared a live provider snapshot before it
  // emits a mutation frame. Mutation primitives still perform the narrow reads
  // they need for idempotency, but the provider must not hydrate the complete
  // GitHub thread before and after every write. Those hydrations use GraphQL and
  // make an otherwise REST-backed board sync depend on a shared GraphQL quota.
  const body = JSON.stringify({
    thread,
    outbox_entry: outboxEntry,
    provider_readback: "mutation_only",
  });
  return {
    protocol_version: PROTOCOL_VERSION,
    push_id: pushId,
    adapter_id: firstNonEmptyString(adapterId, DEFAULT_ADAPTER_ID),
    provider: "github",
    thread_locator: threadLocator,
    outbox_entry_id: outboxEntryId,
    idempotency: { key: idempotencyKey, content_hash: sha256Prefixed(body) },
    credential_delivery_refs: [
      {
        type: "credential",
        uri: "runx:credential-delivery:github-cli-token",
        provider: "github",
        proof_kind: "credential_resolution",
      },
    ],
    payload: { format: "json", body, body_sha256: sha256Prefixed(body) },
  };
}

function providerThreadLocator(issueRef) {
  return {
    type: "provider_thread",
    provider: "github",
    uri: issueRef.issue_url,
    locator: issueRef.thread_locator,
  };
}

function pendingLocator(t) {
  const encodedKey = encodeURIComponent(t.identity_key);
  return {
    uri: `https://github.com/${t.target_repo}/issues/new`,
    locator: `github://${t.target_repo}/issues/new/${encodedKey}`,
  };
}

function existingIssueRefFromLocator(locator) {
  const value = firstNonEmptyString(locator);
  if (!value) return undefined;
  try {
    return parseGitHubIssueRef(value);
  } catch {
    return undefined;
  }
}

function requiredString(value, label) {
  const text = firstNonEmptyString(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => firstNonEmptyString(entry)).filter(Boolean);
}

function sha256Prefixed(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

import { createHash } from "node:crypto";
import {
  firstNonEmptyString,
  isRecord,
  parseGitHubIssueRef,
  prune,
} from "./github_adapter.mjs";
import { sanitizePublicMarkdown } from "../public_markdown.mjs";

const DEFAULT_ADAPTER_ID = "runx-github-thread-adapter";

export function buildFranticThreadProviderPush(intent, options = {}) {
  const normalized = normalizeFranticThreadIntent(intent);
  if (normalized.provider !== "github") {
    throw new Error(`unsupported Frantic thread provider '${normalized.provider}'.`);
  }

  const issueRef = parseGitHubIssueRef(normalized.thread_locator);
  const thread = buildGitHubThreadFrame(normalized, issueRef);
  const outboxEntry = buildGitHubOutboxEntry(normalized);
  const body = JSON.stringify({
    thread,
    outbox_entry: outboxEntry,
  });

  return {
    protocol_version: "runx.thread_outbox_provider.v1",
    push_id: `frantic-thread-push:${normalized.outbox_id}`,
    adapter_id: firstNonEmptyString(options.adapterId, DEFAULT_ADAPTER_ID),
    provider: normalized.provider,
    thread_locator: {
      type: "provider_thread",
      provider: normalized.provider,
      uri: issueRef.issue_url,
      locator: issueRef.thread_locator,
    },
    outbox_entry_id: outboxEntry.entry_id,
    idempotency: {
      key: normalized.outbox_id,
      content_hash: sha256Prefixed(body),
    },
    credential_delivery_refs: [
      {
        type: "credential",
        uri: "runx:credential-delivery:github-cli-token",
        provider: "github",
        proof_kind: "credential_resolution",
      },
    ],
    payload: {
      format: "json",
      body,
      body_sha256: sha256Prefixed(body),
    },
  };
}

export function normalizeFranticThreadIntent(intent) {
  if (!isRecord(intent)) {
    throw new Error("Frantic thread intent must be an object.");
  }
  const kind = requiredString(intent.kind, "intent.kind");
  const provider = requiredString(intent.provider, "intent.provider");
  const outboxId = requiredString(intent.outbox_id, "intent.outbox_id");
  const threadLocator = requiredString(intent.thread_locator, "intent.thread_locator");
  const sourceRef = requiredString(intent.source_ref, "intent.source_ref");
  const bountyUrl = requiredString(intent.bounty_url, "intent.bounty_url");
  const postingId = requiredString(intent.posting_id, "intent.posting_id");
  const bountyNumber = requiredPositiveInteger(intent.bounty_number, "intent.bounty_number");
  const occurredAt = requiredString(intent.occurred_at, "intent.occurred_at");

  if (!["thread.comment", "thread.labels", "thread.close"].includes(kind)) {
    throw new Error(`unsupported Frantic thread intent kind '${kind}'.`);
  }

  return prune({
    kind,
    provider,
    outbox_id: outboxId,
    thread_locator: threadLocator,
    source: firstNonEmptyString(intent.source, "frantic"),
    source_ref: sourceRef,
    event_id: requiredPositiveInteger(intent.event_id, "intent.event_id"),
    occurred_at: occurredAt,
    room: firstNonEmptyString(intent.room, "town"),
    posting_id: postingId,
    bounty_number: bountyNumber,
    bounty_url: bountyUrl,
    receipt_ref: firstNonEmptyString(intent.receipt_ref),
    receipt_url: firstNonEmptyString(intent.receipt_url),
    claim_id: firstNonEmptyString(intent.claim_id),
    body: kind === "thread.comment" ? requiredString(intent.body, "intent.body") : undefined,
    add_labels: kind === "thread.labels" ? stringList(intent.add_labels) : undefined,
    remove_labels: kind === "thread.labels" ? stringList(intent.remove_labels) : undefined,
    reason: kind === "thread.close" ? firstNonEmptyString(intent.reason, "completed") : undefined,
  });
}

function buildGitHubThreadFrame(intent, issueRef) {
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
    title: `Frantic bounty #${intent.bounty_number}`,
    metadata: {
      repo: issueRef.repo_slug,
      issue_number: issueRef.issue_number,
      source: "frantic",
      source_ref: intent.source_ref,
    },
    entries: [],
    decisions: [],
    outbox: [],
    source_refs: [
      {
        type: "provider_thread",
        uri: issueRef.issue_url,
        provider: "github",
      },
      {
        type: "receipt",
        uri: intent.receipt_ref ?? intent.source_ref,
        provider: "frantic",
      },
    ],
    generated_at: new Date().toISOString(),
  };
}

function buildGitHubOutboxEntry(intent) {
  if (intent.kind === "thread.comment") {
    return {
      entry_id: intent.outbox_id,
      kind: "message",
      status: "pending",
      thread_locator: intent.thread_locator,
      metadata: prune({
        schema_version: "runx.outbox-entry.message.v1",
        channel: "github_issue_comment",
        source: "frantic",
        source_ref: intent.source_ref,
        body_markdown: renderFranticThreadComment(intent),
        outbox_receipt_id: intent.receipt_ref ?? intent.outbox_id,
        frantic_intent_kind: intent.kind,
        bounty_number: String(intent.bounty_number),
        posting_id: intent.posting_id,
        claim_id: intent.claim_id,
      }),
    };
  }

  return {
    entry_id: intent.outbox_id,
    kind: "provider_thread_lifecycle",
    status: "pending",
    thread_locator: intent.thread_locator,
    metadata: prune({
      schema_version: "runx.outbox-entry.provider-thread-lifecycle.v1",
      channel: "github_issue",
      source: "frantic",
      source_ref: intent.source_ref,
      action: intent.kind === "thread.labels" ? "labels" : "close",
      add_labels: intent.add_labels,
      remove_labels: intent.remove_labels,
      close_reason: intent.reason,
      receipt_ref: intent.receipt_ref,
      receipt_url: intent.receipt_url,
      bounty_url: intent.bounty_url,
      bounty_number: String(intent.bounty_number),
      posting_id: intent.posting_id,
      claim_id: intent.claim_id,
    }),
  };
}

function renderFranticThreadComment(intent) {
  const lines = [
    sanitizePublicMarkdown(intent.body),
    "",
    `Bounty: ${intent.bounty_url}`,
    intent.receipt_url ? `Receipt: ${intent.receipt_url}` : undefined,
  ].filter((line) => line !== undefined);
  return lines.join("\n").trim();
}

function requiredString(value, label) {
  const text = firstNonEmptyString(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function requiredPositiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
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

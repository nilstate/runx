#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  fetchGitHubIssueThread,
  firstNonEmptyString,
  isRecord,
  optionalRecord,
  prune,
  pushGitHubCreateIssue,
  pushGitHubMessage,
  pushGitHubLifecycleIntent,
  pushGitHubPullRequest,
} from "../github_adapter.mjs";

try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const payload = providerPayload(request);
  const thread = asRecord(payload.thread, "payload.thread");
  const outboxEntry = asRecord(payload.outbox_entry, "payload.outbox_entry");
  const draftPullRequest = optionalRecord(payload.draft_pull_request);
  const workspacePath = firstNonEmptyString(payload.workspace_path, payload.fixture);
  const nextStatus = firstNonEmptyString(payload.next_status);
  const kind = firstNonEmptyString(outboxEntry.kind);
  const env = process.env;
  const adapter = optionalRecord(thread.adapter);
  const adapterRef = firstNonEmptyString(adapter?.adapter_ref);
  const pendingProviderThread = optionalRecord(thread.metadata)?.pending_provider_thread === true;
  const shouldUseLiveProvider = isGitHubThreadAdapter(adapter);
  const mutationOnlyReadback = payload.provider_readback === "mutation_only";

  if (!shouldUseLiveProvider) {
    writeJson({
      observation: observationFor({
        request,
        locator: undefined,
        status: "skipped",
        idempotencyStatus: "skipped",
        reason: "thread adapter is not github",
      }),
      output: skippedProviderOutput({
        request,
        thread,
        outboxEntry,
        draftPullRequest,
        reason: "thread adapter is not github",
      }),
    });
    process.exit(0);
  }

  const pushThread = adapterRef && !pendingProviderThread && !mutationOnlyReadback
    ? fetchGitHubIssueThread({ adapterRef, env, cwd: workspacePath ?? process.cwd() })
    : thread;

  let result;
  if (kind === "pull_request") {
    result = pushGitHubPullRequest({
      thread: pushThread,
      draftPullRequest,
      outboxEntry,
      workspacePath,
      nextStatus,
      env,
    });
  } else if (kind === "provider_thread_create") {
    result = pushGitHubCreateIssue({
      thread: pushThread,
      outboxEntry,
      workspacePath,
      nextStatus,
      env,
    });
  } else if (kind === "message") {
    result = pushGitHubMessage({
      thread: pushThread,
      outboxEntry,
      workspacePath,
      nextStatus,
      env,
    });
  } else if (kind === "provider_thread_lifecycle") {
    result = pushGitHubLifecycleIntent({
      thread: pushThread,
      outboxEntry,
      workspacePath,
      nextStatus,
      env,
    });
  } else {
    throw new Error(`unsupported GitHub outbox entry kind '${kind ?? "unknown"}'`);
  }

  const refreshedThread = adapterRef && !pendingProviderThread && !mutationOnlyReadback
    ? fetchGitHubIssueThread({ adapterRef, env, cwd: workspacePath ?? process.cwd() })
    : mutationOnlyReadback
      ? undefined
      : pushThread;
  const pushedEntry = optionalRecord(result.outbox_entry) ?? outboxEntry;
  const locator = firstNonEmptyString(
    pushedEntry.locator,
    optionalRecord(result.message)?.locator,
    optionalRecord(result.provider_thread)?.locator,
    optionalRecord(result.pull_request)?.url,
    request.thread_locator?.locator,
  );

  writeJson({
    observation: observationFor({ request, locator }),
    output: prune({
      draft_pull_request: draftPullRequest,
      outbox_entry: pushedEntry,
      thread: refreshedThread,
      push: prune({
        status: "pushed",
        provider: request.provider,
        adapter: optionalRecord(thread.adapter),
        locator,
        message: optionalRecord(result.message),
        provider_thread: optionalRecord(result.provider_thread),
        lifecycle: optionalRecord(result.lifecycle),
        pull_request: optionalRecord(result.pull_request),
      }),
    }),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function providerPayload(request) {
  if (!isRecord(request?.payload) || request.payload.format !== "json") {
    throw new Error("thread-outbox-provider GitHub process requires JSON payload frames.");
  }
  const parsed = JSON.parse(String(request.payload.body ?? ""));
  return asRecord(parsed, "payload.body");
}

function observationFor({
  request,
  locator,
  status = "accepted",
  idempotencyStatus = "created",
  reason,
}) {
  const observedAt = new Date().toISOString();
  const providerLocator = locator
    ? {
        provider: request.provider,
        locator,
        provider_ref: locator.startsWith("http")
          ? {
              type: "external_url",
              uri: locator,
              provider: request.provider,
            }
          : undefined,
      }
    : undefined;

  return prune({
    schema: "runx.thread_outbox_provider.observation.v1",
    protocol_version: "runx.thread_outbox_provider.v1",
    observation_id: `thread_obs_${hashFragment(`${request.push_id}:${locator ?? ""}`, 24)}`,
    adapter_id: request.adapter_id,
    provider: request.provider,
    operation: "push",
    request_id: request.push_id,
    status,
    idempotency: {
      key: request.idempotency?.key,
      status: idempotencyStatus,
    },
    provider_locator: providerLocator,
    provider_event_id_hash: locator ? sha256Prefixed(locator) : undefined,
    readback_summary: locator
      ? {
          item_count: 1,
          latest_provider_event_id_hash: sha256Prefixed(locator),
        }
      : undefined,
    redaction_refs: [
      {
        type: "redaction_policy",
        uri: "runx:redaction_policy:provider-output",
      },
    ],
    errors: reason
      ? [
          {
            code: "provider_skipped",
            message: reason,
            retryable: false,
          },
        ]
      : undefined,
    observed_at: observedAt,
  });
}

function skippedProviderOutput({
  request,
  thread,
  outboxEntry,
  draftPullRequest,
  reason,
}) {
  return prune({
    draft_pull_request: draftPullRequest,
    outbox_entry: outboxEntry,
    thread,
    push: {
      status: "skipped",
      provider: request.provider,
      adapter: optionalRecord(thread.adapter),
      reason,
    },
  });
}

function isGitHubThreadAdapter(adapter) {
  if (!adapter) {
    return true;
  }
  const type = firstNonEmptyString(adapter.type);
  const provider = firstNonEmptyString(adapter.provider);
  if (type && type !== "github") {
    return false;
  }
  if (provider && provider !== "github") {
    return false;
  }
  return true;
}

function asRecord(value, field) {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function hashFragment(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sha256Prefixed(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFranticThreadProviderPush } from "../tools/thread/frantic_thread_outbox.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_SCRIPT = path.join(__dirname, "../tools/thread/thread_outbox_provider/github-provider.mjs");

async function main() {
  const config = readConfig(process.env);
  const afterEventId = readCursor(config.cursorFile) ?? config.afterEventId;
  const payload = await fetchThreadOutbox({ ...config, afterEventId });
  const intents = Array.isArray(payload.intents) ? payload.intents : [];
  let maxEventId = afterEventId;
  const observations = [];
  const results = [];

  for (const intent of intents) {
    const frame = buildFranticThreadProviderPush(intent, { adapterId: config.adapterId });
    if (config.dryRun) {
      results.push({ outbox_id: intent.outbox_id, dry_run: true });
      maxEventId = Math.max(maxEventId, numberOrZero(intent.event_id));
      continue;
    }

    const pushed = runGitHubProvider(frame, config.env);
    results.push({
      outbox_id: intent.outbox_id,
      kind: intent.kind,
      locator: pushed.output?.outbox_entry?.locator ?? pushed.observation?.provider_locator?.locator,
    });
    const observation = franticObservationFor(intent, pushed);
    if (observation) {
      observations.push(observation);
    }
    maxEventId = Math.max(maxEventId, numberOrZero(intent.event_id));
  }

  if (!config.dryRun && observations.length > 0) {
    await postThreadObservations(config, observations);
  }
  if (!config.dryRun && config.cursorFile && maxEventId > afterEventId) {
    writeFileSync(config.cursorFile, `${maxEventId}\n`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fetched: intents.length,
    observed: observations.length,
    after_event_id: afterEventId,
    next_after_event_id: maxEventId,
    results,
  })}\n`);
}

function readConfig(env) {
  const apiBaseUrl = trim(env.FRANTIC_API_BASE_URL) ?? "https://api.gofrantic.com";
  const internalSyncSecret = trim(env.FRANTIC_INTERNAL_SYNC_SECRET ?? env.INTERNAL_SYNC_SECRET);
  if (!internalSyncSecret) {
    throw new Error("FRANTIC_INTERNAL_SYNC_SECRET or INTERNAL_SYNC_SECRET is required.");
  }
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    internalSyncSecret,
    provider: trim(env.FRANTIC_THREAD_PROVIDER) ?? "github",
    targetRepo: trim(env.FRANTIC_GITHUB_TARGET_REPO ?? env.FRANTIC_BOARD_REPO),
    limit: positiveInteger(env.FRANTIC_THREAD_LIMIT, 50),
    afterEventId: positiveInteger(env.FRANTIC_THREAD_AFTER_EVENT_ID, 0),
    cursorFile: trim(env.FRANTIC_THREAD_CURSOR_FILE),
    adapterId: trim(env.FRANTIC_THREAD_ADAPTER_ID) ?? "runx-github-thread-adapter",
    dryRun: env.FRANTIC_THREAD_DRY_RUN === "1" || env.FRANTIC_THREAD_DRY_RUN === "true",
    env,
  };
}

async function fetchThreadOutbox(config) {
  const url = new URL("/internal/thread-outbox", config.apiBaseUrl);
  url.searchParams.set("provider", config.provider);
  url.searchParams.set("after_event_id", String(config.afterEventId));
  url.searchParams.set("limit", String(config.limit));
  if (config.targetRepo) {
    url.searchParams.set("target_repo", config.targetRepo);
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${config.internalSyncSecret}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Frantic thread outbox fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function runGitHubProvider(frame, env) {
  const child = spawnSync(process.execPath, [PROVIDER_SCRIPT], {
    input: JSON.stringify(frame),
    encoding: "utf8",
    env: env ?? process.env,
  });
  if (child.status !== 0) {
    throw new Error([
      `GitHub thread provider failed for ${frame.outbox_entry_id}.`,
      child.stderr.trim(),
      child.stdout.trim(),
    ].filter(Boolean).join("\n"));
  }
  return JSON.parse(child.stdout);
}

async function postThreadObservations(config, observations) {
  const response = await fetch(new URL("/internal/thread-observations", config.apiBaseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.internalSyncSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schema_version: 1,
      observations,
    }),
  });
  if (!response.ok) {
    throw new Error(`Frantic thread observation post failed: ${response.status} ${await response.text()}`);
  }
}

function franticObservationFor(intent, pushed) {
  const outboxEntry = pushed.output?.outbox_entry;
  const providerThread = pushed.output?.push?.provider_thread;
  const metadata = outboxEntry?.metadata ?? {};
  const threadLocator = outboxEntry?.thread_locator ?? providerThread?.thread_locator;
  const threadUrl = outboxEntry?.locator ?? providerThread?.locator;
  if (!threadLocator || !threadUrl) {
    return undefined;
  }
  return {
    schema_version: 1,
    provider: intent.provider,
    ...(intent.target_repo || metadata.target_repo ? { target_repo: intent.target_repo ?? metadata.target_repo } : {}),
    posting_id: intent.posting_id,
    bounty_number: intent.bounty_number,
    thread_locator: threadLocator,
    thread_url: threadUrl,
    ...(metadata.provider_thread_id || providerThread?.issue_number
      ? { provider_thread_id: String(metadata.provider_thread_id ?? providerThread.issue_number) }
      : {}),
    source_ref: intent.source_ref,
    event_id: intent.event_id,
    observed_at: new Date().toISOString(),
  };
}

function readCursor(cursorFile) {
  if (!cursorFile || !existsSync(cursorFile)) {
    return undefined;
  }
  return positiveInteger(readFileSync(cursorFile, "utf8"), 0);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function numberOrZero(value) {
  return positiveInteger(value, 0);
}

function trim(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

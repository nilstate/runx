import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashStable, type ThreadAdapterDescriptor } from "./internal-validators.js";
import {
  validateOutboxEntry,
  type OutboxEntry,
  type OutboxEntryStatus,
} from "./outbox.js";
import {
  validateThread,
  type PushOutboxEntryRequest,
  type PushOutboxEntryResult,
  type Thread,
  type ThreadEntry,
  type ThreadFetchRequest,
} from "./thread.js";

export async function fetchThreadViaAdapter(
  descriptor: ThreadAdapterDescriptor,
  request: ThreadFetchRequest,
): Promise<Thread | undefined> {
  switch (descriptor.type) {
    case "file":
      return await fetchFileThread(descriptor, request);
    default:
      return undefined;
  }
}

export async function pushOutboxEntryViaAdapter(
  request: PushOutboxEntryRequest,
): Promise<PushOutboxEntryResult> {
  if (request.thread.adapter.type !== "file") {
    return {
      status: "skipped",
      reason: `no thread adapter is registered for '${request.thread.adapter.type}'`,
      outbox_entry: request.entry,
      thread: request.thread,
    };
  }

  const outboxEntry = await pushFileThread(request);
  const thread = await fetchThreadViaAdapter(request.thread.adapter, {
    thread_kind: request.thread.thread_kind,
    thread_locator: request.thread.thread_locator,
    cursor: request.thread.adapter.cursor,
    include_outbox: true,
  });
  return {
    status: "pushed",
    outbox_entry: outboxEntry,
    thread: thread ?? request.thread,
  };
}

async function fetchFileThread(
  descriptor: ThreadAdapterDescriptor,
  request: ThreadFetchRequest,
): Promise<Thread> {
  const adapterRef = descriptor.adapter_ref;
  if (!adapterRef) {
    throw new Error(`thread adapter '${descriptor.type}' requires adapter_ref.`);
  }
  const statePath = resolveAdapterRefPath(adapterRef);
  const state = validateThread(JSON.parse(await readFile(statePath, "utf8")) as unknown);
  if (
    state.thread_kind !== request.thread_kind
    || state.thread_locator !== request.thread_locator
  ) {
    throw new Error(
      `thread at ${statePath} does not match ${request.thread_kind}:${request.thread_locator}.`,
    );
  }
  return request.include_outbox === false
    ? { ...state, outbox: [] }
    : state;
}

async function pushFileThread(request: PushOutboxEntryRequest): Promise<OutboxEntry> {
  const adapterRef = request.thread.adapter.adapter_ref;
  if (!adapterRef) {
    throw new Error(`thread adapter '${request.thread.adapter.type}' requires adapter_ref.`);
  }
  const statePath = resolveAdapterRefPath(adapterRef);
  const adapterUri = pathToFileURL(statePath).href;
  const current = validateThread(JSON.parse(await readFile(statePath, "utf8")) as unknown);
  const pushedAt = new Date().toISOString();
  const outboxEntry = normalizePushedOutboxEntry({
    entry: request.entry,
    current,
    nextStatus: request.next_status,
    adapterUri,
  });
  const eventEntry: ThreadEntry = {
    entry_id: `entry_${hashStable({
      thread: current.thread_locator,
      outbox_entry: outboxEntry.entry_id,
      pushed_at: pushedAt,
    }).slice(0, 24)}`,
    entry_kind: "status",
    recorded_at: pushedAt,
    body: `Pushed ${outboxEntry.kind} ${outboxEntry.entry_id}`,
    structured_data: {
      event: "push_outbox_entry",
      outbox_entry_id: outboxEntry.entry_id,
      kind: outboxEntry.kind,
      locator: outboxEntry.locator,
      status: outboxEntry.status,
    },
    source_ref: {
      type: "thread_adapter",
      uri: adapterUri,
      recorded_at: pushedAt,
    },
  };
  const outboxEntries = upsertOutboxEntry(current.outbox, outboxEntry);
  const nextState = validateThread({
    ...current,
    adapter: {
      ...current.adapter,
      adapter_ref: current.adapter.adapter_ref ?? adapterUri,
      cursor: `push:${hashStable({ outbox_entry: outboxEntry.entry_id, pushed_at: pushedAt }).slice(0, 12)}`,
    },
    entries: [...current.entries, eventEntry],
    outbox: outboxEntries,
    generated_at: pushedAt,
    watermark: outboxEntry.entry_id,
  });
  await writeThreadFile(statePath, nextState);
  return outboxEntry;
}

function resolveAdapterRefPath(adapterRef: string): string {
  if (adapterRef.startsWith("file://")) {
    return path.resolve(fileURLToPath(adapterRef));
  }
  return path.resolve(adapterRef);
}

function normalizePushedOutboxEntry(options: {
  readonly entry: OutboxEntry;
  readonly current: Thread;
  readonly nextStatus?: OutboxEntryStatus;
  readonly adapterUri: string;
}): OutboxEntry {
  const { entry, current, nextStatus, adapterUri } = options;
  const existing = current.outbox.find((candidate) =>
    candidate.entry_id === entry.entry_id
    || (typeof entry.locator === "string" && entry.locator.length > 0 && candidate.locator === entry.locator)
    || (
      candidate.kind === entry.kind
      && (candidate.thread_locator ?? current.thread_locator)
        === (entry.thread_locator ?? current.thread_locator)
    )
  );
  return validateOutboxEntry({
    ...existing,
    ...entry,
    locator: entry.locator ?? existing?.locator ?? `${adapterUri}#outbox/${encodeURIComponent(entry.entry_id)}`,
    status: nextStatus ?? entry.status ?? existing?.status ?? "draft",
    thread_locator: entry.thread_locator ?? existing?.thread_locator ?? current.thread_locator,
  });
}

function upsertOutboxEntry(
  outbox: readonly OutboxEntry[],
  entry: OutboxEntry,
): readonly OutboxEntry[] {
  const filtered = outbox.filter((candidate) =>
    candidate.entry_id !== entry.entry_id
    && candidate.locator !== entry.locator
    && !(
      candidate.kind === entry.kind
      && (candidate.thread_locator ?? "") === (entry.thread_locator ?? "")
    ),
  );
  return [...filtered, entry];
}

async function writeThreadFile(statePath: string, state: Thread): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, statePath);
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  fetchGitHubIssueSubjectMemory,
  firstNonEmptyString,
  isRecord,
  optionalRecord,
  pushGitHubPullRequest,
} from "../github_adapter.mjs";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const subjectMemory = isRecord(inputs.subject_memory) ? inputs.subject_memory : undefined;
const outboxEntry = unwrapArtifactData(inputs.outbox_entry, "outbox_entry");
const draftPullRequest = isRecord(inputs.draft_pull_request)
  ? unwrapArtifactData(inputs.draft_pull_request, "draft_pull_request")
  : undefined;
const nextStatus = firstNonEmptyString(inputs.next_status);
const workspacePath = firstNonEmptyString(inputs.workspace_path, inputs.fixture, process.env.RUNX_CWD);

if (!subjectMemory) {
  process.stdout.write(JSON.stringify({
    draft_pull_request: draftPullRequest,
    outbox_entry: outboxEntry,
    push: {
      status: "skipped",
      reason: "subject_memory not provided",
    },
  }));
  process.exit(0);
}

const adapter = isRecord(subjectMemory.adapter) ? subjectMemory.adapter : {};
const adapterType = firstNonEmptyString(adapter.type);
const adapterRef = firstNonEmptyString(adapter.adapter_ref);

if (!adapterType) {
  throw new Error("subject_memory.adapter.type is required.");
}

if (adapterType === "github") {
  if (!adapterRef) {
    process.stdout.write(JSON.stringify({
      draft_pull_request: draftPullRequest,
      outbox_entry: outboxEntry,
      subject_memory: subjectMemory,
      push: {
        status: "skipped",
        reason: `subject_memory adapter '${adapterType}' requires adapter_ref.`,
        adapter: {
          type: adapterType,
        },
      },
    }));
    process.exit(0);
  }
  if (!workspacePath) {
    process.stdout.write(JSON.stringify({
      draft_pull_request: draftPullRequest,
      outbox_entry: outboxEntry,
      subject_memory: subjectMemory,
      push: {
        status: "skipped",
        reason: "workspace_path is required for the GitHub subject-memory adapter.",
        adapter: {
          type: adapterType,
          adapter_ref: adapterRef,
        },
      },
    }));
    process.exit(0);
  }
  if (!draftPullRequest) {
    process.stdout.write(JSON.stringify({
      outbox_entry: outboxEntry,
      subject_memory: subjectMemory,
      push: {
        status: "skipped",
        reason: "draft_pull_request is required to push through the GitHub subject-memory adapter.",
        adapter: {
          type: adapterType,
          adapter_ref: adapterRef,
        },
      },
    }));
    process.exit(0);
  }
  const pushed = pushGitHubPullRequest({
    subjectMemory,
    draftPullRequest,
    outboxEntry,
    workspacePath,
    nextStatus,
    env: process.env,
  });
  const refreshedMemory = fetchGitHubIssueSubjectMemory({
    adapterRef,
    env: process.env,
    cwd: workspacePath,
  });
  const refreshedOutboxEntry = selectMatchingOutboxEntry(
    refreshedMemory,
    pushed.outbox_entry,
  ) ?? pushed.outbox_entry;

  process.stdout.write(JSON.stringify({
    draft_pull_request: draftPullRequest,
    outbox_entry: refreshedOutboxEntry,
    subject_memory: refreshedMemory,
    push: {
      status: "pushed",
      adapter: {
        type: adapterType,
        adapter_ref: adapterRef,
      },
      pushed_at: firstNonEmptyString(optionalRecord(refreshedOutboxEntry.metadata)?.pushed_at),
      pull_request: {
        number: firstNonEmptyString(pushed.pull_request.number),
        url: firstNonEmptyString(pushed.pull_request.url),
      },
    },
  }));
  process.exit(0);
}

if (adapterType !== "file" && adapterType !== "file_subject_memory") {
  process.stdout.write(JSON.stringify({
    draft_pull_request: draftPullRequest,
    outbox_entry: outboxEntry,
    subject_memory: subjectMemory,
    push: {
      status: "skipped",
      reason: `no subject memory adapter is registered for '${adapterType}'`,
      adapter: {
        type: adapterType,
      },
    },
  }));
  process.exit(0);
}

if (!adapterRef) {
  throw new Error(`subject_memory adapter '${adapterType}' requires adapter_ref.`);
}

const memoryPath = resolveAdapterRefPath(adapterRef);
const adapterUri = pathToFileURL(memoryPath).href;
const currentMemory = asRecord(JSON.parse(await readFile(memoryPath, "utf8")), "subject_memory_file");
const currentSubject = asRecord(currentMemory.subject, "subject_memory_file.subject");
const subjectLocator = firstNonEmptyString(
  outboxEntry.subject_locator,
  currentSubject.subject_locator,
);

if (!subjectLocator) {
  throw new Error("subject locator is required to push an outbox entry.");
}

const existingOutbox = Array.isArray(currentMemory.subject_outbox) ? currentMemory.subject_outbox.filter(isRecord) : [];
const existing = existingOutbox.find((candidate) =>
  candidate.entry_id === outboxEntry.entry_id
  || (firstNonEmptyString(outboxEntry.locator) && candidate.locator === outboxEntry.locator)
  || (
    candidate.kind === outboxEntry.kind
    && firstNonEmptyString(candidate.subject_locator, currentSubject.subject_locator) === subjectLocator
  )
);
const pushedAt = new Date().toISOString();
const pushedEntry = {
  ...existing,
  ...outboxEntry,
  locator: firstNonEmptyString(
    outboxEntry.locator,
    existing?.locator,
    `${adapterUri}#outbox/${encodeURIComponent(String(outboxEntry.entry_id || ""))}`,
  ),
  status: firstNonEmptyString(nextStatus, outboxEntry.status, existing?.status, "draft"),
  subject_locator: subjectLocator,
};

const pushEvent = {
  entry_id: `entry_${hashStable({
    subject_locator: subjectLocator,
    outbox_entry_id: pushedEntry.entry_id,
    pushed_at: pushedAt,
  }).slice(0, 24)}`,
  entry_kind: "status",
  recorded_at: pushedAt,
  body: `Pushed ${pushedEntry.kind} ${pushedEntry.entry_id}`,
  structured_data: {
    event: "push_outbox_entry",
    outbox_entry_id: pushedEntry.entry_id,
    kind: pushedEntry.kind,
    locator: pushedEntry.locator,
    status: pushedEntry.status,
  },
  source_ref: {
    type: "subject_memory_adapter",
    uri: adapterUri,
    recorded_at: pushedAt,
  },
};
const refreshedMemory = {
  ...currentMemory,
  adapter: {
    ...adapter,
    adapter_ref: adapterRef,
    cursor: `push:${hashStable({ outbox_entry: pushedEntry.entry_id, pushed_at: pushedAt }).slice(0, 12)}`,
  },
  entries: [
    ...(Array.isArray(currentMemory.entries) ? currentMemory.entries : []),
    pushEvent,
  ],
  subject_outbox: upsertOutboxEntry(existingOutbox, pushedEntry),
  generated_at: pushedAt,
  watermark: pushedEntry.entry_id,
};

await writeSubjectMemoryFile(memoryPath, refreshedMemory);

process.stdout.write(JSON.stringify({
  draft_pull_request: draftPullRequest,
  outbox_entry: pushedEntry,
  subject_memory: refreshedMemory,
  push: {
    status: "pushed",
    adapter: {
      type: adapterType,
      adapter_ref: adapterRef,
    },
    pushed_at: pushedAt,
  },
}));

function asRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function unwrapArtifactData(value, label) {
  const record = asRecord(value, label);
  if (isRecord(record.data)) {
    return record.data;
  }
  return record;
}

function resolveAdapterRefPath(adapterRefValue) {
  if (adapterRefValue.startsWith("file://")) {
    return path.resolve(fileURLToPath(adapterRefValue));
  }
  return path.resolve(adapterRefValue);
}

function selectMatchingOutboxEntry(subjectMemoryValue, pushedEntry) {
  const subjectOutbox = Array.isArray(subjectMemoryValue?.subject_outbox) ? subjectMemoryValue.subject_outbox.filter(isRecord) : [];
  return subjectOutbox.find((candidate) =>
    candidate.entry_id === pushedEntry.entry_id
    || (firstNonEmptyString(pushedEntry.locator) && candidate.locator === pushedEntry.locator)
  );
}

function upsertOutboxEntry(existingEntries, entry) {
  const filtered = existingEntries.filter((candidate) =>
    candidate.entry_id !== entry.entry_id
    && candidate.locator !== entry.locator
    && !(
      candidate.kind === entry.kind
      && firstNonEmptyString(candidate.subject_locator) === firstNonEmptyString(entry.subject_locator)
    ),
  );
  return [...filtered, entry];
}

async function writeSubjectMemoryFile(memoryPath, memory) {
  await mkdir(path.dirname(memoryPath), { recursive: true });
  const tempPath = `${memoryPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, memoryPath);
}

function hashStable(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

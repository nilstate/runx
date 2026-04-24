import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  artifact,
  defineTool,
  optionalArtifact,
  recordInput,
  stringInput,
} from "@runxhq/authoring";
import {
  fetchGitHubIssueThread,
  firstNonEmptyString,
  isRecord,
  optionalRecord,
  pushGitHubMessage,
  pushGitHubPullRequest,
} from "../../github_adapter.mjs";

export default defineTool({
  name: "thread.push_outbox",
  description: "Push an outbox entry through the current thread adapter and return the refreshed thread.",
  inputs: {
    thread: recordInput({ optional: true, description: "Current hydrated thread for the bounded provider surface." }),
    outbox_entry: artifact({ description: "Outbox entry to push through the thread adapter." }),
    draft_pull_request: optionalArtifact({ description: "Provider-agnostic draft pull-request packet paired with the outbox entry." }),
    fixture: stringInput({ optional: true, description: "Optional governed workspace root inherited from issue-to-pr style lanes." }),
    workspace_path: stringInput({ optional: true, description: "Optional workspace root used by adapters that need local git state to publish outputs upstream." }),
    next_status: stringInput({ optional: true, description: "Optional status to apply after a successful provider push, such as `draft`." }),
  },
  scopes: ["thread:push"],
  run: runPushOutbox,
});

async function runPushOutbox({ inputs, env }) {
  const thread = isRecord(inputs.thread) ? inputs.thread : undefined;
  const outboxEntry = inputs.outbox_entry;
  const draftPullRequest = inputs.draft_pull_request;
  const nextStatus = firstNonEmptyString(inputs.next_status);
  const workspacePath = firstNonEmptyString(
    inputs.workspace_path,
    inputs.fixture,
    env.RUNX_CWD,
  );

  if (!thread) {
    return {
      draft_pull_request: draftPullRequest,
      outbox_entry: outboxEntry,
      push: {
        status: "skipped",
        reason: "thread not provided",
      },
    };
  }

  const adapter = isRecord(thread.adapter) ? thread.adapter : {};
  const adapterType = firstNonEmptyString(adapter.type);
  const adapterRef = firstNonEmptyString(adapter.adapter_ref);
  const outboxKind = firstNonEmptyString(outboxEntry.kind);

  if (!adapterType) {
    throw new Error("thread.adapter.type is required.");
  }

  if (adapterType === "github") {
    if (!adapterRef) {
      return {
        draft_pull_request: draftPullRequest,
        outbox_entry: outboxEntry,
        thread: thread,
        push: {
          status: "skipped",
          reason: `thread adapter '${adapterType}' requires adapter_ref.`,
          adapter: {
            type: adapterType,
          },
        },
      };
    }
    if (outboxKind === "message") {
      const pushed = pushGitHubMessage({
        thread,
        outboxEntry,
        workspacePath,
        nextStatus,
        env,
      });
      const refreshedState = fetchGitHubIssueThread({
        adapterRef,
        env,
        cwd: workspacePath,
      });
      const refreshedOutboxEntry =
        selectMatchingOutboxEntry(refreshedState, pushed.outbox_entry) ??
        pushed.outbox_entry;

      return {
        draft_pull_request: draftPullRequest,
        outbox_entry: refreshedOutboxEntry,
        thread: refreshedState,
        push: {
          status: "pushed",
          adapter: {
            type: adapterType,
            adapter_ref: adapterRef,
          },
          pushed_at: firstNonEmptyString(
            optionalRecord(refreshedOutboxEntry.metadata)?.pushed_at,
          ),
          message: {
            locator: firstNonEmptyString(
              refreshedOutboxEntry.locator,
              optionalRecord(refreshedOutboxEntry.metadata)?.locator,
            ),
            comment_id: firstNonEmptyString(
              optionalRecord(refreshedOutboxEntry.metadata)?.comment_id,
            ),
          },
        },
      };
    }
    if (!workspacePath) {
      return {
        draft_pull_request: draftPullRequest,
        outbox_entry: outboxEntry,
        thread: thread,
        push: {
          status: "skipped",
          reason: "workspace_path is required for the GitHub thread adapter.",
          adapter: {
            type: adapterType,
            adapter_ref: adapterRef,
          },
        },
      };
    }
    if (outboxKind !== "pull_request") {
      return {
        draft_pull_request: draftPullRequest,
        outbox_entry: outboxEntry,
        thread: thread,
        push: {
          status: "skipped",
          reason: `GitHub thread adapter does not support outbox kind '${outboxKind}'.`,
          adapter: {
            type: adapterType,
            adapter_ref: adapterRef,
          },
        },
      };
    }
    if (!draftPullRequest) {
      return {
        outbox_entry: outboxEntry,
        thread: thread,
        push: {
          status: "skipped",
          reason:
            "draft_pull_request is required to push through the GitHub thread adapter.",
          adapter: {
            type: adapterType,
            adapter_ref: adapterRef,
          },
        },
      };
    }
    const pushed = pushGitHubPullRequest({
      thread,
      draftPullRequest,
      outboxEntry,
      workspacePath,
      nextStatus,
      env,
    });
    const refreshedState = fetchGitHubIssueThread({
      adapterRef,
      env,
      cwd: workspacePath,
    });
    const refreshedOutboxEntry =
      selectMatchingOutboxEntry(refreshedState, pushed.outbox_entry) ??
      pushed.outbox_entry;

    return {
      draft_pull_request: draftPullRequest,
      outbox_entry: refreshedOutboxEntry,
      thread: refreshedState,
      push: {
        status: "pushed",
        adapter: {
          type: adapterType,
          adapter_ref: adapterRef,
        },
        pushed_at: firstNonEmptyString(
          optionalRecord(refreshedOutboxEntry.metadata)?.pushed_at,
        ),
        pull_request: {
          number: firstNonEmptyString(pushed.pull_request.number),
          url: firstNonEmptyString(pushed.pull_request.url),
        },
      },
    };
  }

  if (adapterType !== "file") {
    return {
      draft_pull_request: draftPullRequest,
      outbox_entry: outboxEntry,
      thread: thread,
      push: {
        status: "skipped",
        reason: `no thread adapter is registered for '${adapterType}'`,
        adapter: {
          type: adapterType,
        },
      },
    };
  }

  if (!adapterRef) {
    throw new Error(`thread adapter '${adapterType}' requires adapter_ref.`);
  }

  const statePath = resolveAdapterRefPath(adapterRef);
  const adapterUri = pathToFileURL(statePath).href;
  const currentState = asRecord(
    JSON.parse(await readFile(statePath, "utf8")),
    "thread_file",
  );
  const threadLocator = firstNonEmptyString(
    outboxEntry.thread_locator,
    currentState.thread_locator,
  );

  if (!threadLocator) {
    throw new Error("thread locator is required to push an outbox entry.");
  }

  const existingOutbox = Array.isArray(currentState.outbox)
    ? currentState.outbox.filter(isRecord)
    : [];
  const existing = existingOutbox.find(
    (candidate) =>
      candidate.entry_id === outboxEntry.entry_id ||
      (firstNonEmptyString(outboxEntry.locator) &&
        candidate.locator === outboxEntry.locator),
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
    status: firstNonEmptyString(
      nextStatus,
      outboxEntry.status,
      existing?.status,
      "draft",
    ),
    thread_locator: threadLocator,
  };

  const pushEvent = {
    entry_id: `entry_${hashStable({
      thread_locator: threadLocator,
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
      type: "thread_adapter",
      uri: adapterUri,
      recorded_at: pushedAt,
    },
  };
  const refreshedState = {
    ...currentState,
    adapter: {
      ...adapter,
      adapter_ref: adapterRef,
      cursor: `push:${hashStable({ outbox_entry: pushedEntry.entry_id, pushed_at: pushedAt }).slice(0, 12)}`,
    },
    entries: [
      ...(Array.isArray(currentState.entries) ? currentState.entries : []),
      pushEvent,
    ],
    outbox: upsertOutboxEntry(existingOutbox, pushedEntry),
    generated_at: pushedAt,
    watermark: pushedEntry.entry_id,
  };

  await writeThreadFile(statePath, refreshedState);

  return {
    draft_pull_request: draftPullRequest,
    outbox_entry: pushedEntry,
    thread: refreshedState,
    push: {
      status: "pushed",
      adapter: {
        type: adapterType,
        adapter_ref: adapterRef,
      },
      pushed_at: pushedAt,
    },
  };
}

function asRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function resolveAdapterRefPath(adapterRefValue) {
  if (adapterRefValue.startsWith("file://")) {
    return path.resolve(fileURLToPath(adapterRefValue));
  }
  return path.resolve(adapterRefValue);
}

function selectMatchingOutboxEntry(threadValue, pushedEntry) {
  const outbox = Array.isArray(threadValue?.outbox)
    ? threadValue.outbox.filter(isRecord)
    : [];
  return outbox.find(
    (candidate) =>
      candidate.entry_id === pushedEntry.entry_id ||
      (firstNonEmptyString(pushedEntry.locator) &&
        candidate.locator === pushedEntry.locator),
  );
}

function upsertOutboxEntry(existingEntries, entry) {
  const filtered = existingEntries.filter(
    (candidate) =>
      candidate.entry_id !== entry.entry_id &&
      candidate.locator !== entry.locator,
  );
  return [...filtered, entry];
}

async function writeThreadFile(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tempPath, statePath);
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

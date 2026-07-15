import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { validateDataOperationResultContract } from "../packages/contracts/src/index.js";

type AdapterCase = {
  readonly name: string;
  readonly path: string;
  readonly makeBaseInputs: (workspace: string, caseId: string) => Record<string, unknown>;
  readonly skip?: string;
};

const adapters: readonly AdapterCase[] = [
  {
    name: "data.local",
    path: "skills/data-store/tools/data/local/run.mjs",
    makeBaseInputs: (_workspace, caseId) => ({
      data_source_ref: `local://runx-data-store/conformance/${caseId}`,
      store_id: `data-adapter-conformance-${caseId}`,
    }),
  },
  {
    name: "data.sqlite",
    path: "skills/data-store/tools/data/sqlite/run.mjs",
    makeBaseInputs: (_workspace, caseId) => ({
      data_source_ref: `local://runx-data-store/conformance/${caseId}`,
      data_source_binding: {
        adapter: "data.sqlite",
        database_path: `.runx/data/conformance-${caseId}.sqlite`,
        resources: {
          board_events: {
            kind: "event_stream",
            partition_key: "aggregate_id",
          },
        },
      },
    }),
    skip: existsSync("skills/data-store/tools/data/sqlite/run.mjs") ? undefined : "sqlite adapter not present",
  },
  ...redisAdapterCase(),
];

describe.each(adapters)("data adapter conformance: $name", (adapter) => {
  it("appends, replays, reads events, and reads projection", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("happy"));
      const append = runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-123",
        expected_version: 0,
        idempotency_key: "posting-123:create:v1",
        event: {
          type: "posting.created",
          payload: {
            title: "verify a receipt link",
          },
        },
      });

      expectPacket(append, {
        status: "committed",
        operation: "append_event",
        before_version: 0,
        after_version: 1,
        provider: expectedProvider(adapter.name),
      });

      const replay = runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-123",
        expected_version: 0,
        idempotency_key: "posting-123:create:v1",
        event: {
          type: "posting.created",
          payload: {
            title: "verify a receipt link",
          },
        },
      });

      expectPacket(replay, {
        status: "idempotent_replay",
        operation: "append_event",
        before_version: 1,
        after_version: 1,
      });

      const events = runAdapter(adapter, workspace, {
        ...base,
        operation: "read_events",
        resource: "board_events",
        aggregate_id: "posting-123",
        limit: 10,
      });

      const eventsPacket = expectPacket(events, {
        status: "read",
        operation: "read_events",
        before_version: 1,
        after_version: 1,
      });
      expect(eventsPacket.events).toHaveLength(1);
      expect(eventsPacket.rows).toHaveLength(1);

      const projection = runAdapter(adapter, workspace, {
        ...base,
        operation: "read_projection",
        resource: "board_events",
        aggregate_id: "posting-123",
      });

      const projectionPacket = expectPacket(projection, {
        status: "read",
        operation: "read_projection",
        before_version: 1,
        after_version: 1,
      });
      expect(projectionPacket.projection).toMatchObject({
        aggregate_id: "posting-123",
        resource: "board_events",
        version: 1,
        event_count: 1,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("pages forward by exclusive stream version without changing latest-tail reads", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("forward-page"));
      for (let index = 1; index <= 3; index += 1) {
        runAdapter(adapter, workspace, {
          ...base,
          operation: "append_event",
          resource: "board_events",
          aggregate_id: "paged-stream",
          expected_version: index - 1,
          idempotency_key: `paged-stream:${index}`,
          event: { type: "page.item", payload: { index } },
        });
      }

      const tail = expectPacket(runAdapter(adapter, workspace, {
        ...base,
        operation: "read_events",
        resource: "board_events",
        aggregate_id: "paged-stream",
        limit: 1,
      }), {
        status: "read",
        operation: "read_events",
        before_version: 3,
        after_version: 3,
      });
      expect(tail.events.map((event) => recordField(event, "version"))).toEqual([3]);

      const firstPage = expectPacket(runAdapter(adapter, workspace, {
        ...base,
        operation: "read_events",
        resource: "board_events",
        aggregate_id: "paged-stream",
        after_version: 0,
        limit: 2,
      }), {
        status: "read",
        operation: "read_events",
        before_version: 3,
        after_version: 3,
      });
      expect(firstPage.events.map((event) => recordField(event, "version"))).toEqual([1, 2]);

      const secondPage = expectPacket(runAdapter(adapter, workspace, {
        ...base,
        operation: "read_events",
        resource: "board_events",
        aggregate_id: "paged-stream",
        after_version: 2,
        limit: 2,
      }), {
        status: "read",
        operation: "read_events",
        before_version: 3,
        after_version: 3,
      });
      expect(secondPage.events.map((event) => recordField(event, "version"))).toEqual([3]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps stream-head keyset pages stable when a newer head arrives", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("stable-head-page"));
      const heads = [
        ["item-a", "2026-07-14T04:00:00.000Z"],
        ["item-b", "2026-07-14T03:00:00.000Z"],
        ["item-c", "2026-07-14T03:00:00.000Z"],
        ["item-d", "2026-07-14T02:00:00.000Z"],
      ] as const;
      for (const [aggregateId, observedAt] of heads) {
        runAdapter(adapter, workspace, {
          ...base,
          operation: "append_event",
          resource: "board_events",
          aggregate_id: aggregateId,
          expected_version: 0,
          idempotency_key: `${aggregateId}:open:v1`,
          observed_at: observedAt,
          event: { type: "item.open", payload: { aggregate_id: aggregateId } },
        });
      }

      const first = expectPacket(runAdapter(adapter, workspace, {
        ...base,
        operation: "list_stream_heads",
        resource: "board_events",
        event_types: ["item.open"],
        limit: 2,
      }), {
        status: "read",
        operation: "list_stream_heads",
        before_version: 0,
        after_version: 0,
      });
      expect(first.rows.map((row) => recordField(row, "aggregate_id"))).toEqual(["item-a", "item-b"]);

      runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "item-new",
        expected_version: 0,
        idempotency_key: "item-new:open:v1",
        observed_at: "2026-07-14T05:00:00.000Z",
        event: { type: "item.open", payload: { aggregate_id: "item-new" } },
      });

      const second = expectPacket(runAdapter(adapter, workspace, {
        ...base,
        operation: "list_stream_heads",
        resource: "board_events",
        event_types: ["item.open"],
        limit: 2,
        cursor: recordField(first.projection, "next_cursor"),
      }), {
        status: "read",
        operation: "list_stream_heads",
        before_version: 0,
        after_version: 0,
      });
      expect(second.rows.map((row) => recordField(row, "aggregate_id"))).toEqual(["item-c", "item-d"]);
      expect(recordField(second.projection, "has_more")).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("derives event_type from generic effect transition packets", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("effect-type"));
      runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-effect",
        expected_version: 0,
        idempotency_key: "posting-effect:accept:v1",
        event: {
          effect_family: "messageboard",
          operation: "accept",
          payload: {
            accepted: true,
          },
        },
      });

      const events = runAdapter(adapter, workspace, {
        ...base,
        operation: "read_events",
        resource: "board_events",
        aggregate_id: "posting-effect",
        limit: 10,
      });
      const packet = expectPacket(events, {
        status: "read",
        operation: "read_events",
        before_version: 1,
        after_version: 1,
      });
      expect(recordField(packet.events[0], "event_type")).toBe("messageboard.accept");

      const projection = runAdapter(adapter, workspace, {
        ...base,
        operation: "read_projection",
        resource: "board_events",
        aggregate_id: "posting-effect",
      });
      const projectionPacket = expectPacket(projection, {
        status: "read",
        operation: "read_projection",
        before_version: 1,
        after_version: 1,
      });
      expect(recordField(projectionPacket.projection, "last_event_type")).toBe("messageboard.accept");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects idempotency conflicts and stale expected versions without committing", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("conflict"));
      runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-456",
        expected_version: 0,
        idempotency_key: "posting-456:create:v1",
        event: {
          type: "posting.created",
          payload: {
            title: "first",
          },
        },
      });

      const idempotencyConflict = runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-456",
        expected_version: 1,
        idempotency_key: "posting-456:create:v1",
        event: {
          type: "posting.created",
          payload: {
            title: "different",
          },
        },
      });

      const conflictPacket = expectPacket(idempotencyConflict, {
        status: "conflict",
        operation: "append_event",
        before_version: 1,
        after_version: 1,
      });
      expect(conflictPacket.stop_conditions[0]?.code).toBe("conflict");

      const versionConflict = runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-456",
        expected_version: 0,
        idempotency_key: "posting-456:claim:v1",
        event: {
          type: "posting.claimed",
          payload: {
            actor: "agent-9",
          },
        },
      });

      const versionPacket = expectPacket(versionConflict, {
        status: "conflict",
        operation: "append_event",
        before_version: 1,
        after_version: 1,
      });
      expect(versionPacket.stop_conditions[0]?.message).toContain("expected version 0");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed on missing write keys and broad invalid reads", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("failure"));

      const missingIdempotency = runAdapterRaw(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "board_events",
        aggregate_id: "posting-789",
        expected_version: 0,
        event: {
          type: "posting.created",
        },
      });
      expect(missingIdempotency.status).not.toBe(0);
      expect(missingIdempotency.stderr).toContain("idempotency_key");

      const invalidLimit = runAdapterRaw(adapter, workspace, {
        ...base,
        operation: "read_events",
        resource: "board_events",
        aggregate_id: "posting-789",
        limit: 10_000,
      });
      expect(invalidLimit.status).not.toBe(0);
      expect(invalidLimit.stderr).toContain("limit");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts safe slash-style aggregate ids for repo and cursor streams", () => {
    const workspace = tempWorkspace(adapter.name);
    try {
      const base = adapter.makeBaseInputs(workspace, uniqueId("slash-aggregate"));
      const append = runAdapter(adapter, workspace, {
        ...base,
        operation: "append_event",
        resource: "github_sync_events",
        aggregate_id: "runxhq/runx:triage-open",
        expected_version: 0,
        idempotency_key: "runxhq/runx:triage-open:pull:v1",
        event: {
          type: "github.sync.planned",
          payload: {
            repo: "runxhq/runx",
          },
        },
      });

      const packet = expectPacket(append, {
        status: "committed",
        operation: "append_event",
        before_version: 0,
        after_version: 1,
      });
      expect(packet.aggregate_id).toBe("runxhq/runx:triage-open");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

it("isolates SQLite streams by data_source_ref when sources share one database", () => {
  const adapter = adapters.find((candidate) => candidate.name === "data.sqlite");
  expect(adapter?.skip).toBeUndefined();
  if (!adapter || adapter.skip) return;

  const workspace = tempWorkspace(adapter.name);
  try {
    const databasePath = ".runx/data/shared-source-isolation.sqlite";
    const binding = {
      adapter: "data.sqlite",
      database_path: databasePath,
      resources: {
        board_events: {
          kind: "event_stream",
          partition_key: "aggregate_id",
        },
      },
    };
    const appendA = runAdapter(adapter, workspace, {
      data_source_ref: "tenant://source-a/board",
      data_source_binding: binding,
      operation: "append_event",
      resource: "board_events",
      aggregate_id: "posting-123",
      expected_version: 0,
      idempotency_key: "posting-123:create:v1",
      event: {
        type: "posting.created",
        payload: {
          source: "a",
        },
      },
    });

    expectPacket(appendA, {
      status: "committed",
      operation: "append_event",
      before_version: 0,
      after_version: 1,
    });

    const appendB = runAdapter(adapter, workspace, {
      data_source_ref: "tenant://source-b/board",
      data_source_binding: binding,
      operation: "append_event",
      resource: "board_events",
      aggregate_id: "posting-123",
      expected_version: 0,
      idempotency_key: "posting-123:create:v1",
      event: {
        type: "posting.created",
        payload: {
          source: "b",
        },
      },
    });

    expectPacket(appendB, {
      status: "committed",
      operation: "append_event",
      before_version: 0,
      after_version: 1,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

it("isolates Redis streams by data_source_ref when sources share one key prefix", () => {
  const adapter = adapters.find((candidate) => candidate.name === "data.redis");
  if (!adapter) return;

  const workspace = tempWorkspace(adapter.name);
  try {
    const keyPrefix = `runx:data-store:{source-isolation-${uniqueId("redis")}}`;
    const binding = {
      adapter: "data.redis",
      endpoint: process.env.RUNX_REDIS_URL,
      key_prefix: keyPrefix,
      resources: {
        board_events: {
          kind: "event_stream",
          partition_key: "aggregate_id",
        },
      },
    };
    const appendA = runAdapter(adapter, workspace, {
      data_source_ref: "tenant://source-a/board",
      data_source_binding: binding,
      operation: "append_event",
      resource: "board_events",
      aggregate_id: "posting-123",
      expected_version: 0,
      idempotency_key: "posting-123:create:v1",
      event: {
        type: "posting.created",
        payload: {
          source: "a",
        },
      },
    });

    expectPacket(appendA, {
      status: "committed",
      operation: "append_event",
      before_version: 0,
      after_version: 1,
    });

    const appendB = runAdapter(adapter, workspace, {
      data_source_ref: "tenant://source-b/board",
      data_source_binding: binding,
      operation: "append_event",
      resource: "board_events",
      aggregate_id: "posting-123",
      expected_version: 0,
      idempotency_key: "posting-123:create:v1",
      event: {
        type: "posting.created",
        payload: {
          source: "b",
        },
      },
    });

    expectPacket(appendB, {
      status: "committed",
      operation: "append_event",
      before_version: 0,
      after_version: 1,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function runAdapter(adapter: AdapterCase, workspace: string, inputs: unknown): unknown {
  const result = runAdapterRaw(adapter, workspace, inputs);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toBe("");
  return JSON.parse(result.stdout);
}

function runAdapterRaw(adapter: AdapterCase, workspace: string, inputs: unknown) {
  return spawnSync(process.execPath, [path.resolve(adapter.path)], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      RUNX_CWD: workspace,
      RUNX_INPUTS_JSON: JSON.stringify(inputs),
    },
  });
}

function expectPacket(
  value: unknown,
  expected: {
    readonly status: string;
    readonly operation: string;
    readonly before_version: number;
    readonly after_version: number;
    readonly provider?: string;
  },
) {
  const packet = validateDataOperationResultContract(value);
  expect(packet.status).toBe(expected.status);
  expect(packet.operation).toBe(expected.operation);
  expect(packet.before_version).toBe(expected.before_version);
  expect(packet.after_version).toBe(expected.after_version);
  if (expected.provider) {
    expect(packet.provider).toBe(expected.provider);
  }
  expect(packet.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(packet.projection_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  assertNoSecretMaterial(packet);
  return packet;
}

function assertNoSecretMaterial(value: unknown, pathParts: readonly string[] = []): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, [...pathParts, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    expect(
      /(?:secret|token|api[_-]?key|password|private[_-]?key|connection[_-]?string)/.test(lowered),
      [...pathParts, key].join("."),
    ).toBe(false);
    assertNoSecretMaterial(child, [...pathParts, key]);
  }
}

function recordField(value: unknown, key: string): unknown {
  expect(value && typeof value === "object" && !Array.isArray(value)).toBe(true);
  return (value as Record<string, unknown>)[key];
}

function tempWorkspace(adapterName: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `runx-${adapterName.replaceAll(".", "-")}-`));
}

function uniqueId(label: string): string {
  return `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function expectedProvider(adapterName: string): string {
  if (adapterName === "data.local") return "local-json-event-store";
  if (adapterName === "data.sqlite") return "sqlite-event-store";
  if (adapterName === "data.redis") return "redis-event-store";
  throw new Error(`unexpected adapter ${adapterName}`);
}

function redisAdapterCase(): readonly AdapterCase[] {
  const redisUrl = process.env.RUNX_REDIS_URL;
  if (!redisUrl || !redisReady(redisUrl)) return [];
  return [
    {
      name: "data.redis",
      path: "skills/data-store/tools/data/redis/run.mjs",
      makeBaseInputs: (_workspace, caseId) => ({
        data_source_ref: `local://runx-data-store/conformance/${caseId}`,
        data_source_binding: {
          adapter: "data.redis",
          endpoint: redisUrl,
          key_prefix: `runx:data-store:conformance:{${caseId}}`,
          resources: {
            board_events: {
              kind: "event_stream",
              partition_key: "aggregate_id",
            },
          },
        },
      }),
    },
  ];
}

function redisReady(redisUrl: string): boolean {
  try {
    const parsed = new URL(redisUrl);
    if ((parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") || parsed.username || parsed.password) {
      return false;
    }
  } catch {
    return false;
  }
  const result = spawnSync(process.env.RUNX_REDIS_CLI_BIN || "redis-cli", ["-u", redisUrl, "PING"], {
    encoding: "utf8",
    maxBuffer: 1024 * 32,
  });
  return result.status === 0 && result.stdout.trim().toUpperCase() === "PONG";
}

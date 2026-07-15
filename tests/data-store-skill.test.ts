import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateDataOperationResultContract } from "../packages/contracts/src/index.js";

const localAdapterPath = path.resolve("skills/data-store/tools/data/local/run.mjs");
const sqliteAdapterPath = path.resolve("skills/data-store/tools/data/sqlite/run.mjs");

describe("data-store local adapter", () => {
  it("emits the governed data operation result contract", () => {
    const storeId = `contract-test-${process.pid}-${Date.now()}`;
    const result = runDataAdapter(localAdapterPath, {
      operation: "append_event",
      data_source_ref: "local://runx-data-store/contract-test",
      store_id: storeId,
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

    const packet = validateDataOperationResultContract(JSON.parse(result.stdout));
    expect(packet.status).toBe("committed");
    expect(packet.operation).toBe("append_event");
    expect(packet.provider).toBe("local-json-event-store");
  });

  it("lists a bounded, cursor-paginated page across 10,000 stream heads", () => {
    const storeId = `heads-test-${process.pid}-${Date.now()}`;
    const storePath = path.join(os.tmpdir(), "runx-data-store", `${storeId}.json`);
    const streams = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => {
      const aggregateId = `item-${String(index).padStart(5, "0")}`;
      const eventType = index % 2 === 0 ? "item.open" : "item.resolved";
      const event = { type: eventType, payload: { index } };
      return [aggregateId, {
        version: 1,
        events: [{
          event_ref: `items:${aggregateId}:1`,
          version: 1,
          event_type: eventType,
          event,
          event_digest: `sha256:${String(index).padStart(64, "0")}`,
          idempotency_key: `${aggregateId}:create`,
          committed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        }],
      }];
    }));
    writeFileSync(storePath, JSON.stringify({
      schema: "runx.local_data_store.v1",
      store_id: storeId,
      resources: { items: { streams } },
    }));

    try {
      const firstRaw = runDataAdapter(localAdapterPath, {
        operation: "list_stream_heads",
        data_source_ref: "local://runx-data-store/heads-test",
        store_id: storeId,
        resource: "items",
        event_types: ["item.open"],
        limit: 25,
      }).stdout;
      const first = validateDataOperationResultContract(JSON.parse(firstRaw));
      expect(first.rows).toHaveLength(25);
      expect(first.rows.every((row) => (row as { event_type?: string }).event_type === "item.open")).toBe(true);
      expect(firstRaw.length).toBeLessThan(100_000);
      expect(first.projection).toMatchObject({ count: 25, has_more: true });

      const second = validateDataOperationResultContract(JSON.parse(runDataAdapter(localAdapterPath, {
        operation: "list_stream_heads",
        data_source_ref: "local://runx-data-store/heads-test",
        store_id: storeId,
        resource: "items",
        event_types: ["item.open"],
        limit: 25,
        cursor: (first.projection as { next_cursor: string }).next_cursor,
      }).stdout));
      const firstIds = new Set(first.rows.map((row) => (row as { aggregate_id: string }).aggregate_id));
      expect(second.rows).toHaveLength(25);
      expect(second.rows.some((row) => firstIds.has((row as { aggregate_id: string }).aggregate_id))).toBe(false);
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("materializes and filters SQLite stream heads as events advance", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "runx-data-store-sqlite-"));
    const databasePath = path.join(root, "heads.sqlite");
    const base = {
      data_source_ref: "local://runx-data-store/sqlite-heads-test",
      database_path: databasePath,
      allow_absolute_path: true,
      resource: "items",
    };

    try {
      for (const aggregateId of ["item-a", "item-b"]) {
        runDataAdapter(sqliteAdapterPath, {
          ...base,
          operation: "append_event",
          aggregate_id: aggregateId,
          expected_version: 0,
          idempotency_key: `${aggregateId}:open`,
          observed_at: aggregateId === "item-a" ? "2026-07-14T01:00:00.000Z" : "2026-07-14T02:00:00.000Z",
          event: { type: "item.open", payload: { aggregate_id: aggregateId } },
        });
      }
      runDataAdapter(sqliteAdapterPath, {
        ...base,
        operation: "append_event",
        aggregate_id: "item-b",
        expected_version: 1,
        idempotency_key: "item-b:resolved",
        observed_at: "2026-07-14T03:00:00.000Z",
        event: { type: "item.resolved", payload: { aggregate_id: "item-b" } },
      });

      const listed = validateDataOperationResultContract(JSON.parse(runDataAdapter(sqliteAdapterPath, {
        ...base,
        operation: "list_stream_heads",
        event_types: ["item.open"],
        limit: 10,
      }).stdout));
      expect(listed.rows).toHaveLength(1);
      expect(listed.rows[0]).toMatchObject({ aggregate_id: "item-a", version: 1, event_type: "item.open" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runDataAdapter(adapterPath: string, inputs: unknown): { readonly stdout: string } {
  const result = spawnSync(process.execPath, [adapterPath], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      RUNX_INPUTS_JSON: JSON.stringify(inputs),
    },
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toBe("");
  return { stdout: result.stdout };
}

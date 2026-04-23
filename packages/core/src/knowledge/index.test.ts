import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeLocalReceipt } from "../receipts/index.js";

import {
  createFileKnowledgeStore,
  fetchThreadViaAdapter,
  findOutboxEntry,
  latestDecisionForGate,
  pushOutboxEntryViaAdapter,
  threadAllowsGate,
  summarizeThread,
  validateThread,
} from "./index.js";

describe("thread contract", () => {
  it("accepts provider-native thread without leaking provider nouns into core fields", () => {
    const state = validateThread({
      kind: "runx.thread.v1",
      adapter: {
        type: "github",
        provider: "github",
        surface: "issue_thread",
        cursor: "comment:4286817434",
      },
      thread_kind: "work_item",
      thread_locator: "runxhq/aster#issue/110",
      title: "[skill] Add a collaboration issue distillation skill",
      canonical_uri: "https://github.com/runxhq/aster/issues/110",
      entries: [
        {
          entry_id: "comment-1",
          entry_kind: "message",
          recorded_at: "2026-04-21T07:25:06Z",
          actor: {
            actor_id: "auscaster",
            role: "maintainer",
          },
          body: "Opened draft PR for this run.",
        },
      ],
      decisions: [
        {
          decision_id: "publish-1",
          gate_id: "skill-lab.publish",
          decision: "allow",
          recorded_at: "2026-04-21T08:00:00Z",
          reason: "same subject approved one rolling draft PR",
        },
      ],
      outbox: [
        {
          entry_id: "pr-111",
          kind: "pull_request",
          locator: "https://github.com/runxhq/aster/pull/111",
          status: "draft",
        },
      ],
      source_refs: [
        {
          type: "provider_thread",
          uri: "https://github.com/runxhq/aster/issues/110",
        },
      ],
      generated_at: "2026-04-21T08:05:00Z",
    });

    expect(state.thread_kind).toBe("work_item");
    expect(state.thread_locator).toBe("runxhq/aster#issue/110");
    expect(state.adapter.type).toBe("github");
    expect(threadAllowsGate(state, "skill-lab.publish")).toBe(true);
    expect(findOutboxEntry(state, "pull_request")?.status).toBe("draft");
  });

  it("returns the newest matching decision for a gate", () => {
    const state = validateThread({
      kind: "runx.thread.v1",
      adapter: {
        type: "local-conversation",
      },
      thread_kind: "work_item",
      thread_locator: "local://conversation/42",
      entries: [],
      decisions: [
        {
          decision_id: "plan-1",
          gate_id: "issue-triage.plan",
          decision: "deny",
          recorded_at: "2026-04-21T08:00:00Z",
        },
        {
          decision_id: "plan-2",
          gate_id: "issue-triage.plan",
          decision: "allow",
          recorded_at: "2026-04-21T08:05:00Z",
        },
      ],
      outbox: [],
      source_refs: [],
    });

    expect(latestDecisionForGate(state, "issue-triage.plan")?.decision_id).toBe("plan-2");
    expect(threadAllowsGate(state, "issue-triage.plan")).toBe(true);
  });

  it("renders a stable provider-agnostic summary", () => {
    const state = validateThread({
      kind: "runx.thread.v1",
      adapter: {
        type: "ticketing",
        provider: "linear",
        surface: "ticket_thread",
      },
      thread_kind: "work_item",
      thread_locator: "linear://issue/ENG-42",
      entries: [
        {
          entry_id: "entry-1",
          entry_kind: "message",
          recorded_at: "2026-04-21T09:00:00Z",
        },
        {
          entry_id: "entry-2",
          entry_kind: "status",
          recorded_at: "2026-04-21T09:01:00Z",
        },
      ],
      decisions: [],
      outbox: [
        {
          entry_id: "draft-1",
          kind: "draft_change",
          status: "proposed",
        },
      ],
      source_refs: [],
    });

    expect(summarizeThread(state)).toBe(
      "work_item:linear://issue/ENG-42 via ticketing | entries=2 decisions=0 outbox=draft_change",
    );
  });

  it("rejects missing thread locator fields", () => {
    expect(
      () =>
        validateThread({
          kind: "runx.thread.v1",
          adapter: {
            type: "github",
          },
          thread_kind: "work_item",
          title: "missing locator",
          entries: [],
          decisions: [],
          outbox: [],
          source_refs: [],
        }),
    ).toThrow(/thread_locator/);
  });

  it("rejects nested legacy subject payloads in the thread contract", () => {
    expect(
      () =>
        validateThread({
          kind: "runx.thread.v1",
          adapter: {
            type: "github",
          },
          subject: {
            thread_kind: "work_item",
            thread_locator: "github://example/repo/issues/123",
          },
          entries: [],
          decisions: [],
          outbox: [],
          source_refs: [],
        }),
    ).toThrow(/thread_kind/);
  });

  it("pushes and rehydrates through the file thread adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-thread-file-"));
    const statePath = path.join(tempDir, "thread.json");
    const initial = {
      kind: "runx.thread.v1",
      adapter: {
        type: "file",
        adapter_ref: statePath,
      },
      thread_kind: "work_item",
      thread_locator: "local://provider/issues/123",
      canonical_uri: "https://example.test/issues/123",
      entries: [],
      decisions: [],
      outbox: [],
      source_refs: [],
    };

    try {
      await writeFile(statePath, `${JSON.stringify(initial, null, 2)}\n`);
      const state = validateThread(initial);
      const result = await pushOutboxEntryViaAdapter({
        thread: state,
        entry: {
          entry_id: "pull_request:fixture-task",
          kind: "pull_request",
          title: "Fixture PR",
          status: "proposed",
        },
        next_status: "draft",
      });

      expect(result.status).toBe("pushed");
      expect(result.outbox_entry).toMatchObject({
        entry_id: "pull_request:fixture-task",
        kind: "pull_request",
        status: "draft",
        locator: expect.stringContaining("#outbox/pull_request%3Afixture-task"),
        thread_locator: "local://provider/issues/123",
      });
      expect(result.thread.outbox).toEqual([
        expect.objectContaining({
          entry_id: "pull_request:fixture-task",
          status: "draft",
        }),
      ]);
      expect(result.thread.entries.at(-1)).toMatchObject({
        entry_kind: "status",
        structured_data: {
          event: "push_outbox_entry",
          outbox_entry_id: "pull_request:fixture-task",
          status: "draft",
        },
      });

      const fetched = await fetchThreadViaAdapter(result.thread.adapter, {
        thread_kind: "work_item",
        thread_locator: "local://provider/issues/123",
        include_outbox: true,
      });
      expect(fetched?.outbox).toEqual([
        expect.objectContaining({
          entry_id: "pull_request:fixture-task",
          status: "draft",
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips push when no runtime adapter is registered", async () => {
    const state = validateThread({
      kind: "runx.thread.v1",
      adapter: {
        type: "github",
      },
      thread_kind: "work_item",
      thread_locator: "github://example/repo/issues/123",
      entries: [],
      decisions: [],
      outbox: [],
      source_refs: [],
    });

    const result = await pushOutboxEntryViaAdapter({
      thread: state,
      entry: {
        entry_id: "pull_request:fixture-task",
        kind: "pull_request",
      },
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "no thread adapter is registered for 'github'",
      outbox_entry: {
        entry_id: "pull_request:fixture-task",
        kind: "pull_request",
      },
      thread: state,
    });
  });
});

describe("file local knowledge store", () => {
  it("initializes an idempotent filesystem index and stores project-scoped projections", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-knowledge-"));
    const knowledgeDir = path.join(tempDir, "knowledge");

    try {
      const store = createFileKnowledgeStore(knowledgeDir);
      await expect(store.init()).resolves.toMatchObject({
        schema_version: "runx.knowledge.v1",
        entries: [],
      });
      await expect(store.init()).resolves.toMatchObject({
        schema_version: "runx.knowledge.v1",
      });

      const receipt = await writeLocalReceipt({
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        skillName: "echo",
        sourceType: "cli-tool",
        inputs: { message: "secret" },
        stdout: "ok",
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 1,
        },
        startedAt: "2026-04-10T00:00:00Z",
        completedAt: "2026-04-10T00:00:01Z",
      });

      const project = path.join(tempDir, "project");
      await store.indexReceipt({
        receipt,
        receiptPath: path.join(tempDir, "receipts", `${receipt.id}.json`),
        project,
        indexedAt: "2026-04-10T00:00:02Z",
      });
      await store.addProjection({
        project,
        scope: "project",
        key: "homepage_url",
        value: "https://example.test",
        source: "test",
        confidence: 0.9,
        freshness: "fresh",
        receiptId: receipt.id,
        createdAt: "2026-04-10T00:00:03Z",
      });

      await expect(store.listReceipts({ project })).resolves.toEqual([
        expect.objectContaining({
          receipt_id: receipt.id,
          execution_ref: "echo",
          source_type: "cli-tool",
          indexed_at: "2026-04-10T00:00:02Z",
        }),
      ]);
      await expect(store.listProjections({ project })).resolves.toEqual([
        expect.objectContaining({
          key: "homepage_url",
          value: "https://example.test",
          receipt_id: receipt.id,
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves concurrent projection writes through the filesystem index", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-knowledge-concurrent-"));
    const knowledgeDir = path.join(tempDir, "knowledge");
    const project = path.join(tempDir, "project");

    try {
      const store = createFileKnowledgeStore(knowledgeDir);
      await store.init();

      await Promise.all(
        Array.from({ length: 20 }, async (_, index) =>
          createFileKnowledgeStore(knowledgeDir).addProjection({
            project,
            scope: "project",
            key: `projection_${index}`,
            value: index,
            source: "concurrency-test",
            confidence: 1,
            freshness: "fresh",
            createdAt: `2026-04-10T00:00:${String(index).padStart(2, "0")}Z`,
          }),
        ),
      );

      const projections = await store.listProjections({ project });
      expect(projections).toHaveLength(20);
      expect(projections.map((projection) => projection.key).sort()).toEqual(
        Array.from({ length: 20 }, (_, index) => `projection_${index}`).sort(),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips malformed stored index entries instead of throwing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-knowledge-malformed-"));
    const knowledgeDir = path.join(tempDir, "knowledge");
    const project = path.join(tempDir, "project");

    try {
      await mkdir(knowledgeDir, { recursive: true });
      await writeFile(
        path.join(knowledgeDir, "index.json"),
        `${JSON.stringify({
          schema_version: "runx.knowledge.v1",
          entries: [
            {
              entry_id: "receipt_rx_valid",
              entry_kind: "receipt",
              receipt_id: "rx_valid",
              kind: "skill_execution",
              status: "success",
              execution_ref: "echo",
              indexed_at: "2026-04-10T00:00:00Z",
              project,
            },
            { receipt_id: 123, indexed_at: 1 },
            {
              entry_id: "projection_valid",
              entry_kind: "projection",
              project,
              scope: "project",
              key: "homepage_url",
              value: "https://example.test",
              source: "test",
              confidence: 0.9,
              freshness: "fresh",
              created_at: "2026-04-10T00:00:01Z",
            },
            { id: "projection_bad", key: 42 },
          ],
        }, null, 2)}\n`,
      );

      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ""));
      };

      try {
        const store = createFileKnowledgeStore(knowledgeDir);
        const knowledge = await store.read();
        expect(knowledge.entries.filter((entry) => entry.entry_kind === "receipt")).toEqual([
          expect.objectContaining({
            receipt_id: "rx_valid",
            execution_ref: "echo",
          }),
        ]);
        expect(knowledge.entries.filter((entry) => entry.entry_kind === "projection")).toEqual([
          expect.objectContaining({
            entry_id: "projection_valid",
            key: "homepage_url",
          }),
        ]);
      } finally {
        console.warn = warn;
      }

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("malformed local knowledge entry");
      expect(warnings[1]).toContain("malformed local knowledge entry");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

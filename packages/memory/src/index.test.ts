import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeLocalReceipt } from "../../receipts/src/index.js";

import {
  createFileMemoryStore,
  findPublicationTarget,
  latestDecisionForGate,
  subjectMemoryAllowsGate,
  summarizeSubjectMemory,
  validateSubjectMemory,
} from "./index.js";

describe("subject memory contract", () => {
  it("accepts provider-native subject memory without leaking provider nouns into core fields", () => {
    const memory = validateSubjectMemory({
      kind: "runx.subject-memory.v1",
      adapter: {
        type: "github",
        provider: "github",
        surface: "issue_thread",
        cursor: "comment:4286817434",
      },
      subject: {
        subject_kind: "work_item",
        subject_locator: "nilstate/aster#issue/110",
        title: "[skill] Add a collaboration issue distillation skill",
        canonical_uri: "https://github.com/nilstate/aster/issues/110",
      },
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
      publication_targets: [
        {
          target_id: "pr-111",
          target_kind: "pull_request",
          locator: "https://github.com/nilstate/aster/pull/111",
          status: "draft",
        },
      ],
      source_refs: [
        {
          type: "provider_thread",
          uri: "https://github.com/nilstate/aster/issues/110",
        },
      ],
      generated_at: "2026-04-21T08:05:00Z",
    });

    expect(memory.subject.subject_kind).toBe("work_item");
    expect(memory.subject.subject_locator).toBe("nilstate/aster#issue/110");
    expect(memory.adapter.type).toBe("github");
    expect(subjectMemoryAllowsGate(memory, "skill-lab.publish")).toBe(true);
    expect(findPublicationTarget(memory, "pull_request")?.status).toBe("draft");
  });

  it("returns the newest matching decision for a gate", () => {
    const memory = validateSubjectMemory({
      kind: "runx.subject-memory.v1",
      adapter: {
        type: "local-conversation",
      },
      subject: {
        subject_kind: "work_item",
        subject_locator: "local://conversation/42",
      },
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
      publication_targets: [],
      source_refs: [],
    });

    expect(latestDecisionForGate(memory, "issue-triage.plan")?.decision_id).toBe("plan-2");
    expect(subjectMemoryAllowsGate(memory, "issue-triage.plan")).toBe(true);
  });

  it("renders a stable provider-agnostic summary", () => {
    const memory = validateSubjectMemory({
      kind: "runx.subject-memory.v1",
      adapter: {
        type: "ticketing",
        provider: "linear",
        surface: "ticket_thread",
      },
      subject: {
        subject_kind: "work_item",
        subject_locator: "linear://issue/ENG-42",
      },
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
      publication_targets: [
        {
          target_id: "draft-1",
          target_kind: "draft_change",
          status: "proposed",
        },
      ],
      source_refs: [],
    });

    expect(summarizeSubjectMemory(memory)).toBe(
      "work_item:linear://issue/ENG-42 via ticketing | entries=2 decisions=0 publication_targets=draft_change",
    );
  });

  it("rejects missing subject locator fields", () => {
    expect(
      () =>
        validateSubjectMemory({
          kind: "runx.subject-memory.v1",
          adapter: {
            type: "github",
          },
          subject: {
            subject_kind: "work_item",
            title: "missing locator",
          },
          entries: [],
          decisions: [],
          publication_targets: [],
          source_refs: [],
        }),
    ).toThrow(/subject_locator/);
  });
});

describe("file local memory store", () => {
  it("initializes an idempotent filesystem index and stores project-scoped facts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-memory-"));
    const memoryDir = path.join(tempDir, "memory");

    try {
      const store = createFileMemoryStore(memoryDir);
      await expect(store.init()).resolves.toMatchObject({
        schema_version: "runx.memory.v1",
        receipts: [],
        facts: [],
      });
      await expect(store.init()).resolves.toMatchObject({
        schema_version: "runx.memory.v1",
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
      await store.addFact({
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
          subject: "echo",
          source_type: "cli-tool",
          indexed_at: "2026-04-10T00:00:02Z",
        }),
      ]);
      await expect(store.listFacts({ project })).resolves.toEqual([
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

  it("preserves concurrent fact writes through the filesystem index", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-memory-concurrent-"));
    const memoryDir = path.join(tempDir, "memory");
    const project = path.join(tempDir, "project");

    try {
      const store = createFileMemoryStore(memoryDir);
      await store.init();

      await Promise.all(
        Array.from({ length: 20 }, async (_, index) =>
          createFileMemoryStore(memoryDir).addFact({
            project,
            scope: "project",
            key: `fact_${index}`,
            value: index,
            source: "concurrency-test",
            confidence: 1,
            freshness: "fresh",
            createdAt: `2026-04-10T00:00:${String(index).padStart(2, "0")}Z`,
          }),
        ),
      );

      const facts = await store.listFacts({ project });
      expect(facts).toHaveLength(20);
      expect(facts.map((fact) => fact.key).sort()).toEqual(
        Array.from({ length: 20 }, (_, index) => `fact_${index}`).sort(),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips malformed stored index entries instead of throwing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-memory-malformed-"));
    const memoryDir = path.join(tempDir, "memory");
    const project = path.join(tempDir, "project");

    try {
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        path.join(memoryDir, "index.json"),
        `${JSON.stringify({
          schema_version: "runx.memory.v1",
          receipts: [
            {
              receipt_id: "rx_valid",
              kind: "skill_execution",
              status: "success",
              subject: "echo",
              indexed_at: "2026-04-10T00:00:00Z",
              project,
            },
            { receipt_id: 123, indexed_at: 1 },
          ],
          facts: [
            {
              id: "fact_valid",
              project,
              scope: "project",
              key: "homepage_url",
              value: "https://example.test",
              source: "test",
              confidence: 0.9,
              freshness: "fresh",
              created_at: "2026-04-10T00:00:01Z",
            },
            { id: "fact_bad", key: 42 },
          ],
        }, null, 2)}\n`,
      );

      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ""));
      };

      try {
        const store = createFileMemoryStore(memoryDir);
        const index = await store.read();
        expect(index.receipts).toEqual([
          expect.objectContaining({
            receipt_id: "rx_valid",
            subject: "echo",
          }),
        ]);
        expect(index.facts).toEqual([
          expect.objectContaining({
            id: "fact_valid",
            key: "homepage_url",
          }),
        ]);
      } finally {
        console.warn = warn;
      }

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("malformed local memory receipts entry");
      expect(warnings[1]).toContain("malformed local memory facts entry");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

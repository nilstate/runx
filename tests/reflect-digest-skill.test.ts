import { rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "../packages/adapters/src/index.js";
import { createDefaultLocalSkillRuntime } from "../packages/adapters/src/runtime.js";
import { runHarnessTarget } from "@runxhq/runtime-local/harness";
import { runLocalSkill, type Caller } from "@runxhq/runtime-local";

describe("reflect-digest skill", () => {
  it("passes the inline harness suite", async () => {
    const result = await runHarnessTarget(path.resolve("skills/reflect-digest"), {
      adapters: createDefaultSkillAdapters(),
    });

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite");
    }
    expect(result.status).toBe("success");
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.map((entry) => entry.fixture.name)).toEqual([
      "reflect-digest-empty-knowledge",
      "reflect-digest-below-floor",
      "reflect-digest-single-skill",
      "reflect-digest-multi-skill",
    ]);
  }, 15_000);

  it("groups reflect projections deterministically before drafting proposals", async () => {
    const runtime = await createDefaultLocalSkillRuntime({
      prefix: "runx-reflect-digest-",
    });
    const caller: Caller = {
      resolve: async (request) => {
        if (request.kind !== "cognitive_work" || request.id !== "agent_step.reflect-digest.output") {
          return undefined;
        }
        const groupedReflections = Array.isArray(request.work.envelope.inputs.grouped_reflections)
          ? request.work.envelope.inputs.grouped_reflections
          : [];
        return {
          actor: "agent",
          payload: {
            proposals: groupedReflections.map((group) => ({
              skill_ref: group.skill_ref,
              supporting_receipt_ids: group.supporting_receipt_ids,
              draft_pull_request: {
                target: {
                  repo: "runx@runxhq/core/registry",
                  branch: `reflect/${group.skill_ref}`,
                },
                pull_request: {
                  title: `Reflect digest: ${group.skill_ref}`,
                  body: `Support count: ${group.support}`,
                },
              },
              outbox_entry: {
                entry_id: `pull_request:${group.skill_ref}`,
                kind: "pull_request",
                title: `Reflect digest: ${group.skill_ref}`,
                status: "draft",
                thread_locator: `registry://skills/${group.skill_ref}`,
              },
            })),
          },
        };
      },
      report: () => undefined,
    };

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("skills/reflect-digest"),
        caller,
        adapters: runtime.adapters,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
        env: runtime.env,
        inputs: {
          min_support: 2,
          min_confidence: 0.5,
          reflect_projections: [
            {
              entry_id: "projection_sourcey_1",
              entry_kind: "projection",
              project: "/tmp/project",
              scope: "reflect",
              key: "receipt:rx_sourcey_1",
              source: "post_run.reflect",
              confidence: 1,
              freshness: "derived",
              receipt_id: "rx_sourcey_1",
              created_at: "2026-04-22T00:00:00Z",
              value: {
                skill_ref: "sourcey",
                summary: "sourcey grouped signal one",
              },
            },
            {
              entry_id: "projection_sourcey_2",
              entry_kind: "projection",
              project: "/tmp/project",
              scope: "reflect",
              key: "receipt:rx_sourcey_2",
              source: "post_run.reflect",
              confidence: 0.9,
              freshness: "derived",
              receipt_id: "rx_sourcey_2",
              created_at: "2026-04-22T01:00:00Z",
              value: {
                skill_ref: "sourcey",
                summary: "sourcey grouped signal two",
              },
            },
            {
              entry_id: "projection_release_1",
              entry_kind: "projection",
              project: "/tmp/project",
              scope: "reflect",
              key: "receipt:rx_release_1",
              source: "post_run.reflect",
              confidence: 1,
              freshness: "derived",
              receipt_id: "rx_release_1",
              created_at: "2026-04-22T01:30:00Z",
              value: {
                skill_ref: "release",
                summary: "release only has one supporting fact",
              },
            },
            {
              entry_id: "projection_low_confidence",
              entry_kind: "projection",
              project: "/tmp/project",
              scope: "reflect",
              key: "receipt:rx_low",
              source: "post_run.reflect",
              confidence: 0.2,
              freshness: "derived",
              receipt_id: "rx_low",
              created_at: "2026-04-22T02:00:00Z",
              value: {
                skill_ref: "sourcey",
                summary: "filtered by confidence floor",
              },
            },
          ],
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const output = JSON.parse(result.execution.stdout) as {
        proposals: Array<{
          skill_ref: string;
          supporting_receipt_ids: string[];
          draft_pull_request: {
            pull_request: {
              body: string;
            };
          };
        }>;
      };
      expect(output.proposals).toHaveLength(1);
      expect(output.proposals[0]).toMatchObject({
        skill_ref: "sourcey",
        supporting_receipt_ids: ["rx_sourcey_1", "rx_sourcey_2"],
        draft_pull_request: {
          pull_request: {
            body: "Support count: 2",
          },
        },
      });
    } finally {
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  });
});

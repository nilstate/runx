import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillMarkdown, validateSkill } from "../packages/parser/src/index.js";
import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const builderSkillPaths = [
  "skills/work-plan",
  "skills/prior-art",
  "skills/write-harness",
  "skills/review-receipt",
];

describe("builder-chain skills", () => {
  it("uses portable agent-step contracts instead of repo-local helper scripts", async () => {
    for (const skillPath of builderSkillPaths) {
      const skill = validateSkill(parseSkillMarkdown(await readFile(path.resolve(skillPath, "SKILL.md"), "utf8")));

      expect(skill.source.type).toBe("agent");
      expect(skill.source.command).toBeUndefined();
      expect(skill.source.args).toEqual([]);
    }
  });

  it("ships builder flows as skill packages instead of standalone chain assets", () => {
    expect(existsSync(path.resolve("chains/design-skill.yaml"))).toBe(false);
    expect(existsSync(path.resolve("chains/improve-skill.yaml"))).toBe(false);
    expect(existsSync(path.resolve("skills/design-skill/X.yaml"))).toBe(true);
    expect(existsSync(path.resolve("skills/improve-skill/X.yaml"))).toBe(true);
  });

  it("teaches builder skills to use portable subject-memory nouns for subject-driven contracts", async () => {
    await expect(readFile(path.resolve("skills/design-skill/SKILL.md"), "utf8")).resolves.toContain("subject_memory");
    await expect(readFile(path.resolve("skills/work-plan/SKILL.md"), "utf8")).resolves.toContain("subject_locator");
    await expect(readFile(path.resolve("skills/write-harness/SKILL.md"), "utf8")).resolves.toContain("outbox_entry");
  });
});

describe("builder skill design-skill", () => {
  it("runs the design-skill package through explicit caller-routed subskills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-builder-objective-"));

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("skills/design-skill"),
        inputs: {
          objective: "Build a runx sourcey skill",
          project_context: "local fixture",
        },
        caller: createBuilderCaller(),
        env: process.env,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.receipt.kind).toBe("graph_execution");
      if (result.receipt.kind !== "graph_execution") {
        return;
      }
      expect(result.receipt.steps.map((step) => step.step_id)).toEqual(["decompose", "research", "author-harness"]);
      const output = JSON.parse(result.execution.stdout) as {
        harness_fixture: Array<{ kind: string }>;
      };
      expect(output.harness_fixture).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "skill",
          }),
        ]),
      );
      expect(result.receipt.steps).toHaveLength(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("builder skill improve-skill", () => {
  it("runs the improve-skill package from a failed harness summary to a bounded proposal", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-builder-improve-"));

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("skills/improve-skill"),
        inputs: {
          receipt_id: "rx_failed",
          receipt_summary: "harness failed because required context was missing",
          harness_output: "needs_resolution",
          skill_path: "oss/skills/sourcey",
          objective: "Improve Sourcey skill input resolution",
        },
        caller: createBuilderCaller(),
        env: process.env,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.receipt.kind).toBe("graph_execution");
      if (result.receipt.kind !== "graph_execution") {
        return;
      }
      expect(result.receipt.steps.map((step) => step.step_id)).toEqual(["review-receipt", "author-update-harness"]);
      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        acceptance_checks: expect.arrayContaining(["missing-context fixture passes"]),
      });
      expect(result.receipt.steps[0]?.skill).toContain("../review-receipt");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createBuilderCaller(): Caller {
  return {
    resolve: async (request) =>
      request.kind === "cognitive_work"
        ? {
            actor: "agent",
            payload: answerForAgentStep(request.id),
          }
        : undefined,
    report: () => undefined,
  };
}

function answerForAgentStep(questionId: string): unknown {
  if (questionId.includes("work-plan")) {
    return {
      objective_summary: "Build a governed runx skill",
      orchestration_steps: ["decompose", "research", "author-harness"],
      required_skills: ["work-plan", "prior-art", "write-harness"],
      open_questions: [],
    };
  }

  if (questionId.includes("prior-art")) {
    return {
      findings: ["Use portable skills and explicit agent-step boundaries."],
      recommended_flow: ["decompose", "research", "author-harness"],
      sources: [],
      risks: ["Do not hide agent work in helper scripts."],
    };
  }

  if (questionId.includes("review-receipt")) {
    return {
      verdict: "needs_update",
      failure_summary: "Missing-context handling needs a fixture.",
      improvement_proposals: ["Add an answers-backed missing-context fixture."],
      next_harness_checks: ["missing-context fixture passes"],
    };
  }

  if (questionId.includes("write-harness")) {
    return {
      skill_spec: {
        name: "sourcey",
      },
      execution_plan: {
        runner: "chain",
      },
      harness_fixture: [
        {
          kind: "skill",
          expect: {
            status: "success",
          },
        },
        {
          kind: "skill",
          expect: {
            status: "needs_resolution",
          },
        },
      ],
      acceptance_checks: ["missing-context fixture passes"],
    };
  }

  return {};
}

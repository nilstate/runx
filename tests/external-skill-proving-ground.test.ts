import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import {
  parseRunnerManifestYaml,
  validateRunnerManifest,
  type RunnerHarnessCase,
  type SkillRunnerManifest,
} from "@runxhq/core/parser";
import { runLocalSkill } from "@runxhq/core/runner-local";
import { createStructuredCaller } from "@runxhq/core/sdk";

interface ProvingGroundExpectation {
  readonly requestId: string;
  readonly inputKeys: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly currentContextTypes?: readonly string[];
  readonly sourceType?: "agent" | "agent-step";
  readonly minimumInstructionChars?: number;
}

interface HarnessProvingGroundScenario {
  readonly skillName: string;
  readonly runner?: string;
  readonly extraInputKeys?: readonly string[];
  readonly expectation: ProvingGroundExpectation;
}

interface PreparedRun {
  readonly runner?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

interface CustomProvingGroundScenario {
  readonly skillName: string;
  readonly prepare: (tempDir: string) => Promise<PreparedRun>;
  readonly expectation: ProvingGroundExpectation;
}

const harnessScenarios: readonly HarnessProvingGroundScenario[] = [
  {
    skillName: "content-pipeline",
    extraInputKeys: ["channel", "deliverable"],
    expectation: {
      requestId: "agent_step.research.output",
      inputKeys: ["objective", "audience", "domain", "operator_context", "target_entities", "channel", "deliverable"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "draft-content",
    expectation: {
      requestId: "agent_step.draft-content-draft.output",
      inputKeys: ["objective", "audience", "channel", "evidence_pack"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "ecosystem-vuln-scan",
    extraInputKeys: ["objective", "channel"],
    expectation: {
      requestId: "agent_step.vuln-scan.output",
      inputKeys: ["target", "objective", "channel"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "review-skill",
    expectation: {
      requestId: "agent_step.review-skill.output",
      inputKeys: ["skill_ref", "objective", "evidence_pack", "test_constraints"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "evolve",
    runner: "evolve",
    expectation: {
      requestId: "agent_step.evolve-plan.output",
      inputKeys: ["objective", "repo_root", "terminate"],
      allowedTools: ["fs.read", "git.status", "shell.exec"],
      currentContextTypes: ["repo_profile"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "issue-triage",
    runner: "respond",
    expectation: {
      requestId: "agent_step.issue-triage-respond.output",
      inputKeys: ["issue_url", "objective", "maintainer_context"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "write-harness",
    expectation: {
      requestId: "agent_step.write-harness.output",
      inputKeys: ["objective", "decomposition", "research"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "improve-skill",
    expectation: {
      requestId: "agent_step.review-receipt.output",
      inputKeys: ["receipt_id", "receipt_summary", "harness_output", "skill_path", "objective"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "ecosystem-brief",
    extraInputKeys: ["channel", "deliverable"],
    expectation: {
      requestId: "agent_step.research.output",
      inputKeys: ["objective", "audience", "domain", "operator_context", "target_entities", "channel", "deliverable"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "moltbook",
    runner: "scan",
    expectation: {
      requestId: "agent_step.moltbook-scan.output",
      inputKeys: ["objective", "community_context", "feed_snapshot"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "moltbook",
    runner: "post",
    expectation: {
      requestId: "agent_step.moltbook-post.output",
      inputKeys: ["outline", "community_context", "approval_note"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "work-plan",
    expectation: {
      requestId: "agent_step.work-plan.output",
      inputKeys: ["objective", "project_context", "change_set"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "design-skill",
    expectation: {
      requestId: "agent_step.work-plan.output",
      inputKeys: ["objective", "project_context"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "skill-lab",
    expectation: {
      requestId: "agent_step.work-plan.output",
      inputKeys: ["objective", "project_context", "thread_locator", "thread"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "review-receipt",
    expectation: {
      requestId: "agent_step.review-receipt.output",
      inputKeys: ["receipt_summary", "harness_output", "skill_path"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "research",
    expectation: {
      requestId: "agent_step.research.output",
      inputKeys: ["objective", "domain", "deliverable", "target_entities"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "scafld",
    runner: "agent",
    expectation: {
      requestId: "agent.scafld.output",
      inputKeys: ["task_id", "review_file", "review_prompt"],
      sourceType: "agent",
    },
  },
  {
    skillName: "prior-art",
    expectation: {
      requestId: "agent_step.prior-art.output",
      inputKeys: ["objective", "decomposition"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "skill-testing",
    extraInputKeys: ["channel"],
    expectation: {
      requestId: "agent_step.review-skill.output",
      inputKeys: ["skill_ref", "objective", "evidence_pack", "test_constraints", "channel"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "release",
    runner: "prepare",
    expectation: {
      requestId: "agent_step.release-prepare.output",
      inputKeys: ["project_root", "channel", "last_tag", "operator_context"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "reflect-digest",
    expectation: {
      requestId: "agent_step.reflect-digest.output",
      inputKeys: ["reflect_projections", "min_support"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "sourcey",
    expectation: {
      requestId: "agent_step.sourcey-discover.output",
      inputKeys: ["project"],
      allowedTools: ["fs.read", "git.status", "git.current_branch", "git.diff_name_only", "cli.capture_help"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "request-triage",
    expectation: {
      requestId: "agent_step.request-triage.output",
      inputKeys: ["thread_title", "thread_body", "thread_locator", "outbox_entry", "product_context", "operator_context"],
      sourceType: "agent-step",
    },
  },
  {
    skillName: "vuln-scan",
    runner: "scan",
    expectation: {
      requestId: "agent_step.vuln-scan.output",
      inputKeys: ["target", "objective"],
      sourceType: "agent-step",
    },
  },
] as const;

const customScenarios: readonly CustomProvingGroundScenario[] = [
  {
    skillName: "issue-to-pr",
    prepare: async (tempDir) => {
      const lane = await createIssueLaneFixture(tempDir);
      return {
        inputs: {
          fixture: lane.repoDir,
          task_id: "issue-to-pr-proving-ground",
          thread_title: "Clarify the external proving-ground guide",
          thread_body: "Operators should be able to run the lane with no hidden caller help.",
          thread_locator: "github://runxhq/runx/issues/241",
          target_repo: "runxhq/runx",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: ".ai/specs/drafts/issue-to-pr-proving-ground.yaml",
          scafld_bin: lane.scafldBin,
        },
        env: lane.env,
      };
    },
    expectation: {
      requestId: "agent_step.issue-to-pr-author-spec.output",
      inputKeys: [
        "fixture",
        "task_id",
        "thread_title",
        "thread_body",
        "thread_locator",
        "target_repo",
        "size",
        "risk",
        "phase",
        "draft_spec_path",
        "scafld_bin",
      ],
      allowedTools: ["fs.read", "git.status"],
      sourceType: "agent-step",
    },
  },
] as const;

describe("official skills prove out cleanly with a fresh caller", () => {
  for (const scenario of harnessScenarios) {
    it(
      `${scenario.skillName} yields a first-class fresh-caller boundary`,
      async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), `proving-ground-${scenario.skillName}-`));

        try {
          const prepared = await prepareHarnessScenario(scenario);
          await assertFreshBoundary({ skillName: scenario.skillName, prepared, expectation: scenario.expectation, tempDir });
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
      20_000,
    );
  }

  for (const scenario of customScenarios) {
    it(
      `${scenario.skillName} reaches its first authored boundary without hidden caller help`,
      async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), `proving-ground-${scenario.skillName}-`));

        try {
          const prepared = await scenario.prepare(tempDir);
          await assertFreshBoundary({ skillName: scenario.skillName, prepared, expectation: scenario.expectation, tempDir });
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
      20_000,
    );
  }
});

async function assertFreshBoundary(options: {
  readonly skillName: string;
  readonly prepared: PreparedRun;
  readonly expectation: ProvingGroundExpectation;
  readonly tempDir: string;
}): Promise<void> {
  const caller = createStructuredCaller();
  const result = await runLocalSkill({
    skillPath: path.resolve("skills", options.skillName),
    runner: options.prepared.runner,
    inputs: options.prepared.inputs,
    caller,
    adapters: createDefaultSkillAdapters(),
    env: options.prepared.env ?? { ...process.env, RUNX_CWD: process.cwd() },
    receiptDir: path.join(options.tempDir, "receipts"),
    runxHome: path.join(options.tempDir, "home"),
  });

  expect(result.status).toBe("needs_resolution");
  if (result.status !== "needs_resolution") {
    return;
  }

  expect(caller.trace.resolutions).toHaveLength(1);
  expect(caller.trace.resolutions[0]?.response).toBeUndefined();
  expect(result.requests).toHaveLength(1);

  const request = result.requests[0];
  expect(request?.id).toBe(options.expectation.requestId);
  expect(request?.kind).toBe("cognitive_work");
  if (!request || request.kind !== "cognitive_work") {
    return;
  }

  expect(request.work.source_type).toBe(options.expectation.sourceType ?? "agent-step");
  expect(request.work.envelope.instructions.trim().length).toBeGreaterThanOrEqual(
    options.expectation.minimumInstructionChars ?? 80,
  );

  for (const key of options.expectation.inputKeys) {
    expect(request.work.envelope.inputs).toHaveProperty(key);
  }

  if (options.expectation.allowedTools) {
    expect(request.work.envelope.allowed_tools).toEqual(options.expectation.allowedTools);
  }

  if (options.expectation.currentContextTypes) {
    expect(request.work.envelope.current_context.map((artifact) => artifact.type)).toEqual(
      options.expectation.currentContextTypes,
    );
  }
}

async function prepareHarnessScenario(scenario: HarnessProvingGroundScenario): Promise<PreparedRun> {
  const manifest = await readManifest(scenario.skillName);
  const runnerName = scenario.runner ?? defaultRunnerName(manifest);
  const harnessCase = selectHarnessCase(manifest, runnerName);
  const inputKeys = new Set([...Object.keys(harnessCase.inputs), ...(scenario.extraInputKeys ?? [])]);

  expect([...inputKeys].sort()).toEqual([...new Set(scenario.expectation.inputKeys)].sort());

  return {
    runner: runnerName,
    inputs: harnessCase.inputs,
    env: {
      ...process.env,
      RUNX_CWD: process.cwd(),
      ...harnessCase.env,
    },
  };
}

async function readManifest(skillName: string): Promise<SkillRunnerManifest> {
  const raw = await readFile(path.resolve("skills", skillName, "X.yaml"), "utf8");
  return validateRunnerManifest(parseRunnerManifestYaml(raw));
}

function defaultRunnerName(manifest: SkillRunnerManifest): string {
  const explicit = Object.values(manifest.runners).find((runner) => runner.default);
  if (explicit) {
    return explicit.name;
  }

  const names = Object.keys(manifest.runners).filter((name) => name !== "agent");
  if (names.length === 1) {
    return names[0]!;
  }

  throw new Error(`Unable to infer default runner for ${manifest.skill ?? "unknown skill"}.`);
}

function selectHarnessCase(manifest: SkillRunnerManifest, runnerName: string): RunnerHarnessCase {
  const harnessCase = manifest.harness?.cases.find((entry) => (entry.runner ?? defaultRunnerName(manifest)) === runnerName);
  if (!harnessCase) {
    throw new Error(`Expected inline harness case for ${manifest.skill ?? "unknown skill"} runner ${runnerName}.`);
  }
  return harnessCase;
}

async function createIssueLaneFixture(tempDir: string): Promise<{
  readonly repoDir: string;
  readonly scafldBin: string;
  readonly env: NodeJS.ProcessEnv;
}> {
  const repoDir = path.join(tempDir, "repo");
  const scafldBin = path.join(tempDir, "fake-scafld.cjs");

  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, "README.md"), "# proving ground fixture\n");
  await writeFile(
    scafldBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const [, , command, taskId] = process.argv;
if (command === "init") {
  const aiDir = path.join(process.cwd(), ".ai");
  fs.mkdirSync(path.join(aiDir, "specs", "drafts"), { recursive: true });
  process.stdout.write(JSON.stringify({
    command: "init",
    state: { status: "ready" },
    result: { initialized: true }
  }));
  process.exit(0);
}

if (command !== "new") {
  process.stderr.write("fake scafld only supports init and new for proving-ground tests\\n");
  process.exit(1);
}

const draftDir = path.join(process.cwd(), ".ai", "specs", "drafts");
fs.mkdirSync(draftDir, { recursive: true });
fs.writeFileSync(
  path.join(draftDir, \`\${taskId}.yaml\`),
  [
    'spec_version: "1.1"',
    \`task_id: "\${taskId}"\`,
    'status: "draft"',
    'task:',
    '  title: "Proving Ground Fixture"',
    '  summary: "Draft spec created by the fake scafld proving-ground stub"',
  ].join("\\n"),
);
process.stdout.write(JSON.stringify({
  command: "new",
  task_id: taskId,
  state: { status: "draft", file: \`.ai/specs/drafts/\${taskId}.yaml\` },
  result: { valid: true, file: \`.ai/specs/drafts/\${taskId}.yaml\`, errors: [] }
}));
`,
    { mode: 0o755 },
  );

  runChecked("git", ["init"], repoDir);
  runChecked("git", ["config", "user.email", "proving-ground@example.com"], repoDir);
  runChecked("git", ["config", "user.name", "Proving Ground Fixture"], repoDir);
  runChecked("git", ["add", "."], repoDir);
  runChecked("git", ["commit", "-m", "init"], repoDir);

  return {
    repoDir,
    scafldBin,
    env: {
      ...process.env,
      RUNX_CWD: process.cwd(),
    },
  };
}

function runChecked(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    [
      `Command failed: ${command} ${args.join(" ")}`,
      result.stdout?.trim() || "",
      result.stderr?.trim() || "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

import path from "node:path";

import {
  appendLedgerEntries,
  createRunEventEntry,
  readLedgerEntries,
  SYSTEM_ARTIFACT_TYPES,
  type ArtifactEnvelope,
} from "@runxhq/core/artifacts";
import { createFileKnowledgeStore } from "@runxhq/core/knowledge";
import { resolveRunxKnowledgeDir } from "@runxhq/core/config";
import type { PostRunReflectPolicy } from "@runxhq/core/parser";
import type { LocalReceipt } from "@runxhq/core/receipts";

import type { Caller } from "./index.js";

export interface ReflectProjectionOptions {
  readonly caller: Caller;
  readonly receipt: LocalReceipt;
  readonly receiptDir: string;
  readonly runId: string;
  readonly skillName: string;
  readonly knowledgeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly selectedRunnerName?: string;
  readonly postRunReflectPolicy?: PostRunReflectPolicy;
  readonly involvedAgentMediatedWork: boolean;
}

interface LocalReflectProjection {
  readonly schema_version: "runx.reflect.v1";
  readonly skill_ref: string;
  readonly receipt_id: string;
  readonly run_id: string;
  readonly receipt_kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly selected_runner?: string;
  readonly policy: PostRunReflectPolicy;
  readonly mediation: "agentic" | "deterministic";
  readonly summary: string;
  readonly signals: readonly string[];
  readonly ledger: {
    readonly event_kinds: readonly string[];
    readonly artifact_count: number;
    readonly artifact_types: readonly string[];
  };
  readonly step_summary?: {
    readonly total_steps: number;
    readonly successful_steps: number;
    readonly failed_steps: number;
    readonly runner_types: readonly string[];
  };
  readonly projected_at: string;
}

export async function projectReflectIfEnabled(options: ReflectProjectionOptions): Promise<void> {
  const policy = options.postRunReflectPolicy ?? "never";
  if (!shouldProjectReflect(policy, options.involvedAgentMediatedWork)) {
    return;
  }

  const knowledgeDir = resolveOptionalKnowledgeDir(options);
  if (!knowledgeDir) {
    return;
  }

  const projectedAt = options.receipt.completed_at ?? new Date().toISOString();

  try {
    const ledgerEntries = await readLedgerEntries(options.receiptDir, options.runId);
    const reflectProjection = buildReflectProjection({
      receipt: options.receipt,
      runId: options.runId,
      skillName: options.skillName,
      selectedRunnerName: options.selectedRunnerName,
      policy,
      involvedAgentMediatedWork: options.involvedAgentMediatedWork,
      ledgerEntries,
      projectedAt,
    });
    const projectionEntry = await createFileKnowledgeStore(knowledgeDir).addProjection({
      project: resolveKnowledgeProject(options.env),
      scope: "reflect",
      key: `receipt:${options.receipt.id}`,
      value: reflectProjection,
      source: "post_run.reflect",
      confidence: 1,
      freshness: "derived",
      receiptId: options.receipt.id,
      createdAt: projectedAt,
    });
    await appendLedgerEntries({
      receiptDir: options.receiptDir,
      runId: options.runId,
      entries: [
        createRunEventEntry({
          runId: options.runId,
          producer: {
            skill: options.skillName,
            runner: options.receipt.kind === "graph_execution" ? "graph" : options.receipt.source_type,
          },
          kind: "reflect_projected",
          status: "success",
          detail: {
            projection_entry_id: projectionEntry.entry_id,
            receipt_id: options.receipt.id,
            policy,
            mediation: reflectProjection.mediation,
          },
          createdAt: projectedAt,
        }),
      ],
    });
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Post-run reflect projection failed; continuing with the persisted receipt.",
      data: {
        receiptId: options.receipt.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function buildReflectProjection(options: {
  readonly receipt: LocalReceipt;
  readonly runId: string;
  readonly skillName: string;
  readonly selectedRunnerName?: string;
  readonly policy: PostRunReflectPolicy;
  readonly involvedAgentMediatedWork: boolean;
  readonly ledgerEntries: readonly ArtifactEnvelope[];
  readonly projectedAt: string;
}): LocalReflectProjection {
  const eventKinds = uniqueStrings(
    options.ledgerEntries
      .filter((entry) => entry.type === "run_event")
      .map((entry) => String(entry.data.kind)),
  );
  const artifactEntries = options.ledgerEntries.filter((entry) => entry.type === null || !SYSTEM_ARTIFACT_TYPES.has(entry.type));
  const artifactTypes = uniqueStrings(
    artifactEntries
      .map((entry) => entry.type)
      .filter((type): type is string => typeof type === "string"),
  );
  const signals = [
    options.involvedAgentMediatedWork ? "agent-mediated" : "deterministic",
    options.receipt.kind === "graph_execution" ? "graph-execution" : "skill-execution",
    options.receipt.status === "failure" ? "run-failed" : "run-succeeded",
    ...(artifactEntries.length > 0 ? ["artifacts-emitted"] : []),
    ...(eventKinds.includes("step_waiting_resolution") ? ["paused-before-completion"] : []),
  ];

  const stepSummary =
    options.receipt.kind === "graph_execution"
      ? {
          total_steps: options.receipt.steps.length,
          successful_steps: options.receipt.steps.filter((step) => step.status === "success").length,
          failed_steps: options.receipt.steps.filter((step) => step.status === "failure").length,
          runner_types: uniqueStrings(options.receipt.steps.map((step) => step.runner ?? "default")),
        }
      : undefined;

  return {
    schema_version: "runx.reflect.v1",
    skill_ref: options.skillName,
    receipt_id: options.receipt.id,
    run_id: options.runId,
    receipt_kind: options.receipt.kind,
    status: options.receipt.status,
    selected_runner: options.selectedRunnerName,
    policy: options.policy,
    mediation: options.involvedAgentMediatedWork ? "agentic" : "deterministic",
    summary:
      options.receipt.kind === "graph_execution"
        ? `${options.skillName} ${options.receipt.status} with ${options.receipt.steps.length} step(s)`
        : `${options.skillName} ${options.receipt.status} via ${options.receipt.source_type}`,
    signals,
    ledger: {
      event_kinds: eventKinds,
      artifact_count: artifactEntries.length,
      artifact_types: artifactTypes,
    },
    step_summary: stepSummary,
    projected_at: options.projectedAt,
  };
}

function shouldProjectReflect(policy: PostRunReflectPolicy, involvedAgentMediatedWork: boolean): boolean {
  if (policy === "always") {
    return true;
  }
  if (policy === "auto") {
    return involvedAgentMediatedWork;
  }
  return false;
}

function resolveOptionalKnowledgeDir(options: {
  readonly knowledgeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (options.knowledgeDir) {
    return options.knowledgeDir;
  }
  if (!options.env?.RUNX_KNOWLEDGE_DIR) {
    return undefined;
  }
  return resolveRunxKnowledgeDir(options.env);
}

function resolveKnowledgeProject(env?: NodeJS.ProcessEnv): string {
  return path.resolve(env?.RUNX_PROJECT ?? env?.RUNX_CWD ?? env?.INIT_CWD ?? process.cwd());
}

function uniqueStrings(values: readonly (string | null | undefined)[]): readonly string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)),
  );
}

import {
  appendLedgerEntries,
  createReceiptLinkEntry,
  createRunEventEntry,
  type ArtifactEnvelope,
} from "@runxhq/core/artifacts";
import type { GraphStep, ValidatedSkill } from "@runxhq/core/parser";

import { graphStepRunner } from "./graph-reporting.js";

export async function appendSkillLedgerEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly skill: ValidatedSkill;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "failure";
  readonly artifactEnvelopes: readonly ArtifactEnvelope[];
  readonly receiptId: string;
  readonly includeRunStarted?: boolean;
  readonly runStartedDetail?: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const producer = {
    skill: options.skill.name,
    runner: options.skill.source.type,
  };
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      ...(options.includeRunStarted === false
        ? []
        : [
            createRunEventEntry({
              runId: options.runId,
              producer,
              kind: "run_started",
              status: "started",
              createdAt: options.startedAt,
              detail: options.runStartedDetail,
            }),
          ]),
      ...options.artifactEnvelopes,
      ...options.artifactEnvelopes.map((envelope) =>
        createReceiptLinkEntry({
          runId: options.runId,
          producer,
          artifactId: envelope.meta.artifact_id,
          receiptId: options.receiptId,
          createdAt: options.completedAt,
        }),
      ),
      createRunEventEntry({
        runId: options.runId,
        producer,
        kind: "run_completed",
        status: options.status,
        createdAt: options.completedAt,
        detail: {
          receipt_id: options.receiptId,
        },
      }),
    ],
  });
}

export async function appendPendingSkillLedgerEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly skill: ValidatedSkill;
  readonly startedAt: string;
  readonly kind: "resolution_requested";
  readonly detail: Readonly<Record<string, unknown>>;
  readonly includeRunStarted?: boolean;
}): Promise<void> {
  const producer = {
    skill: options.skill.name,
    runner: options.skill.source.type,
  };
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      ...(options.includeRunStarted === false
        ? []
        : [
            createRunEventEntry({
              runId: options.runId,
              producer,
              kind: "run_started",
              status: "started",
              createdAt: options.startedAt,
            }),
          ]),
      createRunEventEntry({
        runId: options.runId,
        producer,
        kind: options.kind,
        status: "waiting",
        detail: options.detail,
        createdAt: options.startedAt,
      }),
    ],
  });
}

export async function appendGraphLedgerEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly stepId: string;
  readonly skill: ValidatedSkill;
  readonly artifactEnvelopes: readonly ArtifactEnvelope[];
  readonly receiptId: string;
  readonly status: "success" | "failure";
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}): Promise<void> {
  const producer = {
    skill: options.topLevelSkillName,
    runner: "graph",
  };
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      ...options.artifactEnvelopes,
      ...options.artifactEnvelopes.map((envelope) =>
        createReceiptLinkEntry({
          runId: options.runId,
          stepId: options.stepId,
          producer,
          artifactId: envelope.meta.artifact_id,
          receiptId: options.receiptId,
          createdAt: options.createdAt,
        }),
      ),
      createRunEventEntry({
        runId: options.runId,
        stepId: options.stepId,
        producer,
        kind: options.status === "success" ? "step_succeeded" : "step_failed",
        status: options.status,
        detail: {
          skill: options.skill.name,
          receipt_id: options.receiptId,
          ...options.detail,
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

export async function appendPendingGraphLedgerEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly stepId: string;
  readonly kind: "step_waiting_resolution";
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}): Promise<void> {
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      createRunEventEntry({
        runId: options.runId,
        stepId: options.stepId,
        producer: {
          skill: options.topLevelSkillName,
          runner: "graph",
        },
        kind: options.kind,
        status: "waiting",
        detail: options.detail,
        createdAt: options.createdAt,
      }),
    ],
  });
}

export async function appendGraphStepStartedLedgerEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly step: GraphStep;
  readonly reference: string;
  readonly createdAt: string;
}): Promise<void> {
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      createRunEventEntry({
        runId: options.runId,
        stepId: options.step.id,
        producer: {
          skill: options.topLevelSkillName,
          runner: "graph",
        },
        kind: "step_started",
        status: "started",
        detail: {
          skill: options.reference,
          runner: graphStepRunner(options.step) ?? "default",
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

export async function appendGraphStepFailureLedgerEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly stepId: string;
  readonly reason: string;
  readonly createdAt?: string;
}): Promise<void> {
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      createRunEventEntry({
        runId: options.runId,
        stepId: options.stepId,
        producer: {
          skill: options.topLevelSkillName,
          runner: "graph",
        },
        kind: "step_failed",
        status: "failure",
        detail: {
          reason: options.reason,
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

export async function appendGraphCompletedLedgerEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly receiptId: string;
  readonly stepCount: number;
  readonly status: "success" | "failure";
  readonly createdAt: string;
}): Promise<void> {
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      createRunEventEntry({
        runId: options.runId,
        producer: {
          skill: options.topLevelSkillName,
          runner: "graph",
        },
        kind: "graph_completed",
        status: options.status,
        detail: {
          receipt_id: options.receiptId,
          step_count: options.stepCount,
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

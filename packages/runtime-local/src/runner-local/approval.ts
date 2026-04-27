import type { ApprovalGate } from "@runxhq/core/executor";
import type { SkillSandbox, ValidatedSkill } from "@runxhq/core/parser";
import type { LocalSkillReceipt } from "@runxhq/core/receipts";
import { writeLocalReceipt } from "@runxhq/core/receipts";

import type { NormalizedExecutionSemantics } from "./execution-semantics.js";
import { defaultReceiptDir } from "./receipt-paths.js";
import { mergeMetadata, runnerTrustMetadata } from "./runner-helpers.js";
import type { ApprovalDecision, Caller } from "./index.js";

export async function approveSandboxEscalationIfNeeded(
  skill: ValidatedSkill,
  caller: Caller,
): Promise<ApprovalDecision | undefined> {
  if (!sandboxRequiresApproval(skill.source.sandbox)) {
    return undefined;
  }

  const gate: ApprovalGate = {
    id: `sandbox.${skill.name}.unrestricted-local-dev`,
    type: "sandbox",
    reason: `Skill '${skill.name}' requests unrestricted-local-dev sandbox authority.`,
    summary: {
      skill_name: skill.name,
      source_type: skill.source.type,
      sandbox_profile: "unrestricted-local-dev",
    },
  };
  await caller.report({
    type: "resolution_requested",
    message: gate.reason,
    data: {
      kind: "approval",
      requestId: gate.id,
      gate,
    },
  });
  const resolution = await caller.resolve({
    id: gate.id,
    kind: "approval",
    gate,
  });
  const approved = typeof resolution?.payload === "boolean" ? resolution.payload : false;
  await caller.report({
    type: "resolution_resolved",
    message: approved ? `Approval ${gate.id} approved.` : `Approval ${gate.id} denied.`,
    data: {
      kind: "approval",
      requestId: gate.id,
      gate,
      approved,
      actor: resolution?.actor ?? "human",
    },
  });
  return {
    gate,
    approved,
  };
}

export function withSandboxApproval(skill: ValidatedSkill, approvedSandboxEscalation: boolean): ValidatedSkill {
  if (!approvedSandboxEscalation || !skill.source.sandbox) {
    return skill;
  }

  const sandbox: SkillSandbox = {
    ...skill.source.sandbox,
    approvedEscalation: true,
  };
  return {
    ...skill,
    source: {
      ...skill.source,
      sandbox,
    },
  };
}

export async function writeApprovalDeniedReceipt(options: {
  readonly skill: ValidatedSkill;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly reasons: readonly string[];
  readonly approval: ApprovalDecision;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly executionSemantics: NormalizedExecutionSemantics;
  readonly runOptions: {
    readonly receiptDir?: string;
    readonly runxHome?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly parentReceipt?: string;
    readonly contextFrom?: readonly string[];
  };
}): Promise<LocalSkillReceipt> {
  const startedAt = new Date().toISOString();
  return await writeLocalReceipt({
    receiptDir: options.runOptions.receiptDir ?? defaultReceiptDir(options.runOptions.env),
    runxHome: options.runOptions.runxHome ?? options.runOptions.env?.RUNX_HOME,
    skillName: options.skill.name,
    sourceType: options.skill.source.type,
    inputs: options.inputs,
    stdout: "",
    stderr: options.reasons.join("; "),
    execution: {
      status: "failure",
      exitCode: null,
      signal: null,
      durationMs: 0,
      errorMessage: options.reasons.join("; "),
      metadata: mergeMetadata(
        runnerTrustMetadata(options.skill.source.type),
        approvalReceiptMetadata(options.approval),
        options.receiptMetadata,
      ),
    },
    startedAt,
    completedAt: startedAt,
    parentReceipt: options.runOptions.parentReceipt,
    contextFrom: options.runOptions.contextFrom,
    disposition: "policy_denied",
    inputContext: options.executionSemantics.inputContext,
    outcomeState: options.executionSemantics.outcomeState,
    outcome: options.executionSemantics.outcome,
    surfaceRefs: options.executionSemantics.surfaceRefs,
    evidenceRefs: options.executionSemantics.evidenceRefs,
  });
}

export function approvalReceiptMetadata(approval: ApprovalDecision): Readonly<Record<string, unknown>> {
  return {
    approval: {
      gate_id: approval.gate.id,
      gate_type: approval.gate.type ?? "unspecified",
      decision: approval.approved ? "approved" : "denied",
      reason: approval.gate.reason,
      summary: approval.gate.summary,
    },
  };
}

function sandboxRequiresApproval(sandbox: SkillSandbox | undefined): boolean {
  return sandbox?.profile === "unrestricted-local-dev" && sandbox.approvedEscalation !== true;
}

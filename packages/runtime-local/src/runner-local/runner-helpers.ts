import path from "node:path";

import type { ArtifactEnvelope } from "@runxhq/core/artifacts";
import { createFileKnowledgeStore } from "@runxhq/core/knowledge";
import { resolveRunxKnowledgeDir } from "@runxhq/core/config";
import type { GraphStep, ValidatedSkill } from "@runxhq/core/parser";
import type { GraphScopeGrant } from "@runxhq/core/policy";
import { hashStable, type LocalReceipt } from "@runxhq/core/receipts";
import { isPlainRecord, isRecord } from "@runxhq/core/util";

export interface RetryReceiptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly ruleFired: string;
  readonly idempotencyKeyHash?: string;
}

export async function indexReceiptIfEnabled(
  receipt: LocalReceipt,
  receiptDir: string,
  options: {
    readonly knowledgeDir?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const knowledgeDir = resolveOptionalKnowledgeDir(options);
  if (!knowledgeDir) {
    return;
  }
  await createFileKnowledgeStore(knowledgeDir).indexReceipt({
    receipt,
    receiptPath: path.join(receiptDir, `${receipt.id}.json`),
    project: resolveKnowledgeProject(options.env),
  });
}

export function isDomainArtifactEnvelope(entry: ArtifactEnvelope): boolean {
  return entry.type !== null && !new Set(["run_event", "receipt_link", "credential_resolution", "retry", "skill_state", "auth_resolution"]).has(entry.type);
}

export function isAgentMediatedSource(sourceType: string | undefined): boolean {
  return sourceType === "agent" || sourceType === "agent-step";
}

export function resolveOptionalKnowledgeDir(options: {
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

export function resolveKnowledgeProject(env?: NodeJS.ProcessEnv): string {
  return path.resolve(env?.RUNX_PROJECT ?? env?.RUNX_CWD ?? env?.INIT_CWD ?? process.cwd());
}

export function defaultLocalGraphGrant(): GraphScopeGrant {
  return {
    grant_id: "local-default",
    scopes: ["*"],
  };
}

export function parseStructuredOutput(stdout: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function buildRetryReceiptContext(
  step: GraphStep,
  inputs: Readonly<Record<string, unknown>>,
  attempt: number,
  skill: ValidatedSkill,
  retry: { readonly maxAttempts: number } | undefined,
): {
  readonly idempotencyKey?: string;
  readonly receipt?: RetryReceiptContext;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
} {
  const maxAttempts = retry?.maxAttempts ?? 1;
  const idempotencyKey = resolveIdempotencyKey(step.idempotencyKey ?? skill.idempotency?.key, inputs);
  const idempotencyKeyHash = idempotencyKey ? hashStable({ idempotencyKey }) : undefined;
  if (maxAttempts <= 1 && !idempotencyKeyHash) {
    return {
      idempotencyKey,
    };
  }

  const receipt: RetryReceiptContext = {
    attempt,
    maxAttempts,
    ruleFired: attempt === 1 ? "initial_attempt" : "retry_attempt",
    idempotencyKeyHash,
  };
  return {
    idempotencyKey,
    receipt,
    receiptMetadata: {
      retry: {
        attempt,
        max_attempts: maxAttempts,
        rule_fired: receipt.ruleFired,
        idempotency_key_hash: idempotencyKeyHash,
      },
    },
  };
}

export function mergeMetadata(
  ...metadata: readonly (Readonly<Record<string, unknown>> | undefined)[]
): Readonly<Record<string, unknown>> | undefined {
  const merged = metadata
    .filter((item): item is Readonly<Record<string, unknown>> => Boolean(item))
    .reduce<Record<string, unknown>>((accumulator, item) => mergeRecord(accumulator, item), {});
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}

export function runnerTrustMetadata(sourceType: string): Readonly<Record<string, unknown>> {
  const approvalMediated = sourceType === "approval";
  const agentMediated = sourceType === "agent" || sourceType === "agent-step";
  return {
    runner: {
      type: sourceType,
      enforcement: approvalMediated ? "approval-mediated" : agentMediated ? "agent-mediated" : "runx-enforced",
      attestation: approvalMediated ? "decision-reported" : agentMediated ? "agent-reported" : "runx-observed",
    },
  };
}

function resolveIdempotencyKey(template: string | undefined, inputs: Readonly<Record<string, unknown>>): string | undefined {
  if (!template) {
    return undefined;
  }
  const resolved = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
    stringifyContextValue(resolveInputPath(inputs, key)),
  );
  return resolved.trim() === "" ? undefined : resolved;
}

function resolveInputPath(inputs: Readonly<Record<string, unknown>>, inputPath: string): unknown {
  return inputPath.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value) || !(key in value)) {
      return undefined;
    }
    return value[key];
  }, inputs);
}

function stringifyContextValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function mergeRecord(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] = isPlainRecord(existing) && isPlainRecord(value) ? mergeRecord(existing, value) : value;
  }
  return merged;
}

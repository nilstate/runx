import { readFile } from "node:fs/promises";
import path from "node:path";

import { readLedgerEntries } from "../artifacts/index.js";
import type { Question, ResolutionRequest } from "../executor/index.js";
import { validateOutboxEntry, validateThread } from "../knowledge/index.js";
import type { SkillInput, ValidatedSkill } from "../parser/index.js";

import { defaultReceiptDir } from "./receipt-paths.js";
import type { RunLocalSkillOptions } from "./index.js";

export async function resolveInputs(
  skill: ValidatedSkill,
  options: RunLocalSkillOptions,
): Promise<
  | { readonly status: "resolved"; readonly inputs: Readonly<Record<string, unknown>> }
  | { readonly status: "needs_resolution"; readonly request: ResolutionRequest }
> {
  const answers = options.answersPath ? await readAnswersFile(options.answersPath) : {};
  const resolved = materializeDeclaredInputs(skill.inputs);
  const resumedInputs = options.resumeFromRunId
    ? await readResumedInputs(options.receiptDir ?? defaultReceiptDir(options.env), options.resumeFromRunId)
    : {};
  const providedInputs = normalizeDeclaredInputAliases(skill.inputs, options.inputs ?? {});

  assignDefined(resolved, resumedInputs);
  assignDefined(resolved, answers);
  assignDefined(resolved, providedInputs);

  const missing = missingRequiredInputs(skill.inputs, resolved);
  if (missing.length === 0) {
    return {
      status: "resolved",
      inputs: resolved,
    };
  }

  const request = buildInputResolutionRequest(skill, missing);
  await options.caller.report({
    type: "resolution_requested",
    message: `Resolution requested for ${request.id}.`,
    data: { kind: request.kind, requestId: request.id },
  });
  const resolution = await options.caller.resolve(request);
  if (resolution && isRecord(resolution.payload)) {
    Object.assign(resolved, resolution.payload);
  }
  if (resolution !== undefined) {
    await options.caller.report({
      type: "resolution_resolved",
      message: `Resolution satisfied for ${request.id}.`,
      data: { kind: request.kind, requestId: request.id, actor: resolution.actor },
    });
  }

  const stillMissing = missingRequiredInputs(skill.inputs, resolved);
  if (stillMissing.length > 0) {
    return {
      status: "needs_resolution",
      request: buildInputResolutionRequest(skill, stillMissing),
    };
  }

  const normalizedInputs = normalizeRuntimeInputs(resolved);
  return {
    status: "resolved",
    inputs: normalizedInputs,
  };
}

export async function readResumedSelectedRunner(receiptDir: string, runId: string): Promise<string | undefined> {
  const entries = await readLedgerEntries(receiptDir, runId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    const detail = isPlainRecord(entry.data.detail) ? entry.data.detail : undefined;
    if (!detail || kind !== "resolution_requested") {
      continue;
    }
    return typeof detail.selected_runner === "string" ? detail.selected_runner : undefined;
  }
  return undefined;
}

function buildInputResolutionRequest(skill: ValidatedSkill, questions: readonly Question[]): ResolutionRequest {
  return {
    id: `input.${normalizeQuestionId(skill.name)}.${questions.map((question) => question.id).join(".")}`,
    kind: "input",
    questions,
  };
}

function normalizeDeclaredInputAliases(
  declaredInputs: Readonly<Record<string, SkillInput>>,
  providedInputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {};
  const providedKeys = new Set(Object.keys(providedInputs));
  for (const [key, value] of Object.entries(providedInputs)) {
    const targetKey = resolveDeclaredInputAliasKey(declaredInputs, key);
    if (targetKey !== key && providedKeys.has(targetKey)) {
      continue;
    }
    normalized[targetKey] = value;
  }
  return normalized;
}

export function materializeDeclaredInputs(
  declaredInputs: Readonly<Record<string, SkillInput>>,
  providedInputs: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, input] of Object.entries(declaredInputs)) {
    if (input.default !== undefined) {
      resolved[key] = input.default;
    }
  }
  assignDefined(resolved, normalizeDeclaredInputAliases(declaredInputs, providedInputs));
  return resolved;
}

function normalizeRuntimeInputs(
  inputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = { ...inputs };
  const thread = normalized.thread === undefined
    ? undefined
    : validateThread(normalized.thread, "inputs.thread");
  const outboxEntry = normalized.outbox_entry === undefined
    ? undefined
    : validateOutboxEntry(normalized.outbox_entry, "inputs.outbox_entry");
  const threadLocator = typeof normalized.thread_locator === "string"
    ? normalized.thread_locator
    : undefined;

  if (thread) {
    normalized.thread = thread;
    if (threadLocator && thread.thread_locator !== threadLocator) {
      throw new Error(
        `inputs.thread.thread_locator '${thread.thread_locator}' does not match inputs.thread_locator '${threadLocator}'.`,
      );
    }
  }

  if (outboxEntry) {
    normalized.outbox_entry = outboxEntry;
    if (threadLocator && outboxEntry.thread_locator && outboxEntry.thread_locator !== threadLocator) {
      throw new Error(
        `inputs.outbox_entry.thread_locator '${outboxEntry.thread_locator}' does not match inputs.thread_locator '${threadLocator}'.`,
      );
    }
  }

  if (thread && outboxEntry?.thread_locator && outboxEntry.thread_locator !== thread.thread_locator) {
    throw new Error(
      `inputs.outbox_entry.thread_locator '${outboxEntry.thread_locator}' does not match inputs.thread.thread_locator '${thread.thread_locator}'.`,
    );
  }

  return normalized;
}

function resolveDeclaredInputAliasKey(
  declaredInputs: Readonly<Record<string, SkillInput>>,
  key: string,
): string {
  if (declaredInputs[key] !== undefined) {
    return key;
  }
  const snakeCase = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  if (snakeCase !== key && declaredInputs[snakeCase] !== undefined) {
    return snakeCase;
  }
  return key;
}

async function readResumedInputs(receiptDir: string, runId: string): Promise<Record<string, unknown>> {
  const entries = await readLedgerEntries(receiptDir, runId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    const detail = isPlainRecord(entry.data.detail) ? entry.data.detail : undefined;
    if (!detail || kind !== "resolution_requested") {
      continue;
    }
    if (isPlainRecord(detail.inputs)) {
      return { ...detail.inputs };
    }
  }
  return {};
}

async function readAnswersFile(answersPath: string): Promise<Record<string, unknown>> {
  const contents = await readFile(path.resolve(answersPath), "utf8");
  const parsed = JSON.parse(contents) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("--answers file must contain a JSON object.");
  }

  const answers = parsed.answers;
  if (answers === undefined) {
    return parsed;
  }
  if (!isRecord(answers)) {
    throw new Error("--answers answers field must be an object.");
  }
  return answers;
}

function missingRequiredInputs(
  inputs: Readonly<Record<string, SkillInput>>,
  resolved: Readonly<Record<string, unknown>>,
): readonly Question[] {
  const questions: Question[] = [];

  for (const [id, input] of Object.entries(inputs)) {
    if (!input.required) {
      continue;
    }

    const value = resolved[id];
    if (value === undefined || value === null || value === "") {
      questions.push({
        id,
        prompt: input.description ?? `Provide ${id}`,
        description: input.description,
        required: true,
        type: input.type,
      });
    }
  }

  return questions;
}

function normalizeQuestionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function assignDefined(target: Record<string, unknown>, value: Readonly<Record<string, unknown>>): void {
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate !== undefined) {
      target[key] = candidate;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

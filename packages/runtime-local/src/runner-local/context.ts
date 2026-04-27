import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  SYSTEM_ARTIFACT_TYPES,
  readLedgerEntries,
  type ArtifactEnvelope,
} from "@runxhq/core/artifacts";
import {
  type AgentContextProvenance,
  type Context,
  type ContextDocument,
  type QualityProfileContext,
} from "@runxhq/core/executor";
import { type ValidatedSkill } from "@runxhq/core/parser";
import { hashStable, hashString, listLocalReceipts, type LocalReceipt } from "@runxhq/core/receipts";

import type { MaterializedContextEdge } from "./index.js";

const MAX_HISTORICAL_AGENT_ARTIFACTS = 12;

export interface PreparedAgentContext {
  readonly currentContext: readonly ArtifactEnvelope[];
  readonly historicalContext: readonly ArtifactEnvelope[];
  readonly provenance: readonly AgentContextProvenance[];
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}

interface ContextDocumentReceiptRef {
  readonly root_path: string;
  readonly path: string;
  readonly sha256: string;
}

export async function loadContext(options: {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackStart?: string;
}): Promise<Context | undefined> {
  const [memory, conventions] = await Promise.all([
    loadContextDocument({
      fileName: "MEMORY.md",
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.fallbackStart,
    }),
    loadContextDocument({
      fileName: "CONVENTIONS.md",
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.fallbackStart,
    }),
  ]);
  if (!memory && !conventions) {
    return undefined;
  }
  return {
    memory,
    conventions,
  };
}

export function contextReceiptMetadata(context: Context | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!context?.memory && !context?.conventions) {
    return undefined;
  }
  return {
    context: {
      memory: context.memory ? toContextDocumentReceiptRef(context.memory) : undefined,
      conventions: context.conventions ? toContextDocumentReceiptRef(context.conventions) : undefined,
    },
  };
}

export async function loadVoiceProfile(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly voiceProfilePath?: string;
}): Promise<ContextDocument | undefined> {
  const voicePath = resolveVoiceProfilePath(options);
  if (!voicePath) {
    return undefined;
  }
  const content = await readFile(voicePath, "utf8");
  return {
    root_path: path.dirname(voicePath),
    path: voicePath,
    sha256: hashString(content),
    content,
  };
}

export function voiceProfileReceiptMetadata(
  voiceProfile: ContextDocument | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!voiceProfile) {
    return undefined;
  }
  return {
    voice_profile: toContextDocumentReceiptRef(voiceProfile),
  };
}

export function qualityProfileContext(skill: ValidatedSkill): QualityProfileContext | undefined {
  if (!skill.qualityProfile) {
    return undefined;
  }
  return {
    source: "SKILL.md#quality-profile",
    sha256: hashString(skill.qualityProfile.content),
    content: skill.qualityProfile.content,
  };
}

export function skillQualityProfileReceiptMetadata(skill: ValidatedSkill): Readonly<Record<string, unknown>> | undefined {
  const profile = qualityProfileContext(skill);
  if (!profile) {
    return undefined;
  }
  return {
    quality_profiles: {
      [skill.name]: {
        source: profile.source,
        heading: skill.qualityProfile?.heading,
        sha256: profile.sha256,
      },
    },
  };
}

export async function prepareAgentContext(options: {
  readonly skill: ValidatedSkill;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptDir: string;
  readonly runId: string;
  readonly stepId?: string;
  readonly currentContext?: readonly MaterializedContextEdge[];
  readonly skillDirectory?: string;
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly voiceProfilePath?: string;
}): Promise<PreparedAgentContext> {
  const currentContext = dedupeArtifacts(
    (options.currentContext ?? [])
      .map((edge) => edge.artifact)
      .filter((artifact): artifact is ArtifactEnvelope => artifact !== undefined && isDomainArtifactEnvelope(artifact)),
  );
  const provenance = (options.currentContext ?? [])
    .filter((edge) => edge.artifact !== undefined)
    .map((edge) => ({
      input: edge.input,
      output: edge.output,
      from_step: edge.fromStep,
      artifact_id: edge.artifact?.meta.artifact_id,
      receipt_id: edge.receiptId,
    }));
  const projectKeyHash = resolveProjectScopeKeyHash(options.inputs, options.env);
  const context =
    options.context
    ?? (await loadContext({
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.skillDirectory,
    }));
  const voiceProfile =
    options.voiceProfile
    ?? (await loadVoiceProfile({
      env: options.env,
      voiceProfilePath: options.voiceProfilePath,
    }));
  const historicalContext = await loadHistoricalAgentContext({
    receiptDir: options.receiptDir,
    skillName: options.skill.name,
    projectKeyHash,
    excludeRunId: options.runId,
  });
  return {
    currentContext,
    historicalContext,
    provenance,
    context,
    voiceProfile,
    receiptMetadata: projectKeyHash
      ? mergeMetadata(
        {
          context_scope: {
            project_key_hash: projectKeyHash,
          },
        },
        contextReceiptMetadata(context),
        voiceProfileReceiptMetadata(voiceProfile),
      )
      : mergeMetadata(
        contextReceiptMetadata(context),
        voiceProfileReceiptMetadata(voiceProfile),
      ),
  };
}

function isArtifactEnvelopeValue(value: unknown): value is ArtifactEnvelope {
  if (!isPlainRecord(value) || !isPlainRecord(value.meta)) {
    return false;
  }
  return (
    typeof value.version === "string"
    && "data" in value
    && typeof value.meta.artifact_id === "string"
    && typeof value.meta.run_id === "string"
  );
}

function isDomainArtifactEnvelope(entry: ArtifactEnvelope): boolean {
  return entry.type !== null && !SYSTEM_ARTIFACT_TYPES.has(entry.type);
}

function dedupeArtifacts(artifacts: readonly ArtifactEnvelope[]): readonly ArtifactEnvelope[] {
  const seen = new Set<string>();
  const uniqueArtifacts: ArtifactEnvelope[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.meta.artifact_id)) {
      continue;
    }
    seen.add(artifact.meta.artifact_id);
    uniqueArtifacts.push(artifact);
  }
  return uniqueArtifacts;
}

function toContextDocumentReceiptRef(document: ContextDocument): ContextDocumentReceiptRef {
  return {
    root_path: document.root_path,
    path: document.path,
    sha256: document.sha256,
  };
}

function resolveProjectDocumentSearchStart(
  inputs: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
  fallbackStart?: string,
): string {
  const projectScope = resolveProjectScopePath(inputs, env);
  if (projectScope) {
    return projectScope;
  }
  return path.resolve(
    env?.RUNX_PROJECT
      ?? env?.RUNX_CWD
      ?? env?.INIT_CWD
      ?? fallbackStart
      ?? process.cwd(),
  );
}

async function loadContextDocument(options: {
  readonly fileName: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackStart?: string;
}): Promise<ContextDocument | undefined> {
  const searchStart = resolveProjectDocumentSearchStart(options.inputs, options.env, options.fallbackStart);
  const documentPath = await findNearestProjectDocument(searchStart, options.fileName);
  if (!documentPath) {
    return undefined;
  }
  const content = await readFile(documentPath, "utf8");
  return {
    root_path: path.dirname(documentPath),
    path: documentPath,
    sha256: hashString(content),
    content,
  };
}

async function findNearestProjectDocument(start: string, fileName: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveVoiceProfilePath(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly voiceProfilePath?: string;
}): string | undefined {
  const override = options.env?.RUNX_VOICE_FILE?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (options.voiceProfilePath?.trim()) {
    return path.resolve(options.voiceProfilePath);
  }
  return undefined;
}

function resolveProjectScopeKeyHash(
  inputs: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const projectScope = resolveProjectScopePath(inputs, env);
  if (!projectScope) {
    return undefined;
  }
  return hashStable({ project_scope: projectScope });
}

function resolveProjectScopePath(
  inputs: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const candidate =
    firstString(inputs.project)
    ?? firstString(inputs.repo_root)
    ?? firstString(inputs.repoRoot)
    ?? env?.RUNX_PROJECT
    ?? env?.RUNX_CWD
    ?? env?.INIT_CWD;
  if (!candidate) {
    return undefined;
  }
  return path.resolve(env?.RUNX_CWD ?? env?.INIT_CWD ?? process.cwd(), candidate);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return undefined;
}

function receiptProjectScopeKeyHash(receipt: LocalReceipt): string | undefined {
  if (receipt.kind !== "skill_execution" || !isPlainRecord(receipt.metadata)) {
    return undefined;
  }
  const contextScope = receipt.metadata.context_scope;
  if (!isPlainRecord(contextScope)) {
    return undefined;
  }
  const keyHash = contextScope.project_key_hash;
  return typeof keyHash === "string" ? keyHash : undefined;
}

async function loadHistoricalAgentContext(options: {
  readonly receiptDir: string;
  readonly skillName: string;
  readonly projectKeyHash?: string;
  readonly excludeRunId: string;
}): Promise<readonly ArtifactEnvelope[]> {
  if (!options.projectKeyHash) {
    return [];
  }
  const receipts = await listLocalReceipts(options.receiptDir);
  const candidate = receipts.find((receipt) =>
    receipt.kind === "skill_execution"
    && receipt.id !== options.excludeRunId
    && receipt.status === "success"
    && receiptSkillName(receipt) === options.skillName
    && receiptProjectScopeKeyHash(receipt) === options.projectKeyHash
    && Array.isArray(receipt.artifact_ids)
    && receipt.artifact_ids.length > 0,
  );
  if (!candidate || candidate.kind !== "skill_execution") {
    return [];
  }
  const entries = await readLedgerEntries(options.receiptDir, candidate.id);
  return entries.filter(isDomainArtifactEnvelope).slice(-MAX_HISTORICAL_AGENT_ARTIFACTS);
}

function receiptSkillName(receipt: LocalReceipt): string | undefined {
  if (receipt.kind !== "skill_execution") {
    return undefined;
  }
  return receipt.skill_name;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function mergeMetadata(
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

function mergeRecord(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] = isPlainRecord(existing) && isPlainRecord(value) ? mergeRecord(existing, value) : value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

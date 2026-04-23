import type { ArtifactContract, ArtifactEnvelope } from "../artifacts/index.js";
import type { ExecutionGraph, GraphPolicy, GraphStep, ValidatedSkill } from "../parser/index.js";
import type { GraphReceiptSyncPoint } from "../receipts/index.js";
import {
  transitionSequentialGraph,
  type SequentialGraphPlan,
  type SequentialGraphState,
} from "../state-machine/index.js";

import { resolveOutputPath, type GraphStepOutput } from "./graph-context.js";
import { buildInlineGraphStepSkill } from "./execution-targets.js";
import { graphStepReference } from "./graph-reporting.js";
import { isDomainArtifactEnvelope } from "./runner-helpers.js";
import type { GraphStepRun } from "./index.js";

export function admitGraphTransition(
  policy: GraphPolicy | undefined,
  stepId: string,
  outputs: ReadonlyMap<string, GraphStepOutput>,
): { readonly status: "allow" } | { readonly status: "deny"; readonly reason: string } {
  const gates = policy?.transitions.filter((gate) => gate.to === stepId) ?? [];
  for (const gate of gates) {
    let value: unknown;
    try {
      value = resolveTransitionGateValue(outputs, gate.field);
    } catch (error) {
      return {
        status: "deny",
        reason: error instanceof Error ? error.message : `unable to resolve policy field '${gate.field}'`,
      };
    }
    if (gate.equals !== undefined && !isDeepEqual(value, gate.equals)) {
      return {
        status: "deny",
        reason: `transition policy blocked step '${stepId}': expected ${gate.field} == ${JSON.stringify(gate.equals)}`,
      };
    }
    if (gate.notEquals !== undefined && isDeepEqual(value, gate.notEquals)) {
      return {
        status: "deny",
        reason: `transition policy blocked step '${stepId}': expected ${gate.field} != ${JSON.stringify(gate.notEquals)}`,
      };
    }
  }
  return { status: "allow" };
}

export function hydrateGraphFromLedger(options: {
  readonly entries: readonly ArtifactEnvelope[];
  readonly graph: ExecutionGraph;
  readonly graphStepCache: ReadonlyMap<string, ValidatedSkill>;
  readonly skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  };
  readonly graphSteps: readonly {
    readonly id: string;
    readonly contextFrom: readonly string[];
    readonly retry?: GraphStep["retry"];
    readonly fanoutGroup?: string;
  }[];
  readonly stepRuns: GraphStepRun[];
  readonly outputs: Map<string, GraphStepOutput>;
  readonly syncPoints: GraphReceiptSyncPoint[];
  readonly stateRef: {
    get value(): SequentialGraphState;
    set value(next: SequentialGraphState);
  };
  readonly lastReceiptRef: {
    get value(): string | undefined;
    set value(next: string | undefined);
  };
}): void {
  if (options.entries.length === 0) {
    return;
  }
  if (options.graph.steps.some((step) => step.fanoutGroup)) {
    throw new Error("resumeFromRunId currently supports sequential chains only.");
  }

  const stepsById = new Map(options.graph.steps.map((step) => [step.id, step]));
  const latestEvents = new Map<string, ArtifactEnvelope>();
  const artifactsByStep = new Map<string, ArtifactEnvelope[]>();
  const receiptLinks = new Map<string, string>();

  for (const entry of options.entries) {
    if (entry.type === "run_event") {
      const stepId = entry.data.step_id;
      if (typeof stepId === "string" && stepId.length > 0) {
        latestEvents.set(stepId, entry);
      }
      continue;
    }
    if (entry.type === "receipt_link") {
      const artifactId = typeof entry.data.artifact_id === "string" ? entry.data.artifact_id : undefined;
      const receiptId = typeof entry.data.receipt_id === "string" ? entry.data.receipt_id : undefined;
      if (artifactId && receiptId) {
        receiptLinks.set(artifactId, receiptId);
      }
      continue;
    }
    if (entry.meta.step_id) {
      artifactsByStep.set(entry.meta.step_id, [...(artifactsByStep.get(entry.meta.step_id) ?? []), entry]);
    }
  }

  let state = options.stateRef.value;
  for (const chainStep of options.graphSteps) {
    const step = stepsById.get(chainStep.id);
    const stepSkill =
      options.graphStepCache.get(chainStep.id)
      ?? (step?.run ? buildInlineGraphStepSkill(step, options.skillEnvironment) : undefined);
    const event = latestEvents.get(chainStep.id);
    if (!step || !stepSkill || !event) {
      break;
    }
    const stepArtifacts = artifactsByStep.get(chainStep.id) ?? [];
    const stepFields = reconstructStepFields(stepArtifacts, stepSkill.artifacts);
    const receiptId = receiptLinksForStep(stepArtifacts, receiptLinks)[0];
    if (event.data.kind === "step_started") {
      state = transitionSequentialGraph(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      break;
    }
    if (event.data.kind === "step_succeeded") {
      state = transitionSequentialGraph(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      state = transitionSequentialGraph(state, {
        type: "step_succeeded",
        stepId: chainStep.id,
        at: entryTimestamp(event),
        receiptId,
        outputs: stepFields,
      });
      options.outputs.set(chainStep.id, {
        status: "success",
        stdout: reconstructStdout(stepArtifacts, stepFields),
        stderr: "",
        receiptId: receiptId ?? "",
        fields: stepFields,
        artifactIds: stepArtifacts.map((artifact) => artifact.meta.artifact_id),
        artifacts: stepArtifacts.filter(isDomainArtifactEnvelope),
      });
      options.stepRuns.push({
        stepId: chainStep.id,
        skill: graphStepReference(step),
        skillPath: step.skill ? step.skill : `inline:${chainStep.id}`,
        runner: step.runner,
        attempt: 1,
        status: "success",
        receiptId,
        stdout: reconstructStdout(stepArtifacts, stepFields),
        stderr: "",
        artifactIds: stepArtifacts.map((artifact) => artifact.meta.artifact_id),
        contextFrom: [],
      });
      options.lastReceiptRef.value = receiptId ?? options.lastReceiptRef.value;
      continue;
    }
    if (event.data.kind === "step_failed") {
      state = transitionSequentialGraph(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      state = transitionSequentialGraph(state, {
        type: "step_failed",
        stepId: chainStep.id,
        at: entryTimestamp(event),
        error: typeof event.data.detail === "object" && event.data.detail && "reason" in event.data.detail
          ? String((event.data.detail as Record<string, unknown>).reason)
          : "previous attempt failed",
      });
      break;
    }
    if (event.data.kind === "step_waiting_resolution") {
      break;
    }
    break;
  }
  options.stateRef.value = state;
}

export function resolveSequentialGraphFailureReason(
  plan: Extract<SequentialGraphPlan, { type: "failed" }>,
  state: SequentialGraphState,
  stepRuns: readonly GraphStepRun[],
): string {
  const stepState = state.steps.find((candidate) => candidate.stepId === plan.stepId);
  const stateError = stepState?.error?.trim();
  if (stateError && stateError !== plan.reason) {
    return stateError;
  }

  const stepRun = [...stepRuns]
    .reverse()
    .find((candidate) => candidate.stepId === plan.stepId && candidate.status === "failure");
  const runError = stepRun?.stderr.trim();
  if (runError && runError !== plan.reason) {
    return runError;
  }

  return plan.reason;
}

function resolveTransitionGateValue(
  outputs: ReadonlyMap<string, GraphStepOutput>,
  field: string,
): unknown {
  const dotIndex = field.indexOf(".");
  if (dotIndex <= 0) {
    throw new Error(`invalid transition policy field '${field}'`);
  }
  const stepId = field.slice(0, dotIndex);
  const outputPath = field.slice(dotIndex + 1);
  const output = outputs.get(stepId);
  if (!output) {
    throw new Error(`transition policy references missing step '${stepId}'`);
  }
  return resolveOutputPath(output, outputPath);
}

function reconstructStepFields(
  artifacts: readonly ArtifactEnvelope[],
  contract: ArtifactContract | undefined,
): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  const skillArtifacts = artifacts.filter((artifact) => artifact.type !== "run_event" && artifact.type !== "receipt_link");
  if (skillArtifacts.length === 1 && skillArtifacts[0]?.type === null) {
    const untypedData = skillArtifacts[0].data;
    if ("raw" in untypedData && typeof untypedData.raw === "string") {
      fields.raw = untypedData.raw;
      return fields;
    }
    Object.assign(fields, untypedData);
    fields.raw = JSON.stringify(untypedData);
    return fields;
  }
  for (const artifact of skillArtifacts) {
    const key = declaredArtifactField(contract, artifact.type) ?? artifact.type ?? "raw";
    fields[key] = artifact;
  }
  return fields;
}

function declaredArtifactField(contract: ArtifactContract | undefined, artifactType: string | null): string | undefined {
  if (!artifactType) {
    return undefined;
  }
  for (const [fieldName, declaredType] of Object.entries(contract?.namedEmits ?? {})) {
    if (declaredType === artifactType) {
      return fieldName;
    }
  }
  if (contract?.wrapAs === artifactType) {
    return artifactType;
  }
  return undefined;
}

function receiptLinksForStep(
  artifacts: readonly ArtifactEnvelope[],
  receiptLinks: ReadonlyMap<string, string>,
): readonly string[] {
  return artifacts
    .map((artifact) => receiptLinks.get(artifact.meta.artifact_id))
    .filter((receiptId): receiptId is string => typeof receiptId === "string");
}

function reconstructStdout(
  artifacts: readonly ArtifactEnvelope[],
  fields: Readonly<Record<string, unknown>>,
): string {
  const raw = artifacts.find((artifact) => artifact.type === null)?.data.raw;
  if (typeof raw === "string") {
    return raw;
  }
  if ("raw" in fields && typeof fields.raw === "string") {
    return fields.raw;
  }
  return JSON.stringify(fields);
}

function entryTimestamp(entry: ArtifactEnvelope): string {
  return entry.meta.created_at;
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

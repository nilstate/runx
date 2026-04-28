import type { ArtifactEnvelope } from "@runxhq/core/artifacts";
import type { ExecutionGraph, GraphStep } from "@runxhq/core/parser";
import { isRecord } from "@runxhq/core/util";

export interface GraphStepOutput {
  readonly status: "success" | "failure";
  readonly stdout: string;
  readonly stderr: string;
  readonly receiptId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly artifactIds: readonly string[];
  readonly artifacts: readonly ArtifactEnvelope[];
}

export interface MaterializedContextEdge {
  readonly input: string;
  readonly fromStep: string;
  readonly output: string;
  readonly receiptId?: string;
  readonly artifact?: ArtifactEnvelope;
  readonly value: unknown;
}

export function findGraphStep(graph: ExecutionGraph, stepId: string): GraphStep {
  const step = graph.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`Graph step '${stepId}' is missing.`);
  }
  return step;
}

export function materializeContext(
  step: GraphStep,
  outputs: ReadonlyMap<string, GraphStepOutput>,
): readonly MaterializedContextEdge[] {
  return step.contextEdges.map((edge) => {
    const sourceOutput = outputs.get(edge.fromStep);
    if (!sourceOutput) {
      throw new Error(`Step '${step.id}' is missing context output from '${edge.fromStep}'.`);
    }

    return {
      input: edge.input,
      fromStep: edge.fromStep,
      output: edge.output,
      receiptId: sourceOutput.receiptId,
      artifact: resolveOutputArtifact(sourceOutput, edge.output),
      value: resolveOutputPath(sourceOutput, edge.output),
    };
  });
}

export function resolveOutputPath(output: GraphStepOutput, outputPath: string): unknown {
  const record: Record<string, unknown> = {
    ...output.fields,
    status: output.status,
    stdout: output.stdout,
    stderr: output.stderr,
    receipt_id: output.receiptId,
    receiptId: output.receiptId,
  };

  return outputPath.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value)) {
      throw new Error(`Context output path '${outputPath}' was not produced by the source step.`);
    }

    if (key in value) {
      return value[key];
    }

    const packetPayload = unwrapPacketPayload(value);
    if (packetPayload && key in packetPayload) {
      return packetPayload[key];
    }

    throw new Error(`Context output path '${outputPath}' was not produced by the source step.`);
  }, record);
}

function resolveOutputArtifact(output: GraphStepOutput, outputPath: string): ArtifactEnvelope | undefined {
  const [field] = outputPath.split(".", 1);
  if (!field) {
    return undefined;
  }
  const candidate = output.fields[field];
  return isArtifactEnvelopeValue(candidate) ? candidate : undefined;
}

function isArtifactEnvelopeValue(value: unknown): value is ArtifactEnvelope {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { version?: unknown }).version === "string"
    && typeof (value as { meta?: { artifact_id?: unknown; run_id?: unknown } }).meta?.artifact_id === "string"
    && typeof (value as { meta?: { artifact_id?: unknown; run_id?: unknown } }).meta?.run_id === "string"
    && "data" in value;
}

function unwrapPacketPayload(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.schema !== "string") {
    return undefined;
  }
  return isRecord(value.data) ? value.data : undefined;
}

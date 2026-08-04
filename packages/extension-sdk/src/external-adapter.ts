import { readFileSync } from "node:fs";

import {
  RUNX_LOGICAL_SCHEMAS,
  externalAdapterProtocolVersion,
  validateExternalAdapterInvocationContract,
  validateExternalAdapterResponseContract,
  type ExternalAdapterArtifactObservationContract,
  type ExternalAdapterErrorObservationContract,
  type ExternalAdapterInvocationContract,
  type ExternalAdapterResponseContract,
  type ExternalAdapterTelemetryObservationContract,
} from "@runxhq/contracts";

import { errorMessage, isRecord, pruneUndefined } from "./values.js";

export type ExternalAdapterInvocation = ExternalAdapterInvocationContract;
export type ExternalAdapterResponse = ExternalAdapterResponseContract;
export type ExternalAdapterStatus = ExternalAdapterResponseContract["status"];

export interface ExternalAdapterResponseOptions {
  readonly status?: ExternalAdapterStatus;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly ExternalAdapterArtifactObservationContract[];
  readonly errors?: readonly ExternalAdapterErrorObservationContract[];
  readonly telemetry?: readonly ExternalAdapterTelemetryObservationContract[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly observedAt?: string | Date;
}

export type ExternalAdapterHandlerResult =
  | ExternalAdapterResponseContract
  | ExternalAdapterResponseOptions
  | Readonly<Record<string, unknown>>
  | undefined
  | void;

export interface ExternalAdapterDefinition {
  readonly adapterId?: string;
  invoke(args: {
    readonly invocation: ExternalAdapterInvocationContract;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }): ExternalAdapterHandlerResult | Promise<ExternalAdapterHandlerResult>;
}

export interface DefinedExternalAdapter extends ExternalAdapterDefinition {
  runWith(rawInvocation: unknown): Promise<ExternalAdapterResponseContract>;
  main(): Promise<void>;
}

export function materializeExternalAdapterInputs(
  invocation: Pick<ExternalAdapterInvocationContract, "inputs" | "resolved_inputs">,
): Readonly<Record<string, unknown>> {
  return {
    ...invocation.inputs,
    ...(invocation.resolved_inputs ?? {}),
  };
}

function parseExternalAdapterInvocation(
  value: unknown,
  label = "external_adapter_invocation",
): ExternalAdapterInvocationContract {
  return validateExternalAdapterInvocationContract(value, label);
}

function createExternalAdapterResponse(
  invocation: Pick<ExternalAdapterInvocationContract, "invocation_id" | "adapter_id">,
  options: ExternalAdapterResponseOptions = {},
): ExternalAdapterResponseContract {
  return validateExternalAdapterResponseContract(pruneUndefined({
    schema: RUNX_LOGICAL_SCHEMAS.externalAdapterResponse,
    protocol_version: externalAdapterProtocolVersion,
    invocation_id: invocation.invocation_id,
    adapter_id: invocation.adapter_id,
    status: options.status ?? "completed",
    stdout: options.stdout,
    stderr: options.stderr,
    exit_code: options.exitCode,
    output: options.output,
    artifacts: options.artifacts,
    errors: options.errors,
    telemetry: options.telemetry,
    metadata: options.metadata,
    observed_at: normalizeObservedAt(options.observedAt),
  }));
}

export function defineExternalAdapter(definition: ExternalAdapterDefinition): DefinedExternalAdapter {
  return {
    ...definition,
    async runWith(rawInvocation: unknown) {
      const invocation = parseExternalAdapterInvocation(rawInvocation);
      assertAdapterId(definition.adapterId, invocation);
      try {
        const result = await definition.invoke({
          invocation,
          env: process.env,
          cwd: process.cwd(),
        });
        return normalizeResult(invocation, result);
      } catch (error) {
        return createExternalAdapterResponse(invocation, {
          status: "failed",
          exitCode: 1,
          stderr: errorMessage(error),
          errors: [{ code: "adapter_error", message: errorMessage(error), retryable: false }],
        });
      }
    },
    async main() {
      try {
        const response = await this.runWith(readInvocationInput());
        process.stdout.write(JSON.stringify(response));
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ error: { message: errorMessage(error) } })}\n`);
        process.exitCode = 1;
      }
    },
  };
}

function normalizeResult(
  invocation: ExternalAdapterInvocationContract,
  result: ExternalAdapterHandlerResult,
): ExternalAdapterResponseContract {
  if (isRecord(result) && result.schema === RUNX_LOGICAL_SCHEMAS.externalAdapterResponse) {
    return validateResponseIdentity(invocation, validateExternalAdapterResponseContract(result));
  }
  if (isResponseOptions(result)) return createExternalAdapterResponse(invocation, result);
  if (isRecord(result)) return createExternalAdapterResponse(invocation, { output: result });
  return createExternalAdapterResponse(invocation);
}

function isResponseOptions(value: unknown): value is ExternalAdapterResponseOptions {
  return isRecord(value) && [
    "status", "stdout", "stderr", "exitCode", "output", "artifacts",
    "errors", "telemetry", "metadata", "observedAt",
  ].some((key) => key in value);
}

function assertAdapterId(
  adapterId: string | undefined,
  invocation: ExternalAdapterInvocationContract,
): void {
  if (adapterId !== undefined && adapterId !== invocation.adapter_id) {
    throw new Error(`external adapter id mismatch: expected ${adapterId}, received ${invocation.adapter_id}`);
  }
}

function validateResponseIdentity(
  invocation: ExternalAdapterInvocationContract,
  response: ExternalAdapterResponseContract,
): ExternalAdapterResponseContract {
  if (response.invocation_id !== invocation.invocation_id) {
    throw new Error(`external adapter invocation id mismatch: expected ${invocation.invocation_id}, received ${response.invocation_id}`);
  }
  if (response.adapter_id !== invocation.adapter_id) {
    throw new Error(`external adapter response adapter id mismatch: expected ${invocation.adapter_id}, received ${response.adapter_id}`);
  }
  return response;
}

function normalizeObservedAt(value: string | Date | undefined): string {
  if (value === undefined) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

function readInvocationInput(): unknown {
  if (process.env.RUNX_EXTERNAL_ADAPTER_INVOCATION_JSON) {
    return JSON.parse(process.env.RUNX_EXTERNAL_ADAPTER_INVOCATION_JSON) as unknown;
  }
  if (process.env.RUNX_EXTERNAL_ADAPTER_INVOCATION_PATH) {
    return JSON.parse(readFileSync(process.env.RUNX_EXTERNAL_ADAPTER_INVOCATION_PATH, "utf8")) as unknown;
  }
  return JSON.parse(readFileSync(0, "utf8")) as unknown;
}

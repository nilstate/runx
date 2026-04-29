import type { AdapterInvokeRequest, AdapterInvokeResult, SkillAdapter } from "@runxhq/core/executor";
import { hashStable, hashString } from "@runxhq/core/util";

export const a2aAdapterPackage = "@runxhq/adapters/a2a";

export interface A2aTask {
  readonly id: string;
  readonly status: "submitted" | "working" | "completed" | "failed" | "canceled";
  readonly output?: unknown;
  readonly error?: string;
}

export interface A2aTransport {
  readonly sendMessage: (request: A2aSendMessageRequest) => Promise<A2aTask>;
  readonly getTask: (request: A2aGetTaskRequest) => Promise<A2aTask>;
  readonly cancelTask?: (request: A2aGetTaskRequest) => Promise<A2aTask>;
}

export interface A2aSendMessageRequest {
  readonly agentCardUrl: string;
  readonly agentIdentity?: string;
  readonly task: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface A2aGetTaskRequest {
  readonly agentCardUrl: string;
  readonly taskId: string;
}

export interface A2aAdapter extends SkillAdapter {
  readonly type: "a2a";
}

export interface CreateA2aAdapterOptions {
  readonly transport?: A2aTransport;
}

export function createA2aAdapter(options: CreateA2aAdapterOptions = {}): A2aAdapter {
  if (!options.transport) {
    throw new Error("A2A adapter requires an explicit transport. Use createFixtureA2aTransport() only in tests or harnesses.");
  }
  return {
    type: "a2a",
    invoke: async (request) => await invokeA2a(request, options),
  };
}

export async function invokeA2a(
  request: AdapterInvokeRequest,
  options: CreateA2aAdapterOptions = {},
): Promise<AdapterInvokeResult> {
  const started = performance.now();
  const source = request.source;
  const agentCardUrl = source.agentCardUrl;
  const task = source.task;

  if (!agentCardUrl || !task) {
    return failure("A2A source requires agent_card_url and task metadata.", started);
  }

  const transport = options.transport;
  if (!transport) {
    return failure("A2A adapter requires an explicit transport.", started);
  }
  const timeoutMs = Math.max(0.05, source.timeoutSeconds ?? 60) * 1000;
  const message = request.resolvedInputs
    ? mapResolvedArguments(source.arguments, request.resolvedInputs, request.inputs)
    : mapArguments(source.arguments, request.inputs);
  let taskId: string | undefined;

  try {
    const submitted = await withTimeout(
      transport.sendMessage({
        agentCardUrl,
        agentIdentity: source.agentIdentity,
        task,
        message,
      }),
      timeoutMs,
    );
    taskId = submitted.id;
    const completed =
      submitted.status === "completed" || submitted.status === "failed"
        ? submitted
        : await pollTask(transport, agentCardUrl, taskId, timeoutMs, request.signal);

    if (completed.status !== "completed") {
      return failure(`A2A task ${completed.status}.`, started, metadataFor(source, completed, message));
    }

    return {
      status: "success",
      stdout: stringifyA2aOutput(completed.output),
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: Math.round(performance.now() - started),
      metadata: metadataFor(source, completed, message),
    };
  } catch (error) {
    let cancelError: string | undefined;
    if (taskId && options.transport?.cancelTask) {
      try {
        await options.transport.cancelTask({ agentCardUrl, taskId });
      } catch (cancelFailure) {
        cancelError = sanitizeCancelError(cancelFailure);
      }
    }
    return failure(
      sanitizeError(error),
      started,
      metadataFor(source, taskId ? { id: taskId, status: "failed" } : undefined, message, cancelError),
    );
  }
}

const defaultPollIntervalMs = 1000;

async function pollTask(
  transport: A2aTransport,
  agentCardUrl: string,
  taskId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<A2aTask> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("A2A task aborted.");
    const task = await transport.getTask({ agentCardUrl, taskId });
    if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
      return task;
    }
    await delay(defaultPollIntervalMs);
  }
  throw new Error(`A2A task timed out after ${timeoutMs}ms.`);
}

export function createFixtureA2aTransport(): A2aTransport {
  const tasks = new Map<string, A2aTask>();
  return {
    sendMessage: async (request) => {
      if (!request.agentCardUrl.startsWith("fixture://")) {
        throw new Error("A2A fixture transport only supports fixture:// agent cards.");
      }
      const taskId = `a2a_${hashStable({ request }).slice(0, 16)}`;
      const result =
        request.task === "fail"
          ? { id: taskId, status: "failed" as const, error: "fixture failure" }
          : { id: taskId, status: "completed" as const, output: request.message.message ?? request.message };
      tasks.set(taskId, result);
      return result;
    },
    getTask: async (request) => {
      const task = tasks.get(request.taskId);
      if (!task) {
        throw new Error("A2A fixture task not found.");
      }
      return task;
    },
  };
}

function mapResolvedArguments(
  argumentTemplate: Readonly<Record<string, unknown>> | undefined,
  resolved: Readonly<Record<string, string>>,
  rawInputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!argumentTemplate) return { ...rawInputs, ...resolved };
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(argumentTemplate)) {
    if (typeof value === "string") {
      const exact = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
      if (exact) {
        mapped[key] = exact[1] in resolved ? resolved[exact[1]] : rawInputs[exact[1]];
      } else {
        mapped[key] = value.replace(
          /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
          (_m, k: string) => (k in resolved ? resolved[k] : stringifyInput(rawInputs[k])),
        );
      }
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}

function mapArguments(
  argumentTemplate: Readonly<Record<string, unknown>> | undefined,
  inputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!argumentTemplate) return inputs;
  return mapResolvedArguments(argumentTemplate, {}, inputs);
}

function stringifyA2aOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function metadataFor(
  source: AdapterInvokeRequest["source"],
  task?: A2aTask,
  message?: Readonly<Record<string, unknown>>,
  cancelError?: string,
): Readonly<Record<string, unknown>> {
  return {
    a2a: {
      agent_card_url_hash: hashString(source.agentCardUrl ?? ""),
      agent_identity: source.agentIdentity,
      task: source.task,
      task_id: task?.id,
      task_status: task?.status,
      message_hash: message ? hashStable(message) : undefined,
      output_hash: task?.output !== undefined ? hashStable(task.output) : undefined,
      cancel_error: cancelError,
    },
  };
}

function failure(
  message: string,
  started: number,
  metadata?: Readonly<Record<string, unknown>>,
): AdapterInvokeResult {
  return {
    status: "failure",
    stdout: "",
    stderr: message,
    exitCode: null,
    signal: null,
    durationMs: Math.round(performance.now() - started),
    errorMessage: message,
    metadata,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`A2A call timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message.includes("timed out")) {
    return error.message;
  }
  return "A2A adapter failed.";
}

function sanitizeCancelError(error: unknown): string {
  if (error instanceof Error && error.message.includes("timed out")) {
    return error.message;
  }
  return "A2A task cancellation failed.";
}

function stringifyInput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

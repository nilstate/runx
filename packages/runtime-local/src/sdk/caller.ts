import type { ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";
import type { Caller, ExecutionEvent } from "../runner-local/index.js";

export interface StructuredResolution {
  readonly request: ResolutionRequest;
  readonly response?: ResolutionResponse;
}

export interface StructuredCallerTrace {
  readonly resolutions: readonly StructuredResolution[];
  readonly events: readonly ExecutionEvent[];
}

export interface StructuredCallerOptions {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly approvals?: boolean | Readonly<Record<string, boolean>>;
}

export type StructuredCaller = Caller & {
  readonly trace: StructuredCallerTrace;
};

export function createStructuredCaller(options: StructuredCallerOptions = {}): StructuredCaller {
  const resolutions: StructuredResolution[] = [];
  const events: ExecutionEvent[] = [];

  return {
    trace: {
      resolutions,
      events,
    },
    resolve: async (request) => {
      const response = resolveStructuredRequest(request, options);
      resolutions.push({ request, response });
      return response;
    },
    report: (event) => {
      events.push(event);
    },
  };
}

function resolveStructuredRequest(
  request: ResolutionRequest,
  options: StructuredCallerOptions,
): ResolutionResponse | undefined {
  if (request.kind === "input") {
    const payload = Object.fromEntries(
      request.questions
        .filter((question) => options.answers?.[question.id] !== undefined)
        .map((question) => [question.id, options.answers?.[question.id]]),
    );
    return Object.keys(payload).length === 0 ? undefined : { actor: "human", payload };
  }

  if (request.kind === "approval") {
    const approved =
      typeof options.approvals === "boolean" ? options.approvals : options.approvals?.[request.gate.id];
    return approved === undefined ? undefined : { actor: "human", payload: approved };
  }

  const payload = options.answers?.[request.id];
  return payload === undefined ? undefined : { actor: "agent", payload };
}

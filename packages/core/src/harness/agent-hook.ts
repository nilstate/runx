import type { AdapterInvokeRequest, AdapterInvokeResult, SkillAdapter } from "../executor/index.js";

export interface HarnessHookHandlerResult {
  readonly status?: "success" | "failure";
  readonly output?: unknown;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type HarnessHookHandler = (request: AdapterInvokeRequest) => HarnessHookHandlerResult | Promise<HarnessHookHandlerResult>;

export interface HarnessHookAdapterOptions {
  readonly handlers?: Readonly<Record<string, HarnessHookHandler>>;
}

export function createHarnessHookAdapter(options: HarnessHookAdapterOptions = {}): SkillAdapter {
  return {
    type: "harness-hook",
    invoke: async (request) => {
      const hook = request.source.hook;
      if (!hook) {
        return failure("harness-hook source requires source.hook");
      }

      const handler = options.handlers?.[hook] ?? defaultHandler;
      const startedAt = Date.now();
      const result = await handler(request);
      const status = result.status ?? "success";
      const output = result.output ?? {};
      const stdout = typeof output === "string" ? output : JSON.stringify(output);

      return {
        status,
        stdout: status === "success" ? stdout : "",
        stderr: status === "failure" ? result.errorMessage ?? "harness hook failed" : "",
        exitCode: status === "success" ? 0 : 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        errorMessage: result.errorMessage,
        metadata: {
          agent_hook: {
            source_type: "harness-hook",
            hook,
            status,
          },
          ...result.metadata,
        },
      };
    },
  };
}

function defaultHandler(request: AdapterInvokeRequest): HarnessHookHandlerResult {
  return {
    output: {
      hook: request.source.hook,
      inputs: request.inputs,
    },
  };
}

function failure(errorMessage: string): AdapterInvokeResult {
  return {
    status: "failure",
    stdout: "",
    stderr: errorMessage,
    exitCode: null,
    signal: null,
    durationMs: 0,
    errorMessage,
  };
}

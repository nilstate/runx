import { resolveDefaultSkillAdapters } from "@runxhq/adapters";
import { loadLocalSkillPackage, resolvePathFromUserInput, resolveRunxHomeDir } from "@runxhq/core/config";
import type { ResolutionRequest } from "@runxhq/core/executor";
import {
  parseSkillMarkdown,
  validateSkill,
  type SkillInput,
} from "@runxhq/core/parser";
import type { RegistryStore } from "@runxhq/core/registry";
import {
  resolveSkillRunner,
  readPendingSkillPath,
  runLocalSkill,
  type Caller,
} from "@runxhq/core/runner-local";
import { createSurfaceBridge, type SurfaceBoundaryResolver, type SurfaceRunResult } from "@runxhq/core/sdk";

import type { CliIo } from "../index.js";
import { readCliPackageMetadata } from "../metadata.js";
import { resolveBundledCliVoiceProfilePath } from "../runtime-assets.js";
import { resolveRunnableSkillReference } from "../skill-refs.js";

export interface McpCommandArgs {
  readonly mcpRefs?: readonly string[];
  readonly runner?: string;
  readonly receiptDir?: string;
}

export interface McpCommandDependencies {
  readonly resolveRegistryStoreForChains: (env: NodeJS.ProcessEnv) => Promise<RegistryStore | undefined>;
  readonly resolveDefaultReceiptDir: (env: NodeJS.ProcessEnv) => string;
}

interface JsonRpcRequest {
  readonly jsonrpc?: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface ServedMcpTool {
  readonly name: string;
  readonly description: string;
  readonly skillPath: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly call: (args: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>;
}

interface ResumeSubmission {
  readonly requestId: string;
  readonly actor?: "human" | "agent";
  readonly payload: unknown;
}

const noOpCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

export async function handleMcpServeCommand(
  parsed: McpCommandArgs,
  io: CliIo,
  env: NodeJS.ProcessEnv,
  deps: McpCommandDependencies,
): Promise<void> {
  const skillRefs = parsed.mcpRefs ?? [];
  if (skillRefs.length === 0) {
    throw new Error("runx mcp serve requires at least one skill reference.");
  }

  const registryStore = await deps.resolveRegistryStoreForChains(env);
  const adapters = await resolveDefaultSkillAdapters(env);
  const receiptDir = parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : deps.resolveDefaultReceiptDir(env);
  const runxHome = resolveRunxHomeDir(env);
  const voiceProfilePath = await resolveBundledCliVoiceProfilePath();
  const bridge = createSurfaceBridge({
    execute: async (options) =>
      await runLocalSkill({
        skillPath: options.skillPath,
        inputs: options.inputs,
        answersPath: options.answersPath,
        caller: options.caller,
        env,
        receiptDir: options.receiptDir ?? receiptDir,
        runxHome: options.runxHome ?? runxHome,
        parentReceipt: options.parentReceipt,
        contextFrom: options.contextFrom,
        authResolver: options.authResolver,
        allowedSourceTypes: options.allowedSourceTypes,
        resumeFromRunId: options.resumeFromRunId,
        registryStore,
        adapters,
        voiceProfilePath,
      }),
  });

  const skillTools = await Promise.all(skillRefs.map((ref) => loadServedMcpTool(ref, parsed.runner, env)));
  const tools: readonly McpToolDefinition[] = [
    ...skillTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      call: async (args: Readonly<Record<string, unknown>>) => {
        const result = await bridge.run({
          skillPath: tool.skillPath,
          inputs: args,
          caller: noOpCaller,
          receiptDir,
          runxHome,
        });
        return toMcpToolResult(result);
      },
    })),
    createResumeToolDefinition({
      bridge,
      receiptDir,
      runxHome,
    }),
  ];
  assertUniqueToolNames(tools);

  const packageMetadata = readCliPackageMetadata();
  await serveJsonRpc(io, async (request) => {
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: packageMetadata.name,
            version: packageMetadata.version,
          },
        },
      };
    }

    if (request.method === "ping") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {},
      };
    }

    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };
    }

    if (request.method === "tools/call") {
      const params = asRecord(request.params);
      if (!params || typeof params.name !== "string") {
        return errorResponse(request.id, -32602, "invalid tool call");
      }
      const tool = tools.find((candidate) => candidate.name === params.name);
      if (!tool) {
        return errorResponse(request.id, -32601, `tool not found: ${params.name}`);
      }
      const argumentsRecord = asRecord(params.arguments);
      if (params.arguments !== undefined && !argumentsRecord) {
        return errorResponse(request.id, -32602, "tool arguments must be an object");
      }
      try {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: await tool.call(argumentsRecord ?? {}),
        };
      } catch (error) {
        return errorResponse(
          request.id,
          -32000,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (request.id === undefined || request.id === null) {
      return undefined;
    }
    return errorResponse(request.id, -32601, "method not found");
  });
}

async function loadServedMcpTool(
  ref: string,
  runnerName: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<ServedMcpTool> {
  const skillPath = await resolveRunnableSkillReference(ref, env);
  const skillPackage = await loadLocalSkillPackage(skillPath);
  const rawSkill = parseSkillMarkdown(skillPackage.markdown);
  const selection = await resolveSkillRunner(
    validateSkill(rawSkill, { mode: "strict" }),
    skillPath,
    runnerName,
  );
  const skill = selection.skill;

  return {
    name: skill.name,
    description: skill.description ?? `runx skill ${skill.name}`,
    skillPath,
    inputSchema: skillInputsToJsonSchema(skill.inputs),
  };
}

function createResumeToolDefinition(options: {
  readonly bridge: ReturnType<typeof createSurfaceBridge>;
  readonly receiptDir: string;
  readonly runxHome: string;
}): McpToolDefinition {
  return {
    name: "runx_resume",
    description: "Resume a paused runx run by run id with zero or more structured resolution payloads.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "Paused run id to continue.",
        },
        responses: {
          type: "array",
          description: "Structured response payloads keyed by pending request id.",
          items: {
            type: "object",
            properties: {
              request_id: { type: "string" },
              actor: { type: "string", enum: ["human", "agent"] },
              payload: {},
            },
            required: ["request_id", "payload"],
            additionalProperties: false,
          },
        },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    call: async (args) => {
      const runId = requiredString(args.run_id, "runx_resume.run_id");
      const skillPath = await readPendingSkillPath(options.receiptDir, runId);
      if (!skillPath) {
        throw new Error(`Run '${runId}' cannot be resumed because no pending skill path was recorded.`);
      }
      const submissions = parseResumeSubmissions(args.responses);
      const resolver = createResumeResolver(submissions);
      const result = await options.bridge.resume(runId, {
        skillPath,
        caller: noOpCaller,
        receiptDir: options.receiptDir,
        runxHome: options.runxHome,
        resolver,
      });
      return toMcpToolResult(result);
    },
  };
}

function createResumeResolver(submissions: readonly ResumeSubmission[]): SurfaceBoundaryResolver | undefined {
  if (submissions.length === 0) {
    return undefined;
  }
  const byRequestId = new Map(submissions.map((submission) => [submission.requestId, submission] as const));
  return ({ request }) => {
    const submission = byRequestId.get(request.id);
    if (!submission) {
      return undefined;
    }
    return submission.actor
      ? { actor: submission.actor, payload: submission.payload }
      : { payload: submission.payload };
  };
}

function parseResumeSubmissions(value: unknown): readonly ResumeSubmission[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("runx_resume.responses must be an array when provided.");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`runx_resume.responses[${index}] must be an object.`);
    }
    const requestId = requiredString(record.request_id, `runx_resume.responses[${index}].request_id`);
    const actor = record.actor;
    if (actor !== undefined && actor !== "human" && actor !== "agent") {
      throw new Error(`runx_resume.responses[${index}].actor must be human or agent when provided.`);
    }
    if (!("payload" in record)) {
      throw new Error(`runx_resume.responses[${index}].payload is required.`);
    }
    return {
      requestId,
      actor,
      payload: record.payload,
    };
  });
}

function toMcpToolResult(result: SurfaceRunResult): Readonly<Record<string, unknown>> {
  const base = {
    structuredContent: {
      runx: result,
    },
  };

  if (result.status === "completed") {
    return {
      ...base,
      content: [
        {
          type: "text",
          text: result.output.trim().length > 0 ? result.output : summarizeSurfaceResult(result),
        },
      ],
    };
  }

  if (result.status === "paused") {
    return {
      ...base,
      content: [
        {
          type: "text",
          text: summarizeSurfaceResult(result),
        },
      ],
    };
  }

  return {
    ...base,
    isError: true,
    content: [
      {
        type: "text",
        text: summarizeSurfaceResult(result),
      },
    ],
  };
}

function summarizeSurfaceResult(result: SurfaceRunResult): string {
  switch (result.status) {
    case "completed":
      return `${result.skillName} completed. Inspect receipt ${result.receiptId}.`;
    case "paused":
      return `${result.skillName} paused at ${result.runId}. Resume with runx_resume after resolving ${result.requests.length} request(s).`;
    case "denied":
      return `${result.skillName} was denied by policy${result.receiptId ? ` (receipt ${result.receiptId})` : ""}.`;
    case "failed":
      return `${result.skillName} failed. Inspect receipt ${result.receiptId ?? "n/a"}. ${result.error}`.trim();
  }
}

function skillInputsToJsonSchema(inputs: Readonly<Record<string, SkillInput>>): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [name, skillInputToJsonSchema(input)]),
  );
  const required = Object.entries(inputs)
    .filter(([, input]) => input.required)
    .map(([name]) => name);
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function skillInputToJsonSchema(input: SkillInput): Readonly<Record<string, unknown>> {
  const schema: Record<string, unknown> = {};
  const normalizedType = normalizeInputType(input.type);
  if (normalizedType) {
    schema.type = normalizedType;
  }
  if (input.description) {
    schema.description = input.description;
  }
  if (input.default !== undefined) {
    schema.default = input.default;
  }
  return schema;
}

function normalizeInputType(type: string): string | undefined {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
    case "array":
      return type;
    default:
      return undefined;
  }
}

function assertUniqueToolNames(tools: readonly Pick<McpToolDefinition, "name">[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`runx mcp serve received duplicate tool name '${tool.name}'. Serve unique skill names only.`);
    }
    seen.add(tool.name);
  }
}

async function serveJsonRpc(
  io: CliIo,
  handleRequest: (request: JsonRpcRequest) => Promise<Readonly<Record<string, unknown>> | undefined>,
): Promise<void> {
  let input = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string): void => {
      input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      parseAvailableMessages();
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      io.stdin.off("data", onData);
      io.stdin.off("end", onEnd);
      io.stdin.off("error", onError);
    };

    io.stdin.on("data", onData);
    io.stdin.on("end", onEnd);
    io.stdin.on("error", onError);

    function parseAvailableMessages(): void {
      while (true) {
        const headerEnd = input.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        const header = input.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          return;
        }

        const contentLength = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (input.length < bodyEnd) {
          return;
        }

        const body = input.subarray(bodyStart, bodyEnd).toString("utf8");
        input = input.subarray(bodyEnd);
        void dispatchBody(body);
      }
    }

    async function dispatchBody(body: string): Promise<void> {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        writeFramed(io.stdout, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "parse error",
          },
        });
        return;
      }
      const response = await handleRequest(request);
      if (response) {
        writeFramed(io.stdout, response);
      }
    }
  });
}

function writeFramed(stream: NodeJS.WriteStream, payload: Readonly<Record<string, unknown>>): void {
  const body = JSON.stringify(payload);
  stream.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function errorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

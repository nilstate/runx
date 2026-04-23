import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadLocalAgentApiKey, loadRunxConfigFile, resolveRunxHomeDir } from "@runxhq/core/config";
import type {
  OutputContract,
  OutputContractEntry,
  ResolutionRequest,
  ResolutionResponse,
} from "@runxhq/core/executor";

type CognitiveResolutionRequest = Extract<ResolutionRequest, { readonly kind: "cognitive_work" }>;

interface CliAgentRuntimeConfig {
  readonly provider: "openai";
  readonly model: string;
  readonly apiKey: string;
}

interface OpenAiToolCall {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

interface OpenAiToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

interface OpenAiResponseBody {
  readonly output?: readonly unknown[];
}

interface RuntimeTool {
  readonly runxName: string;
  readonly toolName: string;
  readonly definition: OpenAiToolDefinition;
  readonly execute: (argumentsValue: unknown, env: NodeJS.ProcessEnv) => unknown;
}

interface ToolCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

type ResponseInputItem =
  | Readonly<Record<string, unknown>>
  | ToolCallOutputItem;

const FINAL_RESULT_TOOL_NAME = "submit_result";

const BUILTIN_RUNTIME_TOOLS: readonly RuntimeTool[] = [
  {
    runxName: "fs.read",
    toolName: "fs_read",
    definition: {
      type: "function",
      name: "fs_read",
      description: "Read a UTF-8 text file relative to a repository or workspace root.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file relative to repo_root.",
          },
          repo_root: {
            type: "string",
            description: "Repository or workspace root.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    execute: (argumentsValue, env) => {
      const record = asRecord(argumentsValue);
      const targetPath = String(record?.path ?? "");
      if (!targetPath) {
        throw new Error("path is required.");
      }
      const repoRoot = resolveRepoRoot(record, env, { includeProjectFallback: true });
      const resolvedPath = path.resolve(repoRoot, targetPath);
      return {
        path: targetPath,
        repo_root: repoRoot,
        contents: readUtf8FileSync(resolvedPath),
      };
    },
  },
  {
    runxName: "git.status",
    toolName: "git_status",
    definition: {
      type: "function",
      name: "git_status",
      description: "Read git working tree status for a repository root.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          repo_root: {
            type: "string",
            description: "Repository root.",
          },
        },
        additionalProperties: false,
      },
    },
    execute: (argumentsValue, env) => {
      const record = asRecord(argumentsValue);
      const repoRoot = resolveRepoRoot(record, env);
      const result = spawnSync("git", ["-C", repoRoot, "status", "--short", "--branch"], {
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "git status failed.");
      }
      const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
      const branch = lines[0]?.startsWith("## ") ? lines[0].slice(3) : undefined;
      const entries = branch ? lines.slice(1) : lines;
      return {
        repo_root: repoRoot,
        branch,
        clean: entries.length === 0,
        entries,
      };
    },
  },
  {
    runxName: "git.current_branch",
    toolName: "git_current_branch",
    definition: {
      type: "function",
      name: "git_current_branch",
      description: "Read the current git branch or detached HEAD reference for a repository root.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          repo_root: {
            type: "string",
            description: "Repository root.",
          },
        },
        additionalProperties: false,
      },
    },
    execute: (argumentsValue, env) => {
      const record = asRecord(argumentsValue);
      const repoRoot = resolveRepoRoot(record, env);
      const branch = spawnSync("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
      });
      let value = branch.stdout.trim();
      let detached = false;
      if (branch.error) {
        throw branch.error;
      }
      if (branch.status !== 0 || value.length === 0) {
        const fallback = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
          encoding: "utf8",
          shell: false,
          timeout: 10_000,
        });
        if (fallback.error) {
          throw fallback.error;
        }
        if (fallback.status !== 0) {
          throw new Error(fallback.stderr || fallback.stdout || "git current branch failed.");
        }
        value = fallback.stdout.trim();
        detached = true;
      }
      return {
        repo_root: repoRoot,
        branch: value,
        detached,
      };
    },
  },
  {
    runxName: "git.diff_name_only",
    toolName: "git_diff_name_only",
    definition: {
      type: "function",
      name: "git_diff_name_only",
      description: "List changed file names relative to a git base ref.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          repo_root: {
            type: "string",
            description: "Repository root.",
          },
          base: {
            type: "string",
            description: "Base revision or tree-ish to diff against. Defaults to HEAD.",
          },
        },
        additionalProperties: false,
      },
    },
    execute: (argumentsValue, env) => {
      const record = asRecord(argumentsValue);
      const repoRoot = resolveRepoRoot(record, env);
      const base = String(record?.base ?? "HEAD");
      const result = spawnSync("git", ["-C", repoRoot, "diff", "--name-only", "--relative", base], {
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "git diff --name-only failed.");
      }
      return {
        repo_root: repoRoot,
        base,
        files: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      };
    },
  },
  {
    runxName: "cli.capture_help",
    toolName: "cli_capture_help",
    definition: {
      type: "function",
      name: "cli_capture_help",
      description: "Capture help output from a CLI command deterministically.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "CLI command to invoke.",
          },
          args: {
            type: "array",
            description: "Arguments to pass before the help flag.",
            items: { type: "string" },
          },
          help_flag: {
            type: "string",
            description: "Help flag to append. Defaults to --help.",
          },
          cwd: {
            type: "string",
            description: "Working directory override.",
          },
          repo_root: {
            type: "string",
            description: "Repository root fallback for cwd.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    execute: (argumentsValue, env) => {
      const record = asRecord(argumentsValue);
      const command = String(record?.command ?? "");
      if (!command) {
        throw new Error("command is required.");
      }
      const args = stringArray(record?.args);
      const helpFlag = String(record?.help_flag ?? "--help");
      const cwd = resolveCwd(record, env);
      const result = spawnSync(command, [...args, helpFlag], {
        cwd,
        encoding: "utf8",
        shell: false,
        timeout: 15_000,
      });
      if (result.error) {
        throw result.error;
      }
      return {
        command,
        args,
        help_flag: helpFlag,
        cwd,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exit_code: result.status ?? 0,
      };
    },
  },
  {
    runxName: "shell.exec",
    toolName: "shell_exec",
    definition: {
      type: "function",
      name: "shell_exec",
      description: "Execute an explicit command as a high-risk escape hatch.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command to execute.",
          },
          args: {
            type: "array",
            description: "Array of string arguments.",
            items: { type: "string" },
          },
          cwd: {
            type: "string",
            description: "Working directory override.",
          },
          repo_root: {
            type: "string",
            description: "Repository root fallback for cwd.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    execute: (argumentsValue, env) => {
      const record = asRecord(argumentsValue);
      const command = String(record?.command ?? "");
      if (!command) {
        throw new Error("command is required.");
      }
      const args = stringArray(record?.args);
      const cwd = resolveCwd(record, env);
      const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
      });
      if (result.error) {
        throw result.error;
      }
      return {
        command,
        args,
        cwd,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exit_code: result.status ?? 0,
      };
    },
  },
] as const;

const TOOL_BY_RUNX_NAME = new Map(BUILTIN_RUNTIME_TOOLS.map((tool) => [tool.runxName, tool]));
const TOOL_BY_OPENAI_NAME = new Map(BUILTIN_RUNTIME_TOOLS.map((tool) => [tool.toolName, tool]));

export interface CliAgentRuntime {
  readonly label: string;
  readonly resolve: (request: CognitiveResolutionRequest) => Promise<ResolutionResponse>;
}

export async function loadCliAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliAgentRuntime | undefined> {
  const config = await loadCliAgentRuntimeConfig(env);
  if (!config) {
    return undefined;
  }
  return {
    label: `OpenAI ${config.model}`,
    resolve: async (request) => resolveWithOpenAi(config, request, env),
  };
}

async function loadCliAgentRuntimeConfig(
  env: NodeJS.ProcessEnv,
): Promise<CliAgentRuntimeConfig | undefined> {
  const configDir = resolveRunxHomeDir(env);
  const configPath = path.join(configDir, "config.json");
  const config = await loadRunxConfigFile(configPath);
  const provider = String(env.RUNX_AGENT_PROVIDER ?? config.agent?.provider ?? "").trim().toLowerCase();
  if (!provider || provider !== "openai") {
    return undefined;
  }
  const model = String(env.RUNX_AGENT_MODEL ?? config.agent?.model ?? "").trim();
  if (!model) {
    return undefined;
  }
  const apiKey =
    String(env.RUNX_AGENT_API_KEY ?? env.OPENAI_API_KEY ?? "").trim()
    || (
      typeof config.agent?.api_key_ref === "string" && config.agent.api_key_ref.length > 0
        ? (await loadLocalAgentApiKey(configDir, config.agent.api_key_ref)).trim()
        : ""
    );
  if (!apiKey) {
    return undefined;
  }
  return {
    provider: "openai",
    model,
    apiKey,
  };
}

async function resolveWithOpenAi(
  config: CliAgentRuntimeConfig,
  request: CognitiveResolutionRequest,
  env: NodeJS.ProcessEnv,
): Promise<ResolutionResponse> {
  const tools = buildOpenAiTools(request);
  const history: ResponseInputItem[] = [buildInitialRequestMessage(request)];
  const unsupportedTools = unsupportedAllowedTools(request);

  for (let round = 0; round < 24; round += 1) {
    const response = await createOpenAiResponse(config, {
      instructions: buildRuntimeInstructions(request, unsupportedTools),
      input: history,
      tools,
    });
    const functionCalls = collectFunctionCalls(response);

    if (functionCalls.length === 0) {
      const assistantText = extractAssistantText(response);
      if (!request.work.envelope.expected_outputs) {
        if (!assistantText.trim()) {
          throw new Error(`Automatic agent resolution for ${request.id} returned no assistant text.`);
        }
        return {
          actor: "agent",
          payload: assistantText,
        };
      }
      if (Array.isArray(response.output) && response.output.length > 0) {
        history.push(...response.output.filter(isRecord));
      }
      history.push(buildCorrectionMessage("Return the final payload by calling submit_result. Do not answer in prose."));
      continue;
    }

    if (Array.isArray(response.output) && response.output.length > 0) {
      history.push(...response.output.filter(isRecord));
    }

    const toolOutputs: ToolCallOutputItem[] = [];
    for (const call of functionCalls) {
      if (call.name === FINAL_RESULT_TOOL_NAME) {
        try {
          const submittedPayload = parseJsonObject(call.arguments, `${call.name}.arguments`);
          const validationError = validateFinalPayload(submittedPayload, request.work.envelope.expected_outputs);
          if (!validationError) {
            return {
              actor: "agent",
              payload: submittedPayload,
            };
          }
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ error: validationError }),
          });
        } catch (error) {
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          });
        }
        continue;
      }

      const tool = TOOL_BY_OPENAI_NAME.get(call.name);
      if (!tool) {
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: `Unknown tool '${call.name}'.` }),
        });
        continue;
      }

      try {
        const result = tool.execute(parseJsonValue(call.arguments, `${call.name}.arguments`), env);
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      } catch (error) {
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    }

    history.push(...toolOutputs);
  }

  throw new Error(`Automatic agent resolution for ${request.id} exceeded the maximum tool-call rounds.`);
}

function buildRuntimeInstructions(
  request: CognitiveResolutionRequest,
  unsupportedTools: readonly string[],
): string {
  const lines = [
    "You are resolving a runx cognitive_work request inside the CLI runtime.",
    "Follow the runx instructions and inputs exactly.",
    "Treat current_context, historical_context, provenance, and explicit inputs as grounded evidence.",
    "If more repo evidence is needed, use the provided tools instead of guessing.",
    "Only use tools that are available in this request.",
    "Do not invent files, repo state, commands, or outputs that you did not inspect or infer from the grounded evidence.",
    "Use shell_exec only when the simpler fs/git tools cannot answer the question.",
  ];
  if (unsupportedTools.length > 0) {
    lines.push(`The following declared runx tools are not implemented in this CLI runtime: ${unsupportedTools.join(", ")}.`);
    lines.push("Do not rely on missing tools. Work only with the tools that are actually callable.");
  }
  if (request.work.envelope.expected_outputs) {
    lines.push(`When you are done, call ${FINAL_RESULT_TOOL_NAME} exactly once with the final payload.`);
  } else {
    lines.push("When you are done, return the final answer as plain assistant text.");
  }
  return lines.join("\n");
}

function buildInitialRequestMessage(request: CognitiveResolutionRequest): Readonly<Record<string, unknown>> {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: [
          "Resolve this runx cognitive_work request.",
          JSON.stringify({
            request_id: request.id,
            source_type: request.work.source_type,
            agent: request.work.agent,
            task: request.work.task,
            envelope: request.work.envelope,
          }, null, 2),
        ].join("\n\n"),
      },
    ],
  };
}

function buildCorrectionMessage(message: string): Readonly<Record<string, unknown>> {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: message,
      },
    ],
  };
}

function buildOpenAiTools(request: CognitiveResolutionRequest): readonly OpenAiToolDefinition[] {
  const runtimeTools = unique(request.work.envelope.allowed_tools)
    .map((toolName) => TOOL_BY_RUNX_NAME.get(toolName))
    .filter((tool): tool is RuntimeTool => Boolean(tool))
    .map((tool) => tool.definition);
  if (!request.work.envelope.expected_outputs) {
    return runtimeTools;
  }
  return [
    ...runtimeTools,
    {
      type: "function",
      name: FINAL_RESULT_TOOL_NAME,
      description: "Submit the final structured payload for this runx cognitive_work request.",
      strict: false,
      parameters: outputContractToJsonSchema(request.work.envelope.expected_outputs),
    },
  ];
}

function unsupportedAllowedTools(request: CognitiveResolutionRequest): readonly string[] {
  return unique(request.work.envelope.allowed_tools).filter((toolName) => !TOOL_BY_RUNX_NAME.has(toolName));
}

function outputContractToJsonSchema(contract: OutputContract): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(contract).map(([key, entry]) => [key, outputContractEntryToJsonSchema(entry)]),
  );
  const required = Object.entries(contract)
    .filter(([, entry]) => outputContractEntryRequired(entry))
    .map(([key]) => key);
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function outputContractEntryToJsonSchema(entry: OutputContractEntry): Readonly<Record<string, unknown>> {
  if (typeof entry === "string") {
    return simpleJsonSchemaForType(entry);
  }
  const record = asRecord(entry) ?? {};
  const type = typeof record.type === "string" ? record.type : record.enum ? "string" : undefined;
  const schema: Record<string, unknown> = type ? simpleJsonSchemaForType(type) : {};
  if (typeof record.description === "string") {
    schema.description = record.description;
  }
  if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string")) {
    schema.enum = record.enum;
  }
  if (type === "object" && schema.additionalProperties === undefined) {
    schema.additionalProperties = true;
  }
  if (type === "array" && schema.items === undefined) {
    schema.items = {};
  }
  return schema;
}

function simpleJsonSchemaForType(type: string): Record<string, unknown> {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return { type };
    case "array":
      return { type: "array", items: {} };
    case "object":
      return { type: "object", additionalProperties: true };
    default:
      return {};
  }
}

function outputContractEntryRequired(entry: OutputContractEntry): boolean {
  if (typeof entry === "string") {
    return true;
  }
  return entry.required !== false;
}

function validateFinalPayload(payload: unknown, contract: OutputContract | undefined): string | undefined {
  if (!contract) {
    return undefined;
  }
  const record = asRecord(payload);
  if (!record) {
    return "submit_result must receive a JSON object payload.";
  }

  const unknownKeys = Object.keys(record).filter((key) => !(key in contract));
  if (unknownKeys.length > 0) {
    return `submit_result contained unexpected keys: ${unknownKeys.join(", ")}.`;
  }

  for (const [key, entry] of Object.entries(contract)) {
    const value = record[key];
    const required = outputContractEntryRequired(entry);
    if (value === undefined) {
      if (required) {
        return `submit_result is missing required field '${key}'.`;
      }
      continue;
    }
    const mismatch = validateOutputContractValue(value, entry, key);
    if (mismatch) {
      return mismatch;
    }
  }

  return undefined;
}

function validateOutputContractValue(
  value: unknown,
  entry: OutputContractEntry,
  key: string,
): string | undefined {
  const spec = typeof entry === "string" ? { type: entry } : entry;
  const expectedType = typeof spec.type === "string" ? spec.type : Array.isArray(spec.enum) ? "string" : undefined;
  if (Array.isArray(spec.enum) && (!isString(value) || !spec.enum.includes(value))) {
    return `'${key}' must be one of ${spec.enum.join(", ")}.`;
  }
  if (!expectedType) {
    return undefined;
  }

  const valid =
    (expectedType === "string" && typeof value === "string")
    || (expectedType === "number" && typeof value === "number" && Number.isFinite(value))
    || (expectedType === "integer" && Number.isInteger(value))
    || (expectedType === "boolean" && typeof value === "boolean")
    || (expectedType === "array" && Array.isArray(value))
    || (expectedType === "object" && isRecord(value))
    || (expectedType === "null" && value === null);
  return valid ? undefined : `'${key}' must be ${expectedType}.`;
}

async function createOpenAiResponse(
  config: CliAgentRuntimeConfig,
  request: {
    readonly instructions: string;
    readonly input: readonly ResponseInputItem[];
    readonly tools: readonly OpenAiToolDefinition[];
  },
): Promise<OpenAiResponseBody> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      store: false,
      parallel_tool_calls: false,
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`OpenAI Responses API ${response.status}: ${extractApiErrorMessage(bodyText)}`);
  }

  return await response.json() as OpenAiResponseBody;
}

function collectFunctionCalls(response: OpenAiResponseBody): readonly OpenAiToolCall[] {
  return Array.isArray(response.output)
    ? response.output
      .filter((item): item is OpenAiToolCall =>
        isRecord(item)
        && item.type === "function_call"
        && typeof item.call_id === "string"
        && typeof item.name === "string"
        && typeof item.arguments === "string"
      )
    : [];
}

function extractAssistantText(response: OpenAiResponseBody): string {
  if (!Array.isArray(response.output)) {
    return "";
  }
  const textParts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (!isRecord(content)) {
        continue;
      }
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        textParts.push(content.text);
        continue;
      }
      if (content.type === "refusal" && typeof content.refusal === "string") {
        throw new Error(`OpenAI agent refused the request: ${content.refusal}`);
      }
    }
  }
  return textParts.join("").trim();
}

function extractApiErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    return bodyText.trim() || "request failed";
  }
  return bodyText.trim() || "request failed";
}

function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = parseJsonValue(value, label);
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return record;
}

function resolveRepoRoot(
  value: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv,
  options: { readonly includeProjectFallback?: boolean } = {},
): string {
  const candidate = value?.repo_root
    ?? (options.includeProjectFallback ? value?.project ?? value?.fixture : undefined)
    ?? env.RUNX_CWD
    ?? process.cwd();
  return path.resolve(String(candidate));
}

function resolveCwd(value: Readonly<Record<string, unknown>> | undefined, env: NodeJS.ProcessEnv): string {
  return path.resolve(String(value?.cwd ?? value?.repo_root ?? env.RUNX_CWD ?? process.cwd()));
}

function readUtf8FileSync(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

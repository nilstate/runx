import {
  validateOutputContract,
  type AdapterInvokeRequest,
  type AgentWorkRequest,
  type CognitiveResolutionRequest,
} from "@runxhq/core/executor";

import { FINAL_RESULT_TOOL_NAME, type ManagedAgentExecutionTelemetry } from "./types.js";
import { normalizeRequestId, parseConfiguredToolRoots } from "./helpers.js";
import type { ManagedAgentConfig } from "./index.js";

export function buildManagedRuntimeInstructions(request: CognitiveResolutionRequest): string {
  const lines = [
    "You are resolving a runx cognitive_work request inside the managed runtime.",
    "Follow the runx instructions and inputs exactly.",
    "Treat current_context, historical_context, provenance, and explicit inputs as grounded evidence.",
    "If more evidence is needed, use the declared runx tools instead of guessing.",
    "Tool outputs come from governed runx executions and should be treated as grounded JSON results.",
    "Do not invent files, repo state, commands, or outputs that you did not inspect or infer from grounded evidence.",
  ];
  if (request.work.envelope.expected_outputs) {
    lines.push(`When you are done, call ${FINAL_RESULT_TOOL_NAME} exactly once with the final payload.`);
  } else {
    lines.push("When you are done, return the final answer as plain assistant text.");
  }
  return lines.join("\n");
}

export function buildManagedAgentWorkRequest(
  request: AdapterInvokeRequest,
  sourceType: "agent" | "agent-step",
): AgentWorkRequest {
  const skillName = request.skillName ?? (sourceType === "agent-step" ? "agent-step" : "skill");
  const expectedOutputs = validateOutputContract(request.source.outputs, "source.outputs");
  const base = {
    run_id: request.runId ?? "rx_pending",
    step_id: request.stepId,
    skill: skillName,
    instructions: request.skillBody?.trim() ?? "",
    inputs: request.inputs,
    allowed_tools: request.allowedTools ?? [],
    current_context: request.currentContext ?? [],
    historical_context: request.historicalContext ?? [],
    provenance: request.contextProvenance ?? [],
    context: request.context,
    voice_profile: request.voiceProfile,
    quality_profile: request.qualityProfile,
    execution_location: buildExecutionLocation(request),
    trust_boundary: "native-managed: runx executes the model and tool loop directly, receipts the result, and only yields to a surface for explicit human resolution outside this path",
    ...(expectedOutputs ? { expected_outputs: expectedOutputs } : {}),
  } as const;

  if (sourceType === "agent-step") {
    return {
      id: `agent_step.${normalizeRequestId(request.source.task ?? skillName)}.output`,
      source_type: "agent-step",
      agent: request.source.agent,
      task: request.source.task,
      envelope: base,
    };
  }

  return {
    id: `agent.${normalizeRequestId(skillName)}.output`,
    source_type: "agent",
    agent: request.source.agent,
    task: request.source.task,
    envelope: base,
  };
}

export function buildExecutionLocation(request: AdapterInvokeRequest): {
  readonly skill_directory: string;
  readonly tool_roots?: readonly string[];
} {
  const toolRoots = parseConfiguredToolRoots(request.env);
  return {
    skill_directory: request.skillDirectory,
    ...(toolRoots.length > 0 ? { tool_roots: toolRoots } : {}),
  };
}

export function nativeAgentMetadata(
  sourceType: "agent" | "agent-step",
  request: AdapterInvokeRequest,
  config: ManagedAgentConfig,
  execution?: ManagedAgentExecutionTelemetry,
  status: "success" | "failure" | "paused" = execution ? "success" : "failure",
): Readonly<Record<string, unknown>> {
  if (sourceType === "agent-step") {
    return {
      agent_hook: {
        source_type: "agent-step",
        agent: request.source.agent,
        task: request.source.task,
        route: "native",
        provider: config.provider,
        model: config.model,
        status,
        rounds: execution?.rounds,
        tool_calls: execution?.toolCalls,
        tools: execution?.tools,
        tool_executions: execution?.toolExecutions,
      },
    };
  }

  return {
    agent_runner: {
      skill: request.skillName ?? "skill",
      route: "native",
      provider: config.provider,
      model: config.model,
      status,
      rounds: execution?.rounds,
      tool_calls: execution?.toolCalls,
      tools: execution?.tools,
      tool_executions: execution?.toolExecutions,
    },
  };
}

import path from "node:path";

import type {
  AgentWorkRequest,
  ApprovalGate,
  ResolutionRequest,
  ResolutionResponse,
  SkillAdapter,
} from "../executor/index.js";
import { validateOutputContract } from "../executor/index.js";

import type { Caller } from "./index.js";

async function resolveCallerRequest(
  caller: Caller,
  request: ResolutionRequest,
): Promise<ResolutionResponse | undefined> {
  return await caller.resolve(request);
}

export function createCallerAgentStepAdapter(caller: Caller): SkillAdapter {
  return {
    type: "agent-step",
    invoke: async (request) => {
      const startedAt = Date.now();
      const mediationRequest = buildAgentStepRequest(request);
      const resolutionRequest: ResolutionRequest = {
        id: mediationRequest.id,
        kind: "cognitive_work",
        work: mediationRequest,
      };
      await caller.report({
        type: "resolution_requested",
        message: `Resolution requested for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id },
      });
      const resolution = await resolveCallerRequest(caller, resolutionRequest);

      if (resolution === undefined || resolution.payload === undefined || resolution.payload === null || resolution.payload === "") {
        return {
          status: "needs_resolution",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          request: resolutionRequest,
          metadata: {
            agent_hook: {
              source_type: "agent-step",
              agent: request.source.agent,
              task: request.source.task,
              route: "yielded",
              status: "needs_resolution",
            },
          },
        };
      }

      await caller.report({
        type: "resolution_resolved",
        message: `Resolution satisfied for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id, actor: resolution.actor },
      });

      return {
        status: "success",
        stdout: typeof resolution.payload === "string" ? resolution.payload : JSON.stringify(resolution.payload),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          agent_hook: {
            source_type: "agent-step",
            agent: request.source.agent,
            task: request.source.task,
            route: "provided",
            status: "success",
          },
        },
      };
    },
  };
}

export function createCallerAgentAdapter(caller: Caller): SkillAdapter {
  return {
    type: "agent",
    invoke: async (request) => {
      const startedAt = Date.now();
      const mediationRequest = buildAgentRunnerRequest(request);
      const resolutionRequest: ResolutionRequest = {
        id: mediationRequest.id,
        kind: "cognitive_work",
        work: mediationRequest,
      };
      await caller.report({
        type: "resolution_requested",
        message: `Resolution requested for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id },
      });
      const resolution = await resolveCallerRequest(caller, resolutionRequest);

      if (resolution === undefined || resolution.payload === undefined || resolution.payload === null || resolution.payload === "") {
        return {
          status: "needs_resolution",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          request: resolutionRequest,
          metadata: {
            agent_runner: {
              skill: mediationRequest.envelope.skill,
              route: "yielded",
              status: "needs_resolution",
            },
          },
        };
      }

      await caller.report({
        type: "resolution_resolved",
        message: `Resolution satisfied for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id, actor: resolution.actor },
      });

      return {
        status: "success",
        stdout: typeof resolution.payload === "string" ? resolution.payload : JSON.stringify(resolution.payload),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          agent_runner: {
            skill: mediationRequest.envelope.skill,
            route: "provided",
            status: "success",
          },
        },
      };
    },
  };
}

export function createCallerApprovalAdapter(caller: Caller): SkillAdapter {
  return {
    type: "approval",
    invoke: async (request) => {
      const startedAt = Date.now();
      const gate = buildApprovalGate(request);
      const resolutionRequest: ResolutionRequest = {
        id: gate.id,
        kind: "approval",
        gate,
      };
      await caller.report({
        type: "resolution_requested",
        message: `Resolution requested for ${gate.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id },
      });
      const resolution = await resolveCallerRequest(caller, resolutionRequest);

      if (resolution === undefined) {
        return {
          status: "needs_resolution",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          request: resolutionRequest,
          metadata: {
            approval: {
              gate_id: gate.id,
              gate_type: gate.type,
              decision: "pending",
              reason: gate.reason,
              summary: gate.summary,
            },
          },
        };
      }
      const approved = typeof resolution.payload === "boolean" ? resolution.payload : Boolean(resolution.payload);
      await caller.report({
        type: "resolution_resolved",
        message: `Resolution satisfied for ${gate.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id, actor: resolution.actor, approved },
      });

      return {
        status: "success",
        stdout: JSON.stringify({
          approved,
          reason: gate.reason,
          conditions: [],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          approval: {
            gate_id: gate.id,
            gate_type: gate.type,
            decision: approved ? "approved" : "denied",
            reason: gate.reason,
            summary: gate.summary,
          },
        },
      };
    },
  };
}

function normalizeQuestionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function buildAgentStepRequest(request: Parameters<SkillAdapter["invoke"]>[0]): AgentWorkRequest {
  const skillName = request.skillName ?? "agent-step";
  const expectedOutputs = validateOutputContract(request.source.outputs, "source.outputs");
  return {
    id: `agent_step.${normalizeQuestionId(request.source.task ?? skillName)}.output`,
    source_type: "agent-step",
    agent: request.source.agent,
    task: request.source.task,
    envelope: {
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
      ...(expectedOutputs ? { expected_outputs: expectedOutputs } : {}),
      trust_boundary: "agent-mediated: runx yields skill context and receipts the supplied result on completion",
    },
  };
}

function buildAgentRunnerRequest(request: Parameters<SkillAdapter["invoke"]>[0]): AgentWorkRequest {
  const skillName = request.skillName ?? "skill";
  return {
    id: `agent.${normalizeQuestionId(skillName)}.output`,
    source_type: "agent",
    envelope: {
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
      trust_boundary: "agent-mediated: runx yields skill context and receipts the supplied result on completion",
    },
  };
}

function buildApprovalGate(request: Parameters<SkillAdapter["invoke"]>[0]): ApprovalGate {
  const summary = isPlainRecord(request.inputs.summary) ? request.inputs.summary : request.inputs;
  return {
    id: String(request.inputs.gate_id ?? `${request.skillName ?? "approval"}.gate`),
    type: "approval",
    reason:
      typeof request.inputs.reason === "string"
        ? request.inputs.reason
        : `Approval required for ${request.skillName ?? "approval"}.`,
    summary,
  };
}

function buildExecutionLocation(request: Parameters<SkillAdapter["invoke"]>[0]): {
  readonly skill_directory: string;
  readonly tool_roots?: readonly string[];
} {
  const toolRoots = parseConfiguredToolRoots(request.env);
  return {
    skill_directory: request.skillDirectory,
    ...(toolRoots.length > 0 ? { tool_roots: toolRoots } : {}),
  };
}

function parseConfiguredToolRoots(env: NodeJS.ProcessEnv | undefined): readonly string[] {
  return String(env?.RUNX_TOOL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => path.resolve(value));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

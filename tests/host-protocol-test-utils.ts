import path from "node:path";

import type { ResolutionRequestContract } from "@runxhq/contracts";
import type { HostBridge, HostRunOptions, HostRunState } from "@runxhq/host-adapters";
import { resolveRunxBinary } from "./runx-binary.js";

export interface HostHarness {
  readonly bridge: HostBridge;
  readonly cleanup: () => Promise<void>;
}

export const workspaceRoot = process.cwd();
export const runxBinary = resolveRunxBinary();

export function kernelTestEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNX_CWD: process.cwd(),
    RUNX_RUST_CLI_BIN: runxBinary,
    ...extra,
  };
}

export async function createHostHarness(): Promise<HostHarness> {
  const runs = new Map<string, HostRunOptions>();

  return {
    bridge: createFixtureHostBridge(runs),
    cleanup: async () => undefined,
  };
}

export function ensureRunxBinary(): void {
  resolveRunxBinary();
}

function createFixtureHostBridge(runs: Map<string, HostRunOptions>): HostBridge {
  return {
    run: async (options) => {
      const runId = `rx_host_fixture_${runs.size + 1}`;
      runs.set(runId, options);
      return {
        status: "needs_agent",
        skillName: skillName(options.skillPath),
        runId,
        requests: [inputRequest()],
        events: [],
      };
    },
    resume: async (runId, options) => {
      const original = runs.get(runId);
      const request = inputRequest();
      const reply = await options.resolver?.({ request, events: [] });
      return {
        status: "completed",
        skillName: skillName(options.skillPath ?? original?.skillPath ?? "fixture"),
        receiptId: `hrn_${runId}`,
        output: outputFromReply(reply),
        events: [],
      };
    },
    inspect: async (referenceId) => ({
      status: "completed",
      skillName: "fixture",
      runId: referenceId,
      receiptId: `hrn_${referenceId}`,
      verification: { status: "verified" },
    }) satisfies HostRunState,
  };
}

function inputRequest(): ResolutionRequestContract {
  return {
    id: "input.message",
    kind: "input",
    questions: [
      {
        id: "message",
        prompt: "Message",
        required: true,
        type: "string",
      },
    ],
  };
}

function outputFromReply(reply: Awaited<ReturnType<NonNullable<Parameters<HostBridge["run"]>[0]["resolver"]>>>): string {
  if (isRecord(reply) && "payload" in reply) {
    return outputFromReply(reply.payload as never);
  }
  if (isRecord(reply) && typeof reply.message === "string") {
    return reply.message;
  }
  return typeof reply === "string" ? reply : JSON.stringify(reply ?? {});
}

function skillName(skillPath: string): string {
  return path.basename(skillPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

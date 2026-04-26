import type { ResolutionRequest } from "../executor/index.js";
import type { LocalReceipt } from "../receipts/index.js";
import type { RunLocalSkillResult } from "../runner-local/index.js";
import type { HostRunResult } from "./host-protocol.js";

// First-party projection for trusted hosts such as the runx cloud worker.
// This is not a provider response shape and must not be returned by public
// host adapters, CLI output, public hosted APIs, or marketplace MCP tools.
export interface TrustedHostOutcome {
  readonly host: HostRunResult;
  readonly kernelStatus: RunLocalSkillResult["status"];
  readonly kernelRunId?: string;
  readonly ledgerRunId?: string;
  readonly receipt?: LocalReceipt;
  readonly receiptId?: string;
  readonly receiptKind?: LocalReceipt["kind"];
  readonly requests?: readonly ResolutionRequest[];
  readonly denialReasons?: readonly string[];
  readonly stdout?: string;
  readonly error?: string;
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
}

export function createTrustedHostOutcome(
  host: HostRunResult,
  kernel: RunLocalSkillResult,
): TrustedHostOutcome {
  assertHostKernelParity(host, kernel);
  if (kernel.status === "needs_resolution") {
    return {
      host,
      kernelStatus: kernel.status,
      kernelRunId: kernel.runId,
      ledgerRunId: kernel.runId,
      requests: kernel.requests,
      stepIds: kernel.stepIds,
      stepLabels: kernel.stepLabels,
    };
  }
  if (kernel.status === "policy_denied") {
    return {
      host,
      kernelStatus: kernel.status,
      ledgerRunId: kernel.receipt?.id,
      receipt: kernel.receipt,
      receiptId: kernel.receipt?.id,
      receiptKind: kernel.receipt?.kind,
      denialReasons: kernel.reasons,
    };
  }
  return {
    host,
    kernelStatus: kernel.status,
    ledgerRunId: kernel.receipt.id,
    receipt: kernel.receipt,
    receiptId: kernel.receipt.id,
    receiptKind: kernel.receipt.kind,
    stdout: kernel.execution.stdout,
    error: kernel.execution.errorMessage,
  };
}

function assertHostKernelParity(host: HostRunResult, kernel: RunLocalSkillResult): void {
  const expected = expectedHostStatuses(kernel);
  if (!expected.includes(host.status)) {
    throw new Error(`Trusted host status ${host.status} did not match kernel status ${kernel.status}.`);
  }
}

function expectedHostStatuses(kernel: RunLocalSkillResult): readonly HostRunResult["status"][] {
  if (kernel.status === "needs_resolution") {
    return ["paused"];
  }
  if (kernel.status === "policy_denied") {
    return ["denied"];
  }
  if (kernel.status === "failure") {
    return ["failed", "escalated"];
  }
  return ["completed"];
}

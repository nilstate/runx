import {
  RUNX_LOGICAL_SCHEMAS,
  validateHandoffSignalContract,
  validateHandoffStateContract,
  validateSuppressionRecordContract,
  type HandoffSignalContract,
  type HandoffStateContract,
  type SuppressionRecordContract,
} from "@runxhq/contracts";

import { asOptionalString, optionalDateTime } from "./internal-validators.js";

export type HandoffSignal = HandoffSignalContract;
export type HandoffState = HandoffStateContract;
export type SuppressionRecord = SuppressionRecordContract;

export interface HandoffRef {
  readonly handoff_id: string;
  readonly boundary_kind?: string;
  readonly target_repo?: string;
  readonly target_locator?: string;
  readonly contact_locator?: string;
}

export interface ReduceHandoffStateRequest extends HandoffRef {
  readonly signals?: readonly HandoffSignal[];
  readonly suppressions?: readonly SuppressionRecord[];
  readonly now?: string;
}

export function validateHandoffSignal(value: unknown, label = "handoff_signal"): HandoffSignal {
  return validateHandoffSignalContract(value, label);
}

export function validateHandoffState(value: unknown, label = "handoff_state"): HandoffState {
  return validateHandoffStateContract(value, label);
}

export function validateSuppressionRecord(value: unknown, label = "suppression_record"): SuppressionRecord {
  return validateSuppressionRecordContract(value, label);
}

export function latestHandoffSignal(
  signals: readonly HandoffSignal[],
  handoffId: string,
): HandoffSignal | undefined {
  return signals
    .filter((signal) => signal.handoff_id === handoffId)
    .slice()
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at))
    .at(-1);
}

export function findActiveSuppressionRecord(
  handoff: HandoffRef,
  suppressions: readonly SuppressionRecord[],
  now = new Date().toISOString(),
): SuppressionRecord | undefined {
  return suppressions
    .filter((record) => suppressionRecordMatchesHandoff(record, handoff))
    .filter((record) => suppressionRecordIsActive(record, now))
    .slice()
    .sort((left, right) => {
      const specificityDelta = suppressionScopeSpecificity(right.scope) - suppressionScopeSpecificity(left.scope);
      if (specificityDelta !== 0) {
        return specificityDelta;
      }
      return right.recorded_at.localeCompare(left.recorded_at);
    })
    .at(0);
}

export function handoffIsSuppressed(
  handoff: HandoffRef,
  suppressions: readonly SuppressionRecord[],
  now = new Date().toISOString(),
): boolean {
  return findActiveSuppressionRecord(handoff, suppressions, now) !== undefined;
}

export function reduceHandoffState(request: ReduceHandoffStateRequest): HandoffState {
  const now = optionalDateTime(request.now, "handoff_state.now") ?? new Date().toISOString();
  const signals = Array.isArray(request.signals)
    ? request.signals.map((signal, index) => validateHandoffSignal(signal, `signals[${index}]`))
    : [];
  const suppressions = Array.isArray(request.suppressions)
    ? request.suppressions.map((record, index) => validateSuppressionRecord(record, `suppressions[${index}]`))
    : [];
  const handoffSignals = signals
    .filter((signal) => signal.handoff_id === request.handoff_id)
    .slice()
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at));
  const lastSignal = handoffSignals.at(-1);
  const effectiveTargetLocator = request.target_locator
    ?? lastSignal?.target_locator
    ?? lastSignal?.thread_locator;
  const suppression = findActiveSuppressionRecord({
    handoff_id: request.handoff_id,
    boundary_kind: request.boundary_kind ?? lastSignal?.boundary_kind,
    target_repo: request.target_repo ?? lastSignal?.target_repo,
    target_locator: effectiveTargetLocator,
    contact_locator: request.contact_locator ?? lastSignal?.contact_locator,
  }, suppressions, now);
  const status = suppression
    ? "suppressed"
    : lastSignal
      ? handoffDispositionToStatus(lastSignal.disposition)
      : "awaiting_response";

  return validateHandoffState({
    schema: RUNX_LOGICAL_SCHEMAS.handoffState,
    handoff_id: request.handoff_id,
    boundary_kind: request.boundary_kind ?? lastSignal?.boundary_kind,
    target_repo: request.target_repo ?? lastSignal?.target_repo,
    target_locator: effectiveTargetLocator,
    contact_locator: request.contact_locator ?? lastSignal?.contact_locator,
    status,
    signal_count: handoffSignals.length,
    last_signal_id: lastSignal?.signal_id,
    last_signal_at: lastSignal?.recorded_at,
    last_signal_disposition: lastSignal?.disposition,
    suppression_record_id: suppression?.record_id,
    suppression_reason: suppression?.reason,
    summary: summarizeHandoffState(status, lastSignal, suppression),
  }, "handoff_state");
}

export function handoffStateAllowsSignalDisposition(
  state: HandoffState | Readonly<Record<string, unknown>> | undefined,
  disposition: HandoffSignal["disposition"] | string,
): boolean {
  if (disposition !== "approved_to_send") {
    return true;
  }
  return asOptionalString(state?.status) === "accepted";
}

export function handoffStateAllowsOutboxPush(
  state: HandoffState | Readonly<Record<string, unknown>> | undefined,
  requiredStatus: HandoffState["status"] = "approved_to_send",
): boolean {
  return asOptionalString(state?.status) === requiredStatus;
}

function handoffDispositionToStatus(disposition: HandoffSignal["disposition"]): HandoffState["status"] {
  switch (disposition) {
    case "acknowledged":
    case "interested":
      return "engaged";
    case "requested_changes":
      return "needs_revision";
    case "accepted":
      return "accepted";
    case "approved_to_send":
      return "approved_to_send";
    case "merged":
      return "completed";
    case "declined":
      return "declined";
    case "requested_no_contact":
      return "suppressed";
    case "rerouted":
      return "rerouted";
  }
}

function summarizeHandoffState(
  status: HandoffState["status"],
  lastSignal: HandoffSignal | undefined,
  suppression: SuppressionRecord | undefined,
): string {
  if (suppression) {
    return `suppressed by ${suppression.scope} record (${suppression.reason})`;
  }
  if (!lastSignal) {
    return "awaiting first external response";
  }
  return `${status} from ${lastSignal.source} (${lastSignal.disposition})`;
}

function suppressionScopeSpecificity(scope: SuppressionRecord["scope"]): number {
  switch (scope) {
    case "handoff":
      return 4;
    case "target":
      return 3;
    case "contact":
      return 2;
    case "repo":
      return 1;
  }
}

function suppressionRecordMatchesHandoff(record: SuppressionRecord, handoff: HandoffRef): boolean {
  switch (record.scope) {
    case "handoff":
      return record.key === handoff.handoff_id;
    case "target":
      return typeof handoff.target_locator === "string" && record.key === handoff.target_locator;
    case "repo":
      return typeof handoff.target_repo === "string" && record.key === handoff.target_repo;
    case "contact":
      return typeof handoff.contact_locator === "string" && record.key === handoff.contact_locator;
  }
}

function suppressionRecordIsActive(record: SuppressionRecord, now: string): boolean {
  return typeof record.expires_at !== "string" || record.expires_at > now;
}

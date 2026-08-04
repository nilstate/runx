import { finalizeTransition, prepareTransition, transitionSubjects } from "../state.mjs";

export function prepareSubjects(inputs) {
  return {
    ...transitionSubjects({
      operation: inputs.operation,
      currentAction: inputs.current_action,
      message: inputs.message,
      action: inputs.action,
    }),
  };
}

export function prepare(inputs) {
  return prepareTransition({
    operation: inputs.operation,
    expectedVersion: inputs.expected_version,
    observedAt: inputs.observed_at,
    scan: inputs.scan,
    messages: inputs.messages,
    currentAction: inputs.current_action,
    message: inputs.message,
    triage: inputs.triage,
    disposition: inputs.disposition,
    action: inputs.action,
    actionIdDigest: inputs.action_id_digest,
  });
}

export function finalize(inputs) {
  return {
    transition: finalizeTransition({
      transitionDraft: inputs.transition_draft,
      idempotencyBinding: inputs.idempotency_binding,
      idempotencyDigest: inputs.idempotency_digest,
    }),
  };
}

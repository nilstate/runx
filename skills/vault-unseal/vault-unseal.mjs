export default function planUnseal(inputs) {
  const secretRef = text(inputs.secret_ref);
  const purpose = text(inputs.purpose);
  const ttl = text(inputs.ttl);
  const scope = object(inputs.scope);
  const principal = text(inputs.principal);
  const blockers = [];
  let refused = false;

  if (!secretRef) {
    blockers.push("secret_ref is missing");
  } else if (!/^(vault|secret|handle):\/\/[A-Za-z0-9._/-]+$/u.test(secretRef)) {
    blockers.push("secret_ref must be an opaque vault, secret, or handle reference");
    refused = true;
  }
  if (!purpose || purpose.length > 500) blockers.push("purpose must contain 1 to 500 characters");
  if (!principal) blockers.push("principal is missing");
  if (!text(scope.resource) || !text(scope.action)) blockers.push("scope.resource and scope.action are required");

  const ttlMatch = /^(\d+)(m|h)$/u.exec(ttl);
  const ttlMinutes = ttlMatch ? Number(ttlMatch[1]) * (ttlMatch[2] === "h" ? 60 : 1) : 0;
  if (!ttlMatch || ttlMinutes < 1 || ttlMinutes > 60) blockers.push("ttl must be between 1m and 60m");
  const ready = blockers.length === 0;

  return {
    unseal_plan: {
      schema: "runx.unseal.v1",
      decision: ready ? "ready_for_approval" : refused ? "refused" : "needs_input",
      secret_ref: secretRef,
      purpose,
      ttl,
      ttl_minutes: ttlMinutes,
      scope,
      principal,
      gates: { human_approval_required: true, approval_ref: "" },
      blockers,
      execution: {
        requires_adapter: true,
        requires_approval: true,
        provider_status: "not_called",
        handle_issued: false,
        secret_material_exposed: false,
      },
      downstream_handoff: ready ? {
        skill: "vault-unseal",
        runner: "execute",
        state: "ready_for_approval",
      } : {},
      policy_notes: text(inputs.policy_notes),
    },
  };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

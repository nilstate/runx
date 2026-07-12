// purchase-approval runner: pre-spend decision gate.
// Reads procurement policy + budget balance, decides approve_in_full / scope_down /
// deny, and on approval emits a typed decision + bounded AttenuationRequest ceiling.
// Never spends, never sends, never mutates. Reads policy/budget only.

const DEFAULT_POLICY = {
  max_per_request: 5000,
  scope_caps: { software: 2000, hardware: 3000, services: 1500 },
  vendor_deny: [],
  require_purpose: true,
  budget_floor: 0,
};

function decide(request, policy, budget) {
  const findings = [];
  const currency = request.currency || "USD";
  const vendor = request.vendor || "";
  const amt = Number(request.amount) || 0;
  const scopes = request.requested_scopes || [];

  // vendor deny list
  if (policy.vendor_deny.includes(vendor)) {
    return { decision: "deny", reason: `vendor ${vendor} on deny list`, attenuated: null };
  }
  // purpose required
  if (policy.require_purpose && !(request.purpose && request.purpose.trim())) {
    return { decision: "deny", reason: "purpose required by policy", attenuated: null };
  }
  // hard per-request cap
  if (amt > policy.max_per_request) {
    findings.push(`amount ${amt} > max_per_request ${policy.max_per_request}`);
  }
  // scope caps
  const overScopes = [];
  for (const s of scopes) {
    const cap = policy.scope_caps[s];
    if (cap != null && amt > cap) overScopes.push({ s, cap });
  }
  // budget
  const remaining = (budget && Number(budget.remaining)) || 0;
  const afterBudget = remaining - amt;
  if (afterBudget < policy.budget_floor) {
    findings.push(`remaining ${remaining} - ${amt} < floor ${policy.budget_floor}`);
  }

  // decide
  if (findings.length === 0) {
    return {
      decision: "approve_in_full",
      reason: "within policy caps and budget",
      attenuated: { amount: amt, currency, counterparty: vendor, scopes, expires_at: null },
    };
  }
  // try scope_down: if only scope caps breach, cap amount to max scope cap
  if (overScopes.length > 0 && amt <= policy.max_per_request && afterBudget >= 0) {
    const minCap = Math.min(...overScopes.map((o) => o.cap));
    return {
      decision: "scope_down",
      reason: `over scope cap(s) ${JSON.stringify(overScopes)}; bounded to ${minCap}`,
      attenuated: { amount: minCap, currency, counterparty: vendor, scopes, expires_at: null },
    };
  }
  return { decision: "deny", reason: findings.join("; "), attenuated: null };
}

export async function run(inputs) {
  // decision gate only — refuse any spend/execute framing
  if (inputs && (inputs.spend === true || inputs.execute === true || inputs.pay === true)) {
    return { status: "refused", reason: "decision_gate_only", approval_packet: null };
  }
  const policy = Object.assign({}, DEFAULT_POLICY, inputs.policy || {});
  const budget = inputs.budget || { remaining: 1e9 };
  const req = inputs.request || {};
  const { decision, reason, attenuated } = decide(req, policy, budget);
  const packet = {
    schema: "runx.purchase.approval.v1",
    request_id: req.request_id,
    decision,
    reason,
    approval_decision: { decision, approver: "policy-engine", at: new Date().toISOString() },
    budget_after: (Number(budget.remaining) || 0) - (attenuated ? attenuated.amount : 0),
  };
  if (attenuated) packet.attenuation_request = attenuated;
  return {
    status: "sealed",
    agent_task: { "purchase-approval": { output: { approval_packet: packet } } },
    receipt: { schema: "runx.receipt.v1" },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  let inputs;
  if (process.env.RUNX_INPUTS_JSON) inputs = JSON.parse(process.env.RUNX_INPUTS_JSON);
  else if (process.argv[2]) inputs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  else { console.error("usage: node purchase-approval.mjs <fixture.json> | RUNX_INPUTS_JSON"); process.exit(2); }
  const ctx = process.env.RUNX_CONTEXT_JSON ? JSON.parse(process.env.RUNX_CONTEXT_JSON) : {};
  inputs = Object.assign({}, inputs, ctx);
  console.log(JSON.stringify(await run(inputs), null, 2));
}

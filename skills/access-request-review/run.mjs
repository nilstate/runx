import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const request = requireObject(inputs.access_request, "access_request");
const policy = requireObject(inputs.policy, "policy");
const entitlements = requireObject(inputs.current_entitlements, "current_entitlements");
const objective = stringValue(inputs.objective) || "Review access request.";

const normalized = normalizeInputs(request, policy, entitlements);
const decision = decide(normalized);
const grantProposal = decision.decision === "grant" ? buildGrantProposal(normalized, decision) : null;
const escalation = buildEscalation(normalized, decision);

const decisionPacket = {
  schema: "runx.security.access_request_review.v1",
  decision: decision.decision,
  request_id: normalized.requestId,
  subject_id: normalized.subjectId,
  objective,
  policy_id: normalized.policyId,
  resource: normalized.resource,
  action: normalized.action,
  requested_scope: normalized.requestedScope,
  least_privilege_scope: decision.leastPrivilegeScope,
  ttl_minutes: decision.ttlMinutes,
  approval_gate: decision.approvalGate,
  escalation,
  reasons: decision.reasons,
  evidence_refs: decision.evidenceRefs,
  safeguards: {
    read_only: true,
    mutates_grants: false,
    executes_grant: false,
    requires_human_approval: decision.decision === "grant",
  },
};

const evidenceJson = {
  schema: "frantic.delivery.evidence.v1",
  artifact: "access-request-review",
  observations: {
    request_id: normalized.requestId,
    policy_id: normalized.policyId,
    policy_digest: sha256Json(policy),
    request_digest: sha256Json(request),
    entitlement_digest: sha256Json(entitlements),
    subject_id: normalized.subjectId,
    requester_roles: normalized.roles,
    action: normalized.action,
    resource: normalized.resource,
    requested_scope: normalized.requestedScope,
    decision: decision.decision,
    least_privilege_scope: decision.leastPrivilegeScope,
    ttl_minutes: decision.ttlMinutes,
    approval_gate: decision.approvalGate,
    escalation,
    escalation_path: escalation.lane,
    current_grant_count: normalized.currentGrants.length,
    reasons: decision.reasons,
    evidence_refs: decision.evidenceRefs,
  },
};

const report = renderReport(decisionPacket, grantProposal);

process.stdout.write(
  `${JSON.stringify({ decision_packet: decisionPacket, grant_proposal: grantProposal, escalation, evidence_json: evidenceJson, report }, null, 2)}\n`,
);

function normalizeInputs(request, policy, entitlements) {
  const requestId = stringValue(request.request_id);
  const requester = requireObject(request.requester, "access_request.requester");
  const subjectId = stringValue(requester.id);
  const requesterRole = stringValue(requester.role);
  const action = stringValue(request.action);
  const resource = stringValue(request.resource);
  const requestedScope = stringValue(request.requested_scope);
  const justification = stringValue(request.justification);
  const policyId = stringValue(policy.policy_id);
  const maxTtlMinutes = numberValue(policy.max_ttl_minutes);
  const requestedTtlMinutes = numberValue(request.requested_ttl_minutes);
  const roles = [...new Set([requesterRole, ...arrayValue(entitlements.roles).map(String)].filter(Boolean))];
  const currentGrants = arrayValue(entitlements.current_grants).map((grant, index) => {
    if (!isObject(grant)) throw new Error(`current_entitlements.current_grants[${index}] must be an object`);
    return {
      grant_id: stringValue(grant.grant_id) || `grant-${index + 1}`,
      scope: stringValue(grant.scope) || "",
      expires_at: stringValue(grant.expires_at),
    };
  });

  if (!requestId) throw new Error("access_request.request_id is required");
  if (!subjectId) throw new Error("access_request.requester.id is required");
  if (!requesterRole) throw new Error("access_request.requester.role is required");
  if (!action) throw new Error("access_request.action is required");
  if (!resource) throw new Error("access_request.resource is required");
  if (!requestedScope) throw new Error("access_request.requested_scope is required");
  if (!justification) throw new Error("access_request.justification is required");
  if (!policyId) throw new Error("policy.policy_id is required");
  if (!maxTtlMinutes || maxTtlMinutes < 1) throw new Error("policy.max_ttl_minutes must be a positive number");

  return {
    requestId,
    subjectId,
    requesterRole,
    roles,
    action,
    resource,
    requestedScope,
    justification,
    ticketId: stringValue(request.ticket_id),
    requestedTtlMinutes: requestedTtlMinutes || maxTtlMinutes,
    policyId,
    maxTtlMinutes,
    allowedRoles: isObject(policy.allowed_roles) ? policy.allowed_roles : {},
    deniedResources: arrayValue(policy.denied_resources).map(String),
    sensitiveResources: arrayValue(policy.sensitive_resources).map(String),
    requiredApprovals: isObject(policy.required_approvals) ? policy.required_approvals : {},
    grantDefaults: isObject(policy.grant_defaults) ? policy.grant_defaults : {},
    currentGrants,
  };
}

function decide(input) {
  const evidenceRefs = [
    `request:${input.requestId}`,
    `policy:${input.policyId}`,
    `entitlements:${input.subjectId}`,
  ];
  const reasons = [];

  if (matchesAny(input.resource, input.deniedResources) || input.requestedScope.startsWith("secrets.")) {
    return {
      decision: "deny",
      leastPrivilegeScope: null,
      ttlMinutes: 0,
      approvalGate: "not_applicable",
      evidenceRefs,
      reasons: ["requested resource or scope is explicitly denied by policy"],
    };
  }

  const rolePolicy = firstRolePolicy(input.roles, input.allowedRoles);
  if (!rolePolicy) {
    return {
      decision: "deny",
      leastPrivilegeScope: null,
      ttlMinutes: 0,
      approvalGate: "not_applicable",
      evidenceRefs,
      reasons: ["requester has no role with access policy for this request"],
    };
  }

  const allowedActions = arrayValue(rolePolicy.actions).map(String);
  if (!allowedActions.includes(input.action)) {
    return {
      decision: "deny",
      leastPrivilegeScope: null,
      ttlMinutes: 0,
      approvalGate: "not_applicable",
      evidenceRefs,
      reasons: [`action ${input.action} is not allowed for requester role`],
    };
  }

  const allowedResources = arrayValue(rolePolicy.resources).map(String);
  if (!matchesAny(input.resource, allowedResources)) {
    return {
      decision: "deny",
      leastPrivilegeScope: null,
      ttlMinutes: 0,
      approvalGate: "not_applicable",
      evidenceRefs,
      reasons: ["requested resource does not match any allowed resource pattern"],
    };
  }

  const allowedPrefixes = arrayValue(rolePolicy.scope_prefixes).map(String);
  if (!allowedPrefixes.some((prefix) => input.requestedScope.startsWith(prefix))) {
    return {
      decision: "deny",
      leastPrivilegeScope: null,
      ttlMinutes: 0,
      approvalGate: "not_applicable",
      evidenceRefs,
      reasons: ["requested scope is outside allowed scope prefixes"],
    };
  }

  const leastPrivilegeScope = narrowScope(input.requestedScope, input.resource);
  const ttlMinutes = Math.max(1, Math.min(input.requestedTtlMinutes, input.maxTtlMinutes));
  const isSensitive = matchesAny(input.resource, input.sensitiveResources);
  const approvalGate = isSensitive
    ? stringValue(input.requiredApprovals.sensitive_resource) || "human_approval_required"
    : stringValue(input.grantDefaults.approval_gate) || "human_approval_required";

  if (input.currentGrants.some((grant) => grant.scope === leastPrivilegeScope)) {
    reasons.push("matching entitlement already exists; proposal keeps scope unchanged and flags duplicate grant risk");
  } else {
    reasons.push("request matches allowed role, action, resource, and scope prefix");
  }
  reasons.push(`ttl bounded to ${ttlMinutes} minutes by policy max ${input.maxTtlMinutes}`);
  reasons.push("proposal is gated; no access is issued by this skill");

  return {
    decision: "grant",
    leastPrivilegeScope,
    ttlMinutes,
    approvalGate,
    evidenceRefs,
    reasons,
  };
}

function buildGrantProposal(input, decision) {
  return {
    schema: "runx.security.one_time_grant_proposal.v1",
    proposal_id: `grant-proposal-${input.requestId}`,
    subject_id: input.subjectId,
    action: input.action,
    resource: input.resource,
    scope: decision.leastPrivilegeScope,
    ttl_minutes: decision.ttlMinutes,
    approval_gate: decision.approvalGate,
    ticket_id: input.ticketId,
    justification: input.justification,
    policy_id: input.policyId,
    issued_by_skill: false,
    execution_status: "proposal_only",
    handoff: {
      catalog_skill: "least-privilege-auditor",
      requires_human_approval: true,
    },
  };
}

function buildEscalation(input, decision) {
  if (decision.decision === "grant") {
    return {
      required: true,
      lane: decision.approvalGate,
      reason: "one-time grant proposal requires human approval before any access is issued",
      ticket_id: input.ticketId || null,
    };
  }
  return {
    required: decision.decision !== "deny",
    lane: decision.decision === "deny" ? "not_applicable" : "human_review",
    reason: decision.reasons[0] || "request did not satisfy policy",
    ticket_id: input.ticketId || null,
  };
}

function firstRolePolicy(roles, allowedRoles) {
  for (const role of roles) {
    if (isObject(allowedRoles[role])) return allowedRoles[role];
  }
  return null;
}

function narrowScope(scope, resource) {
  if (!scope.endsWith("*")) return scope;
  if (scope.endsWith("/*")) return scope.slice(0, -2);
  const [prefix] = scope.split("*");
  const normalizedResource = resource.replace(/^\/+/, "");
  if (prefix.endsWith("/") && normalizedResource.startsWith(prefix.split(":").slice(1).join(":"))) {
    return `${prefix}${normalizedResource.split("/").pop()}`;
  }
  return `${prefix}${normalizedResource}`;
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value, pattern) {
  if (!pattern) return false;
  if (pattern === value) return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return false;
}

function renderReport(packet, grantProposal) {
  const lines = [
    "# access-request-review report",
    "",
    `Request: ${packet.request_id}`,
    `Subject: ${packet.subject_id}`,
    `Policy: ${packet.policy_id}`,
    `Decision: ${packet.decision}`,
    `Resource: ${packet.resource}`,
    `Requested scope: ${packet.requested_scope}`,
    `Least-privilege scope: ${packet.least_privilege_scope || "none"}`,
    `TTL: ${packet.ttl_minutes} minutes`,
    `Approval gate: ${packet.approval_gate}`,
    `Escalation: ${packet.escalation.required ? packet.escalation.lane : "none"}`,
    "",
    "## Reasons",
    ...packet.reasons.map((reason) => `- ${reason}`),
    "",
    grantProposal
      ? `Grant proposal ${grantProposal.proposal_id} is proposal-only and requires ${grantProposal.approval_gate}.`
      : "No grant proposal was emitted.",
    "This skill does not mutate grants, move secrets, or call identity-provider APIs.",
  ];
  return lines.join("\n");
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) return JSON.parse(raw);
  }
  return {};
}

function requireObject(value, field) {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

const inputs = readInputs();

const spec = objectOrNull(inputs.integration_spec);
const trace = objectOrNull(inputs.trace_bundle);
const contract = objectOrNull(inputs.expected_contract);
const context = objectOrEmpty(inputs.incident_context);
const requests = Array.isArray(trace?.requests) ? trace.requests : [];
const responses = Array.isArray(trace?.responses) ? trace.responses : [];
const endpoints = Array.isArray(spec?.endpoints) ? spec.endpoints : [];
const expectedEndpoints = Array.isArray(contract?.endpoints) ? contract.endpoints : [];

let result;
let exitCode = 0;
const missing = [];
if (!spec) missing.push("integration_spec is required.");
if (!trace) missing.push("trace_bundle is required.");
if (!contract) missing.push("expected_contract is required.");
if (requests.length === 0) missing.push("trace_bundle.requests must include at least one request.");
if (responses.length === 0) missing.push("trace_bundle.responses must include at least one response.");
if (endpoints.length === 0) missing.push("integration_spec.endpoints must include at least one endpoint.");
if (expectedEndpoints.length === 0) missing.push("expected_contract.endpoints must include at least one endpoint.");

if (missing.length > 0) {
  result = stop("needs_more_evidence", missing.join(" "), [
    "trace_bundle.requests",
    "trace_bundle.responses",
    "integration_spec.endpoints",
    "expected_contract.endpoints",
  ]);
  exitCode = 2;
} else {
  result = diagnose();
  if (result.escalation.decision !== "actionable") exitCode = 2;
}

process.stdout.write(`${JSON.stringify({
  schema: "runx.integration.doctor.v1",
  data: result,
}, null, 2)}\n`);

process.exit(exitCode);

function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function diagnose() {
  const request = requests[0];
  const responseMatches = responses.filter((response) => response.request_id === request.id);
  if (responseMatches.length !== 1) {
    return stop(
      "needs_more_evidence",
      responseMatches.length === 0
        ? `No response evidence is linked to request ${request.id}.`
        : `Multiple responses are linked to request ${request.id} without disambiguation.`,
      [`request:${request.id}`, "trace_bundle.responses"],
    );
  }

  const response = responseMatches[0];
  const specEndpoint = endpoints.find((endpoint) => endpoint.id === request.endpoint_id)
    ?? endpoints.find((endpoint) => endpoint.method === request.method);
  const expected = expectedEndpoints.find((endpoint) => endpoint.id === request.endpoint_id)
    ?? expectedEndpoints.find((endpoint) => endpoint.method === request.method);

  if (!specEndpoint || !expected) {
    return stop(
      "needs_more_evidence",
      `No spec or expected-contract endpoint matches request ${request.id}.`,
      [`request:${request.id}`, "integration_spec.endpoints", "expected_contract.endpoints"],
    );
  }

  const requestPath = stringOrDefault(request.path, "");
  const expectedPath = stringOrDefault(expected.path, stringOrDefault(specEndpoint.path, ""));
  const expectedStatus = numberOrNull(expected.expected_status);
  const observedStatus = numberOrNull(response.status);
  const evidenceRefs = [
    `request:${request.id}`,
    `response:${response.id}`,
    `contract:${stringOrDefault(contract.contract_id, "expected_contract")}:${expected.id}`,
  ];

  if (requestPath !== expectedPath) {
    return actionable({
      rootCause: `Request path ${requestPath} does not match expected ${expectedPath}.`,
      confidence: 0.94,
      evidenceRefs,
      observedShape: shapeSummary(response.body_shape),
      response,
      steps: [
        {
          step: `Update the ${stringOrDefault(spec.provider, "provider")} integration base path or route template from ${requestPath} to ${expectedPath}.`,
          owner: stringOrDefault(spec.owner, "integration-owner"),
          evidence_refs: [`request:${request.id}`, `contract:${stringOrDefault(contract.contract_id, "expected_contract")}:${expected.id}`],
        },
        {
          step: `Add a regression fixture asserting ${request.method} ${expectedPath} returns status ${expectedStatus ?? "the expected status"} with required fields ${list(expected.required_fields)}.`,
          owner: stringOrDefault(spec.owner, "integration-owner"),
          evidence_refs: [`response:${response.id}`, `contract:${stringOrDefault(contract.contract_id, "expected_contract")}:${expected.id}`],
        },
      ],
    });
  }

  if (expectedStatus !== null && observedStatus !== expectedStatus) {
    return actionable({
      rootCause: `Observed status ${observedStatus} does not match expected status ${expectedStatus}.`,
      confidence: 0.86,
      evidenceRefs,
      observedShape: shapeSummary(response.body_shape),
      response,
      steps: [
        {
          step: `Investigate why ${request.method} ${requestPath} returned ${observedStatus}; compare provider error body with contract ${stringOrDefault(contract.contract_id, "expected_contract")}.`,
          owner: stringOrDefault(spec.owner, "integration-owner"),
          evidence_refs: [`response:${response.id}`],
        },
      ],
    });
  }

  const missingFields = missingRequiredFields(response.body_shape, expected.required_fields);
  if (missingFields.length > 0) {
    return actionable({
      rootCause: `Response shape is missing required fields: ${missingFields.join(", ")}.`,
      confidence: 0.82,
      evidenceRefs,
      observedShape: shapeSummary(response.body_shape),
      response,
      steps: [
        {
          step: `Map or request the missing fields ${missingFields.join(", ")} before downstream sync consumes this response.`,
          owner: stringOrDefault(spec.owner, "integration-owner"),
          evidence_refs: [`response:${response.id}`, `contract:${stringOrDefault(contract.contract_id, "expected_contract")}:${expected.id}`],
        },
      ],
    });
  }

  return {
    diagnosis: {
      root_cause: null,
      confidence: 0.55,
      evidence_refs: evidenceRefs,
      observed: {
        endpoint: `${request.method} ${requestPath}`,
        status: observedStatus,
        shape: shapeSummary(response.body_shape),
      },
    },
    fix_plan: [],
    escalation: {
      decision: "no_issue",
      lane: "none",
      reason: "Observed trace matches the expected contract; no issue proposal emitted.",
    },
    issue_proposal: null,
  };
}

function actionable({ rootCause, confidence, evidenceRefs, observedShape, response, steps }) {
  const provider = stringOrDefault(spec.provider, "integration");
  const environment = stringOrDefault(context.environment, "unspecified environment");
  const impact = stringOrDefault(context.impact, "impact not supplied");
  return {
    diagnosis: {
      root_cause: rootCause,
      confidence,
      evidence_refs: evidenceRefs,
      observed: {
        endpoint: `${requests[0].method} ${requests[0].path}`,
        status: numberOrNull(response.status),
        shape: observedShape,
      },
    },
    fix_plan: steps,
    escalation: {
      decision: "actionable",
      lane: "issue-intake",
      reason: "Trace and contract evidence identify a bounded fix proposal.",
    },
    issue_proposal: {
      title: `[${provider}] Fix integration contract mismatch in ${environment}`,
      body: [
        `Root cause: ${rootCause}`,
        `Impact: ${impact}`,
        `Evidence: ${evidenceRefs.join(", ")}`,
        `Next steps: ${steps.map((step) => step.step).join(" ")}`,
      ].join("\n\n"),
      labels: ["integration", "bug", "needs-trace-regression"],
    },
  };
}

function stop(decision, detail, evidenceRefs) {
  return {
    diagnosis: {
      root_cause: null,
      confidence: 0,
      evidence_refs: evidenceRefs,
      observed: {
        endpoint: null,
        status: null,
        shape: "insufficient evidence",
      },
    },
    fix_plan: [],
    escalation: {
      decision,
      lane: "human-review",
      reason: detail,
    },
    issue_proposal: null,
  };
}

function missingRequiredFields(bodyShape, requiredFields) {
  if (!bodyShape || typeof bodyShape !== "object" || !Array.isArray(requiredFields)) return [];
  const topLevel = new Set(Object.keys(bodyShape));
  return requiredFields.filter((field) => {
    const top = String(field).split(".")[0].replace(/\[\]$/, "");
    return !topLevel.has(top);
  });
}

function shapeSummary(shape) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return "unknown";
  return Object.keys(shape).sort().join(", ");
}

function list(value) {
  return Array.isArray(value) ? value.join(", ") : "not declared";
}

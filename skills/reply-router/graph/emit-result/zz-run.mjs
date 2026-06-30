import fs from "node:fs";

const inputs = readInputs();
const route = requiredString(inputs.route, "route");
const classification = requiredString(inputs.classification, "classification");
const reason = requiredString(inputs.reason, "reason");

if (!new Set(["suppress", "route"]).has(route)) {
  throw new Error("route must be suppress or route");
}

const suppressionResult = objectOrEmpty(inputs.suppression_result);
const routingDecision = objectOrEmpty(inputs.routing_decision);

if (route === "suppress" && !["committed", "idempotent_replay"].includes(suppressionResult.status)) {
  throw new Error("suppression_result must prove a committed or idempotently replayed append");
}
if (route === "route" && routingDecision.schema !== "runx.reply.routing.v1") {
  throw new Error("routing_decision must use runx.reply.routing.v1");
}

const result = {
  schema: "runx.reply.routing.v1",
  classification,
  action: route === "suppress" ? "suppressed" : "handoff",
  reason,
  suppression_result: route === "suppress" ? suppressionResult : {},
  routing_decision: route === "route" ? routingDecision : {},
  send_side_effects: "none",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

import fs from "node:fs";

const inputs = readInputs();
const events = Array.isArray(inputs.events) ? inputs.events : [];
const period = objectValue(inputs.period);
const from = isoOrNull(period.from);
const to = isoOrNull(period.to);
const receipts = [];

for (const entry of events) {
  const event = objectValue(entry?.event);
  const payload = objectValue(event.payload);
  const result = objectValue(payload.member_result);
  const receiptId = optionalString(result.receipt_id) ?? optionalString(result.receipt_ref);
  const createdAt = isoOrNull(result.created_at) ?? isoOrNull(entry?.committed_at);
  if (!receiptId || !createdAt) continue;
  if (from && createdAt < from) continue;
  if (to && createdAt > to) continue;
  const status = (optionalString(result.status) ?? optionalString(result.outcome) ?? "").toLowerCase();
  if (status !== "sealed" && status !== "refused") continue;
  receipts.push({
    receipt_id: receiptId,
    skill_ref: optionalString(result.skill_ref) ?? optionalString(payload.dispatch?.skill) ?? "agency-member",
    status,
    created_at: createdAt,
  });
}

process.stdout.write(`${JSON.stringify({
  schema: "runx.agency_health.ledger_seed.v1",
  source: "case-referenced-receipt-id-stubs",
  receipts,
}, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isoOrNull(value) {
  const text = optionalString(value);
  if (!text || Number.isNaN(Date.parse(text))) return null;
  return new Date(text).toISOString();
}

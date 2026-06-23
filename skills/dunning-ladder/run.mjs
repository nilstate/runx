import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const invoice = object(inputs.invoice_status, "invoice_status");
const policy = object(inputs.cadence_policy, "cadence_policy");
const agingDays = integer(inputs.aging_days, "aging_days");
const remindersSent = integer(invoice.reminders_sent ?? 0, "invoice_status.reminders_sent");
const cap = integer(policy.cap, "cadence_policy.cap");
const steps = array(policy.steps, "cadence_policy.steps")
  .map(normalizeStep)
  .sort((a, b) => a.step - b.step);

if ((text(invoice.status) || "").toLowerCase() !== "overdue" || agingDays <= 0) {
  fail("record is not actually overdue; no dunning proposal may be created");
}

if (cap <= 0) fail("cadence_policy.cap must be positive");
if (remindersSent >= cap) {
  fail(`cadence cap reached at ${remindersSent}/${cap}; escalate to an operator with no further reminder`);
}

const eligible = steps.filter((step) => step.step > remindersSent && agingDays >= step.min_days);
const next = eligible[0];
if (!next) fail("no cadence step is currently eligible; wait or escalate for policy review");
if (next.step > cap) fail("next policy step exceeds the cadence cap");

const invoiceId = text(invoice.invoice_id) || "invoice:unlabelled";
const contentBasis = JSON.stringify({
  invoice_id: invoiceId,
  customer_ref: text(invoice.customer_ref),
  aging_days: agingDays,
  step: next.step,
  template: next.template,
});
const contentDigest = `sha256:${crypto.createHash("sha256").update(contentBasis).digest("hex")}`;

emit({
  decision: {
    invoice_ref: invoiceId,
    step: next.step,
    action: "propose_reminder",
    reminders_sent: remindersSent,
    cap,
    cap_remaining_after_proposal: cap - next.step,
    reason: `Step ${next.step} is eligible at ${agingDays} aging days.`,
  },
  reminder_proposal: {
    proposed: true,
    channel: next.channel,
    template: next.template,
    content_digest: contentDigest,
    performer: "send-as",
    gate: "requires_human_approval",
    effects_emitted: [],
  },
  escalation: {
    required: false,
    path: "accounts_receivable_operator",
    trigger: null,
  },
});

function normalizeStep(value, index) {
  const step = object(value, `cadence_policy.steps[${index}]`);
  const number = integer(step.step, `cadence_policy.steps[${index}].step`);
  const minDays = integer(step.min_days, `cadence_policy.steps[${index}].min_days`);
  const channel = text(step.channel);
  const template = text(step.template);
  if (number <= 0 || minDays < 0 || !channel || !template) {
    fail("each cadence step requires positive step, non-negative min_days, channel, and template");
  }
  return { step: number, min_days: minDays, channel, template };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function array(value, name) {
  if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty array`);
  return value;
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail(`${name} must be an integer`);
  return parsed;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}


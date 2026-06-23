#!/usr/bin/env node

import { readFileSync } from "node:fs";

const input = readInput();
const invoice = input.invoice_status ?? {};
const agingDays = Number(input.aging_days);
const policy = input.cadence_policy ?? {};
const remindersSent = Math.max(0, Number(invoice.reminders_sent ?? 0));
const cap = Math.max(0, Number(policy.cap ?? 0));
const steps = Array.isArray(policy.steps) ? policy.steps : [];

let output;

if (invoice.status !== "overdue" || !Number.isFinite(agingDays) || agingDays < 1) {
  output = refused("invoice is not overdue per invoice_status and aging_days");
} else if (!Number.isFinite(cap) || cap < 1 || steps.length === 0) {
  output = refused("cadence_policy must include a positive cap and at least one step");
} else if (remindersSent >= cap) {
  output = escalated("cadence cap reached");
} else {
  const nextStepNumber = remindersSent + 1;
  const step = steps.find((candidate) => Number(candidate.step) === nextStepNumber);
  if (!step) {
    output = escalated(`cadence step ${nextStepNumber} is missing`);
  } else if (Number(step.min_aging_days ?? 0) > agingDays) {
    output = refused(
      `invoice aging ${agingDays} days is below step ${nextStepNumber} minimum ${step.min_aging_days} days`,
      nextStepNumber,
    );
  } else {
    output = proposed(step, nextStepNumber);
  }
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function proposed(step, stepNumber) {
  return {
    decision: {
      status: "proposed",
      step: stepNumber,
      action: "propose_reminder",
      reasons: [`step ${stepNumber} is within cadence cap ${cap}`],
    },
    reminder_proposal: {
      effect: "send-as",
      gated: true,
      channel: step.channel ?? null,
      content_digest: step.content_digest ?? null,
      recipient_ref: invoice.customer_ref ?? null,
      invoice_ref: invoice.invoice_id ?? null,
      amount_due: invoice.amount_due ?? null,
      currency: invoice.currency ?? null,
      approval_required: true,
      sends_directly: false,
    },
    escalation: {
      required: false,
      lane: null,
      reason: null,
      cap,
      reminders_sent: remindersSent,
    },
  };
}

function escalated(reason) {
  return {
    decision: {
      status: "escalated",
      step: null,
      action: "escalate",
      reasons: [reason],
    },
    reminder_proposal: {
      effect: "send-as",
      gated: true,
      channel: null,
      content_digest: null,
      recipient_ref: invoice.customer_ref ?? null,
      invoice_ref: invoice.invoice_id ?? null,
      amount_due: invoice.amount_due ?? null,
      currency: invoice.currency ?? null,
      approval_required: true,
      sends_directly: false,
    },
    escalation: {
      required: true,
      lane: policy.escalation_lane ?? "operator-review",
      reason,
      cap,
      reminders_sent: remindersSent,
    },
  };
}

function refused(reason, step = null) {
  return {
    decision: {
      status: "refused",
      step,
      action: "refuse",
      reasons: [reason],
    },
    reminder_proposal: {
      effect: "send-as",
      gated: true,
      channel: null,
      content_digest: null,
      recipient_ref: invoice.customer_ref ?? null,
      invoice_ref: invoice.invoice_id ?? null,
      amount_due: invoice.amount_due ?? null,
      currency: invoice.currency ?? null,
      approval_required: true,
      sends_directly: false,
    },
    escalation: {
      required: false,
      lane: null,
      reason,
      cap,
      reminders_sent: remindersSent,
    },
  };
}

function readInput() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }

  const args = process.argv.slice(2);
  const input = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input-json") {
      const [key, rawValue] = String(args[++i] ?? "").split(/=(.*)/s);
      input[key] = JSON.parse(rawValue);
    }
  }

  if (Object.keys(input).length > 0) {
    return input;
  }

  const stdin = readFileSync(0, "utf8").trim();
  return stdin ? JSON.parse(stdin) : {};
}

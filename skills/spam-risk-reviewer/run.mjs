#!/usr/bin/env node

import fs from "node:fs";

const POLICY_THRESHOLDS = {
  bounce_rate_max: 0.05,
  complaint_rate_max: 0.001,
  freshness_days_max: 30,
  warm_up_floor_days: 30,
};

const CONTENT_RISK_PATTERNS = [
  /free money/i,
  /click here now/i,
  /urgent/i,
  /act now/i,
  /once-in-a-lifetime/i,
  /limited time only/i,
];

function readInputs() {
  const env = process.env || {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("RUNX_INPUT_")) continue;
    const key = k.slice("RUNX_INPUT_".length).toLowerCase();
    out[key] = coerceJson(v);
  }
  return out;
}

function coerceJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function required(value, path) {
  if (value === undefined || value === null) {
    throw new Error(`${path} is required`);
  }
  return value;
}

function asObject(value, path) {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function asString(value, path) {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function asNumber(value, path) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${path} must be a number`);
  }
  return value;
}

function asBool(value, path) {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function detectContentRiskFlags(digest) {
  const flags = [];
  for (const pat of CONTENT_RISK_PATTERNS) {
    if (pat.test(digest)) flags.push(pat.source.replace(/\/i$/, "").replace(/^\//, ""));
  }
  return flags;
}

function judge(inputs) {
  const draft = asObject(inputs.campaign_draft, "campaign_draft");
  const listMeta = asObject(inputs.list_metadata, "list_metadata");
  const authPosture = asObject(inputs.sender_auth_posture, "sender_auth_posture");

  asString(draft.from, "campaign_draft.from");
  asString(draft.subject, "campaign_draft.subject");
  asString(draft.content_digest, "campaign_draft.content_digest");

  asNumber(listMeta.size, "list_metadata.size");
  asNumber(listMeta.bounce_rate, "list_metadata.bounce_rate");
  asNumber(listMeta.complaint_rate, "list_metadata.complaint_rate");
  asNumber(listMeta.freshness_days, "list_metadata.freshness_days");

  asBool(authPosture.spf_pass, "sender_auth_posture.spf_pass");
  asBool(authPosture.dkim_pass, "sender_auth_posture.dkim_pass");
  asBool(authPosture.dmarc_pass, "sender_auth_posture.dmarc_pass");
  asNumber(authPosture.warm_up_days, "sender_auth_posture.warm_up_days");

  const blockers = [];
  const contentFlags = detectContentRiskFlags(asString(draft.content_digest, "campaign_draft.content_digest"));

  if (authPosture.spf_pass !== true) blockers.push("spf_pass is false: SPF must pass before any send.");
  if (authPosture.dkim_pass !== true) blockers.push("dkim_pass is false: DKIM must pass before any send.");
  if (authPosture.dmarc_pass !== true) blockers.push("dmarc_pass is false: DMARC must pass before any send.");

  if (listMeta.bounce_rate > POLICY_THRESHOLDS.bounce_rate_max) {
    blockers.push(`bounce_rate ${listMeta.bounce_rate} exceeds policy max ${POLICY_THRESHOLDS.bounce_rate_max}.`);
  }
  if (listMeta.complaint_rate > POLICY_THRESHOLDS.complaint_rate_max) {
    blockers.push(`complaint_rate ${listMeta.complaint_rate} exceeds policy max ${POLICY_THRESHOLDS.complaint_rate_max}.`);
  }
  if (listMeta.freshness_days > POLICY_THRESHOLDS.freshness_days_max) {
    blockers.push(`freshness_days ${listMeta.freshness_days} exceeds policy max ${POLICY_THRESHOLDS.freshness_days_max}.`);
  }
  if (authPosture.warm_up_days < POLICY_THRESHOLDS.warm_up_floor_days) {
    blockers.push(`warm_up_days ${authPosture.warm_up_days} is below recommended floor ${POLICY_THRESHOLDS.warm_up_floor_days}.`);
  }
  if (contentFlags.length > 0) {
    blockers.push(`content risk flag present for: ${contentFlags.join(", ")}.`);
  }

  let riskLevel = "pass";
  let preflightClear = true;
  let decisionRefusalReason = null;

  if (blockers.length > 0) {
    preflightClear = false;
    const authFail = !authPosture.dkim_pass || !authPosture.spf_pass || !authPosture.dmarc_pass;
    const bounceExceeded = listMeta.bounce_rate > POLICY_THRESHOLDS.bounce_rate_max;
    if (authFail && bounceExceeded) {
      riskLevel = "block";
      decisionRefusalReason = "needs_human";
    } else {
      riskLevel = "hold";
      decisionRefusalReason = "needs_human";
    }
  }

  const sendRiskVerdict = {
    risk_level: riskLevel,
    preflight_clear: preflightClear,
    blockers,
    evidence_summary: {
      auth_signals_verified: {
        spf_pass: authPosture.spf_pass,
        dkim_pass: authPosture.dkim_pass,
        dmarc_pass: authPosture.dmarc_pass,
        warm_up_days: authPosture.warm_up_days,
      },
      list_hygiene_metrics: {
        size: listMeta.size,
        bounce_rate: listMeta.bounce_rate,
        complaint_rate: listMeta.complaint_rate,
        freshness_days: listMeta.freshness_days,
      },
      content_risk_flags: contentFlags,
      policy_thresholds_applied: { ...POLICY_THRESHOLDS },
    },
    decision_refusal: { reason: decisionRefusalReason },
  };
  return { send_risk_verdict: sendRiskVerdict };
}

function main() {
  const inputs = readInputs();
  let result;
  try {
    result = judge(inputs);
  } catch (err) {
    process.stderr.write(`spam-risk-reviewer: refusal: ${err.message}\n`);
    process.stdout.write(JSON.stringify({
      send_risk_verdict: {
        risk_level: "block",
        preflight_clear: false,
        blockers: [err.message],
        evidence_summary: {
          auth_signals_verified: {},
          list_hygiene_metrics: {},
          content_risk_flags: [],
          policy_thresholds_applied: { ...POLICY_THRESHOLDS },
        },
        decision_refusal: { reason: "needs_human" },
      },
    }, null, 2) + "\n");
    process.exitCode = 64;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // A blocked send is a valid sealed review verdict, not a runner failure.
}

main();

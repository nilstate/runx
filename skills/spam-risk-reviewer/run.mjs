import fs from "node:fs";

const SCHEMA = "runx.send.spam_risk_review.v1";
const VERSION = "0.1.1";
const POLICY = {
  max_bounce_rate: 0.02,
  max_complaint_rate: 0.001,
  max_freshness_days: 90,
  min_warm_up_days: 14,
};
const CONTENT_RISK_TERMS = [
  "act now",
  "free money",
  "guaranteed",
  "risk-free",
  "winner",
  "urgent",
];

const inputs = readInputs();
const campaignDraft = readCampaignDraft(inputs.campaign_draft);
const listMetadata = readListMetadata(inputs.list_metadata);
const senderAuthPosture = readSenderAuthPosture(inputs.sender_auth_posture);
const harnessCase = stringValue(inputs.harness_case);

const packet = reviewSpamRisk({
  campaignDraft,
  listMetadata,
  senderAuthPosture,
  harnessCase,
});

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);

function reviewSpamRisk({ campaignDraft, listMetadata, senderAuthPosture, harnessCase }) {
  const blockers = [
    ...authenticationBlockers(senderAuthPosture),
    ...listHygieneBlockers(listMetadata),
    ...draftBlockers(campaignDraft),
  ];
  const contentRiskFlags = contentRiskFlagsFor(campaignDraft);
  for (const flag of contentRiskFlags) {
    blockers.push(`content: ${flag}`);
  }

  const preflightClear = blockers.length === 0;
  const riskLevel = preflightClear ? "pass" : "hold";
  const refusedReason = preflightClear ? null : `preflight-hold: ${blockers.join("; ")}`;

  return {
    schema: SCHEMA,
    version: VERSION,
    send_risk_verdict: {
      risk_level: riskLevel,
      preflight_clear: preflightClear,
      blockers,
      evidence_summary: {
        authentication: {
          spf_pass: senderAuthPosture.spf_pass,
          dkim_pass: senderAuthPosture.dkim_pass,
          dmarc_pass: senderAuthPosture.dmarc_pass,
          warm_up_days: senderAuthPosture.warm_up_days,
        },
        list_hygiene: {
          size: listMetadata.size,
          bounce_rate: listMetadata.bounce_rate,
          complaint_rate: listMetadata.complaint_rate,
          freshness_days: listMetadata.freshness_days,
          freshness_source: listMetadata.freshness_source,
        },
        content_risk_flags: contentRiskFlags,
        policy: POLICY,
      },
    },
    dispatch_target: {
      name: "send-as",
      type: "named_downstream",
      typed_inputs: {
        preflight_required: true,
        blockers,
        verdict_ref: "send_risk_verdict",
        campaign_from: campaignDraft.from,
        content_digest: campaignDraft.content_digest,
      },
    },
    escalation: {
      lane: preflightClear ? "none" : "needs_human",
      required: !preflightClear,
      reason: refusedReason,
    },
    evidence: evidenceBlock({
      harnessCase,
      campaignDraft,
      listMetadata,
      senderAuthPosture,
      blockers,
      contentRiskFlags,
      refusedReason,
      riskLevel,
      preflightClear,
      receiptId: null,
    }),
  };
}

function authenticationBlockers(posture) {
  const blockers = [];
  if (!posture.spf_pass) blockers.push("authentication: SPF does not pass");
  if (!posture.dkim_pass) blockers.push("authentication: DKIM does not pass");
  if (!posture.dmarc_pass) blockers.push("authentication: DMARC does not pass");
  if (posture.warm_up_days < POLICY.min_warm_up_days) {
    blockers.push(`authentication: warm_up_days ${posture.warm_up_days} is below policy min ${POLICY.min_warm_up_days}`);
  }
  return blockers;
}

function listHygieneBlockers(metadata) {
  const blockers = [];
  if (metadata.size <= 0) blockers.push("list_hygiene: list size must be positive");
  if (metadata.bounce_rate > POLICY.max_bounce_rate) {
    blockers.push(`list_hygiene: bounce_rate ${formatRate(metadata.bounce_rate)} exceeds policy max ${formatRate(POLICY.max_bounce_rate)}`);
  }
  if (metadata.complaint_rate > POLICY.max_complaint_rate) {
    blockers.push(`list_hygiene: complaint_rate ${formatRate(metadata.complaint_rate)} exceeds policy max ${formatRate(POLICY.max_complaint_rate)}`);
  }
  if (metadata.freshness_days > POLICY.max_freshness_days) {
    blockers.push(`list_hygiene: freshness ${metadata.freshness_days} days exceeds policy max ${POLICY.max_freshness_days}`);
  }
  return blockers;
}

function draftBlockers(draft) {
  const blockers = [];
  if (!draft.from.includes("@")) blockers.push("campaign_draft: from must be an email-like sender");
  if (!draft.content_digest.startsWith("sha256:")) {
    blockers.push("campaign_draft: content_digest must be sha256-bound");
  }
  return blockers;
}

function contentRiskFlagsFor(draft) {
  const haystack = `${draft.subject} ${draft.content_digest_label ?? ""}`.toLowerCase();
  return CONTENT_RISK_TERMS
    .filter((term) => haystack.includes(term))
    .map((term) => `subject_or_digest_label contains '${term}'`);
}

function evidenceBlock({
  harnessCase,
  campaignDraft,
  listMetadata,
  senderAuthPosture,
  blockers,
  contentRiskFlags,
  refusedReason,
  riskLevel,
  preflightClear,
  receiptId,
}) {
  return {
    harness_case: harnessCase ?? (preflightClear ? "low-risk-verified-sender" : "high-risk-incomplete-auth-poor-list"),
    campaign: {
      from: campaignDraft.from,
      subject: campaignDraft.subject,
      content_digest: campaignDraft.content_digest,
    },
    authentication_signals: {
      spf_pass: senderAuthPosture.spf_pass,
      dkim_pass: senderAuthPosture.dkim_pass,
      dmarc_pass: senderAuthPosture.dmarc_pass,
      warm_up_days: senderAuthPosture.warm_up_days,
      min_warm_up_days: POLICY.min_warm_up_days,
    },
    list_hygiene_metrics: {
      size: listMetadata.size,
      bounce_rate: listMetadata.bounce_rate,
      max_bounce_rate: POLICY.max_bounce_rate,
      complaint_rate: listMetadata.complaint_rate,
      max_complaint_rate: POLICY.max_complaint_rate,
      freshness_days: listMetadata.freshness_days,
      max_freshness_days: POLICY.max_freshness_days,
      freshness_source: listMetadata.freshness_source,
    },
    content_risk_flags: contentRiskFlags,
    blockers,
    observations: [
      `risk_level verdict: ${riskLevel}`,
      `preflight_clear: ${preflightClear}`,
      `authentication signals verified: SPF=${senderAuthPosture.spf_pass}, DKIM=${senderAuthPosture.dkim_pass}, DMARC=${senderAuthPosture.dmarc_pass}, warm_up_days=${senderAuthPosture.warm_up_days}`,
      `list hygiene metrics: ${thresholdObservation("bounce_rate", listMetadata.bounce_rate, POLICY.max_bounce_rate)}, ${thresholdObservation("complaint_rate", listMetadata.complaint_rate, POLICY.max_complaint_rate)}, ${thresholdObservation("freshness_days", listMetadata.freshness_days, POLICY.max_freshness_days)}`,
      `content risk flags: ${contentRiskFlags.length === 0 ? "none" : contentRiskFlags.join("; ")}`,
      `blockers: ${blockers.length === 0 ? "[]" : blockers.join("; ")}`,
      `harness cases: low-risk-verified-sender, high-risk-incomplete-auth-poor-list, missing-sender-auth-posture-fails-closed`,
      refusedReason === null ? "refused reason: null" : `refused reason: ${refusedReason}`,
      "dispatch target: send-as preflight blockers; public_send effect remains owned by send-as",
    ],
    refused_reason: refusedReason,
    receipt_id: receiptId,
  };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function readCampaignDraft(value) {
  const draft = objectValue(value, "campaign_draft");
  return {
    from: requiredString(draft.from, "campaign_draft.from"),
    subject: requiredString(draft.subject, "campaign_draft.subject"),
    content_digest: requiredString(draft.content_digest, "campaign_draft.content_digest"),
    content_digest_label: stringValue(draft.content_digest_label),
  };
}

function readListMetadata(value) {
  const metadata = objectValue(value, "list_metadata");
  const freshness = readFreshness(metadata.freshness);
  return {
    size: integerValue(metadata.size, "list_metadata.size"),
    bounce_rate: rateValue(metadata.bounce_rate, "list_metadata.bounce_rate"),
    complaint_rate: rateValue(metadata.complaint_rate, "list_metadata.complaint_rate"),
    freshness_days: freshness.days,
    freshness_source: freshness.source,
  };
}

function readSenderAuthPosture(value) {
  const posture = objectValue(value, "sender_auth_posture");
  return {
    spf_pass: booleanValue(posture.spf_pass, "sender_auth_posture.spf_pass"),
    dkim_pass: booleanValue(posture.dkim_pass, "sender_auth_posture.dkim_pass"),
    dmarc_pass: booleanValue(posture.dmarc_pass, "sender_auth_posture.dmarc_pass"),
    warm_up_days: integerValue(posture.warm_up_days, "sender_auth_posture.warm_up_days"),
  };
}

function readFreshness(value) {
  if (Number.isFinite(value)) {
    return { days: Math.trunc(value), source: null };
  }
  const freshness = objectValue(value, "list_metadata.freshness");
  return {
    days: integerValue(freshness.days_since_last_confirmed, "list_metadata.freshness.days_since_last_confirmed"),
    source: stringValue(freshness.source),
  };
}

function objectValue(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requiredString(value, field) {
  const result = stringValue(value);
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function integerValue(value, field) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  if (value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function rateValue(value, field) {
  if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  if (value < 0 || value > 1) throw new Error(`${field} must be between 0 and 1`);
  return value;
}

function formatRate(value) {
  return Number(value).toString();
}

function thresholdObservation(label, actual, max) {
  const comparison = actual <= max ? "within" : "exceeds";
  const actualText = typeof actual === "number" && !Number.isInteger(actual)
    ? formatRate(actual)
    : String(actual);
  const maxText = typeof max === "number" && !Number.isInteger(max)
    ? formatRate(max)
    : String(max);
  return `${label}=${actualText} ${comparison} max ${maxText}`;
}

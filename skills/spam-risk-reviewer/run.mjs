import fs from "node:fs";

const inputs = readInputs();

try {
  const verdict = decide(inputs);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(64);
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function decide(raw) {
  const campaign = requireObject(raw.campaign_draft, "campaign_draft");
  const list = requireObject(raw.list_metadata, "list_metadata");
  const auth = requireObject(raw.sender_auth_posture, "sender_auth_posture");
  const policy = requireObject(raw.policy, "policy");

  const from = requireString(campaign.from, "campaign_draft.from");
  const subject = requireString(campaign.subject, "campaign_draft.subject");
  const contentDigest = requireString(campaign.content_digest, "campaign_draft.content_digest");
  const size = requireNumber(list.size, "list_metadata.size");
  const bounceRate = requireNumber(list.bounce_rate, "list_metadata.bounce_rate");
  const complaintRate = requireNumber(list.complaint_rate, "list_metadata.complaint_rate");
  const freshnessDays = requireNumber(list.freshness_days, "list_metadata.freshness_days");
  const spfPass = requireBoolean(auth.spf_pass, "sender_auth_posture.spf_pass");
  const dkimPass = requireBoolean(auth.dkim_pass, "sender_auth_posture.dkim_pass");
  const dmarcPass = requireBoolean(auth.dmarc_pass, "sender_auth_posture.dmarc_pass");
  const warmUpDays = requireNumber(auth.warm_up_days, "sender_auth_posture.warm_up_days");
  const maxBounceRate = requireNumber(policy.max_bounce_rate, "policy.max_bounce_rate");
  const maxComplaintRate = requireNumber(policy.max_complaint_rate, "policy.max_complaint_rate");
  const maxFreshnessDays = requireNumber(policy.max_freshness_days, "policy.max_freshness_days");
  const minWarmUpDays = requireNumber(policy.min_warm_up_days, "policy.min_warm_up_days");
  const riskyTerms = requireStringArray(policy.risky_content_terms || [], "policy.risky_content_terms");

  const blockers = [];
  if (!spfPass) blockers.push(blocker("spf_failed", "SPF did not pass", { spf_pass: spfPass }));
  if (!dkimPass) blockers.push(blocker("dkim_failed", "DKIM did not pass", { dkim_pass: dkimPass }));
  if (!dmarcPass) blockers.push(blocker("dmarc_failed", "DMARC did not pass", { dmarc_pass: dmarcPass }));
  if (bounceRate > maxBounceRate) blockers.push(blocker("bounce_rate_high", "Bounce rate exceeds policy threshold", { bounce_rate: bounceRate, max_bounce_rate: maxBounceRate }));
  if (complaintRate > maxComplaintRate) blockers.push(blocker("complaint_rate_high", "Complaint rate exceeds policy threshold", { complaint_rate: complaintRate, max_complaint_rate: maxComplaintRate }));
  if (freshnessDays > maxFreshnessDays) blockers.push(blocker("list_stale", "List freshness exceeds policy threshold", { freshness_days: freshnessDays, max_freshness_days: maxFreshnessDays }));
  if (warmUpDays < minWarmUpDays) blockers.push(blocker("sender_not_warmed", "Sender warm-up is below policy floor", { warm_up_days: warmUpDays, min_warm_up_days: minWarmUpDays }));

  const normalizedText = normalize(`${subject} ${contentDigest}`);
  const matchedRiskyTerms = riskyTerms.filter((term) => normalizedText.includes(normalize(term)));
  if (matchedRiskyTerms.length > 0) {
    blockers.push(blocker("risky_content_terms", "Campaign digest contains risky content terms", { matched_terms: matchedRiskyTerms }));
  }

  const preflightClear = blockers.length === 0;
  const riskLevel = preflightClear ? "pass" : "hold";
  const evidenceSummary = {
    from,
    list_size: size,
    authentication: { spf_pass: spfPass, dkim_pass: dkimPass, dmarc_pass: dmarcPass, warm_up_days: warmUpDays },
    list_hygiene: { bounce_rate: bounceRate, complaint_rate: complaintRate, freshness_days: freshnessDays },
    thresholds: { max_bounce_rate: maxBounceRate, max_complaint_rate: maxComplaintRate, max_freshness_days: maxFreshnessDays, min_warm_up_days: minWarmUpDays },
    content_risk_flags: matchedRiskyTerms,
  };

  const sendRiskVerdict = {
    schema: "runx.send_risk_verdict.v1",
    risk_level: riskLevel,
    preflight_clear: preflightClear,
    blockers,
    evidence_summary: evidenceSummary,
    send_as_binding: {
      preflight_required: true,
      blocker_source: "spam-risk-reviewer",
      public_send_effect_owner: "send-as",
    },
  };

  return {
    risk_level: riskLevel,
    preflight_clear: preflightClear,
    blockers,
    evidence_summary: evidenceSummary,
    send_risk_verdict: sendRiskVerdict,
    escalation: preflightClear ? null : "needs_human",
  };
}

function blocker(code, reason, evidence) {
  return { code, reason, evidence };
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`);
  }
  return number;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
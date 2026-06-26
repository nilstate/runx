import fs from "node:fs";
import path from "node:path";

const SCHEMA = "spam.risk.reviewer.evidence.v1";
const VERSION = "0.1.0";

const inputs = readInputs();
const policy = normalizePolicy(inputs.policy);
const verdict = reviewSpamRisk(inputs, policy);
const evidence = buildEvidence(inputs, policy, verdict);
const report = renderReport(evidence);

writeArtifacts(inputs.output_dir, evidence, report);

process.stdout.write(`${JSON.stringify({
  send_risk_verdict: verdict,
  evidence_json: evidence,
  report_md: report,
}, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizePolicy(raw = {}) {
  return {
    max_bounce_rate: numberOr(raw.max_bounce_rate, 0.02),
    max_complaint_rate: numberOr(raw.max_complaint_rate, 0.001),
    max_freshness_days: numberOr(raw.max_freshness_days, 90),
    min_warm_up_days: numberOr(raw.min_warm_up_days, 14),
  };
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function reviewSpamRisk(rawInputs, policy) {
  const campaign = objectOr(rawInputs.campaign_draft);
  const list = objectOr(rawInputs.list_metadata);
  const auth = objectOr(rawInputs.sender_auth_posture);
  const blockers = [];
  const evidenceSummary = [];

  const from = stringOr(campaign.from);
  const subject = stringOr(campaign.subject);
  const digest = stringOr(campaign.content_digest);
  const size = numberOr(list.size, -1);
  const bounceRate = numberOr(list.bounce_rate, -1);
  const complaintRate = numberOr(list.complaint_rate, -1);
  const freshness = numberOr(list.freshness, -1);
  const spfPass = auth.spf_pass === true;
  const dkimPass = auth.dkim_pass === true;
  const dmarcPass = auth.dmarc_pass === true;
  const warmUpDays = numberOr(auth.warm_up_days, -1);

  if (!from) blockers.push("campaign_draft.from is required");
  if (!subject) blockers.push("campaign_draft.subject is required");
  if (!digest) blockers.push("campaign_draft.content_digest is required");
  if (size < 0) blockers.push("list_metadata.size is required");
  if (bounceRate < 0) blockers.push("list_metadata.bounce_rate is required");
  if (complaintRate < 0) blockers.push("list_metadata.complaint_rate is required");
  if (freshness < 0) blockers.push("list_metadata.freshness is required");
  if (!spfPass) blockers.push("SPF did not pass");
  if (!dkimPass) blockers.push("DKIM did not pass");
  if (!dmarcPass) blockers.push("DMARC did not pass");
  if (warmUpDays < 0) blockers.push("sender_auth_posture.warm_up_days is required");
  if (bounceRate > policy.max_bounce_rate) {
    blockers.push(`bounce_rate ${bounceRate} exceeds ${policy.max_bounce_rate}`);
  }
  if (complaintRate > policy.max_complaint_rate) {
    blockers.push(`complaint_rate ${complaintRate} exceeds ${policy.max_complaint_rate}`);
  }
  if (freshness > policy.max_freshness_days) {
    blockers.push(`list freshness ${freshness} days exceeds ${policy.max_freshness_days}`);
  }
  if (warmUpDays < policy.min_warm_up_days) {
    blockers.push(`warm_up_days ${warmUpDays} below ${policy.min_warm_up_days}`);
  }

  const contentFlags = detectContentFlags(`${subject} ${digest}`);
  for (const flag of contentFlags) {
    blockers.push(`content risk flag: ${flag}`);
  }

  evidenceSummary.push(`auth spf=${spfPass} dkim=${dkimPass} dmarc=${dmarcPass}`);
  evidenceSummary.push(`list size=${size} bounce_rate=${bounceRate} complaint_rate=${complaintRate} freshness=${freshness}`);
  evidenceSummary.push(`policy bounce<=${policy.max_bounce_rate} complaint<=${policy.max_complaint_rate} freshness<=${policy.max_freshness_days} warm_up>=${policy.min_warm_up_days}`);
  if (contentFlags.length > 0) {
    evidenceSummary.push(`content flags=${contentFlags.join(", ")}`);
  } else {
    evidenceSummary.push("content flags=none");
  }

  const preflightClear = blockers.length === 0;
  let riskLevel = "pass";
  let escalation = "none";
  if (!preflightClear) {
    riskLevel = blockers.some((reason) => reason.includes("did not pass") || reason.includes("exceeds"))
      ? "hold"
      : "review";
    escalation = "needs_human";
  }

  return {
    risk_level: riskLevel,
    preflight_clear: preflightClear,
    blockers,
    evidence_summary: evidenceSummary,
    escalation,
    dispatch_target: "send-as",
    effect_boundary: "public_send remains owned by governed send-as, not this skill",
  };
}

function detectContentFlags(text) {
  const normalized = text.toLowerCase();
  const flags = [];
  for (const [needle, label] of [
    ["urgent", "urgency language"],
    ["expires tonight", "short-deadline promotion"],
    ["free money", "misleading financial language"],
    ["no unsubscribe", "missing unsubscribe signal"],
  ]) {
    if (normalized.includes(needle)) {
      flags.push(label);
    }
  }
  return flags;
}

function buildEvidence(rawInputs, policy, verdict) {
  const campaign = objectOr(rawInputs.campaign_draft);
  const list = objectOr(rawInputs.list_metadata);
  const auth = objectOr(rawInputs.sender_auth_posture);
  return {
    schema: SCHEMA,
    skill: {
      name: "spam-risk-reviewer",
      version: VERSION,
    },
    observations: [
      `risk_level=${verdict.risk_level}`,
      `preflight_clear=${verdict.preflight_clear}`,
      `authentication spf_pass=${auth.spf_pass === true} dkim_pass=${auth.dkim_pass === true} dmarc_pass=${auth.dmarc_pass === true}`,
      `list hygiene size=${numberOr(list.size, -1)} bounce_rate=${numberOr(list.bounce_rate, -1)} complaint_rate=${numberOr(list.complaint_rate, -1)} freshness=${numberOr(list.freshness, -1)}`,
      `policy thresholds max_bounce_rate=${policy.max_bounce_rate} max_complaint_rate=${policy.max_complaint_rate} max_freshness_days=${policy.max_freshness_days} min_warm_up_days=${policy.min_warm_up_days}`,
      `content risk flags=${detectContentFlags(`${stringOr(campaign.subject)} ${stringOr(campaign.content_digest)}`).join(", ") || "none"}`,
      `blockers=${verdict.blockers.join(" | ") || "none"}`,
      "harness cases=low-risk-verified-sender, high-risk-incomplete-auth-poor-list",
    ],
    campaign_draft: {
      from: stringOr(campaign.from),
      subject: stringOr(campaign.subject),
      content_digest: stringOr(campaign.content_digest),
    },
    list_metadata: {
      size: numberOr(list.size, -1),
      bounce_rate: numberOr(list.bounce_rate, -1),
      complaint_rate: numberOr(list.complaint_rate, -1),
      freshness: numberOr(list.freshness, -1),
    },
    sender_auth_posture: {
      spf_pass: auth.spf_pass === true,
      dkim_pass: auth.dkim_pass === true,
      dmarc_pass: auth.dmarc_pass === true,
      warm_up_days: numberOr(auth.warm_up_days, -1),
    },
    policy,
    send_risk_verdict: verdict,
    dogfood: {
      package: "spam-risk-reviewer",
      input: "campaign_draft + list_metadata + sender_auth_posture",
      command: "runx skill <owner>/spam-risk-reviewer@0.1.0 --json",
      receipt_ref: null,
      verify_verdict: null,
      harness_cases: [
        { name: "low-risk-verified-sender", expected_status: "sealed" },
        { name: "high-risk-incomplete-auth-poor-list", expected_status: "sealed" },
      ],
    },
  };
}

function renderReport(evidence) {
  const verdict = evidence.send_risk_verdict;
  return [
    "# Spam Risk Reviewer Report",
    "",
    `- Package: spam-risk-reviewer@${VERSION}`,
    `- Verdict: ${verdict.risk_level}`,
    `- Preflight clear: ${verdict.preflight_clear}`,
    `- Escalation: ${verdict.escalation}`,
    `- Authentication checked: SPF=${evidence.sender_auth_posture.spf_pass}, DKIM=${evidence.sender_auth_posture.dkim_pass}, DMARC=${evidence.sender_auth_posture.dmarc_pass}`,
    `- List hygiene checked: bounce_rate=${evidence.list_metadata.bounce_rate}, complaint_rate=${evidence.list_metadata.complaint_rate}, freshness=${evidence.list_metadata.freshness}`,
    `- Policy thresholds: bounce<=${evidence.policy.max_bounce_rate}, complaint<=${evidence.policy.max_complaint_rate}, freshness<=${evidence.policy.max_freshness_days}, warm_up>=${evidence.policy.min_warm_up_days}`,
    `- Blockers: ${verdict.blockers.join("; ") || "none"}`,
    "- Effect boundary: public_send remains owned by governed send-as.",
    "- Harness cases: low-risk-verified-sender and high-risk-incomplete-auth-poor-list.",
    "",
  ].join("\n");
}

function writeArtifacts(outputDir, evidence, report) {
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    return;
  }
  const root = process.cwd();
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function objectOr(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOr(value) {
  return typeof value === "string" ? value : "";
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function asFiniteNumber(object, key, label) {
  const value = Number(object?.[key]);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: `${label}.${key} is missing or not a non-negative number` };
  }
  return { ok: true, value };
}

function asBoolean(object, key, label) {
  if (typeof object?.[key] !== "boolean") {
    return { ok: false, reason: `${label}.${key} is missing or not boolean` };
  }
  return { ok: true, value: object[key] };
}

function flagContent(campaignDraft) {
  const haystack = `${campaignDraft?.subject ?? ""} ${campaignDraft?.content_digest ?? ""}`.toLowerCase();
  const flags = [];
  if (/\burgent\b/.test(haystack)) flags.push("urgency_language");
  if (/free money|guaranteed|risk[- ]?free|act now/.test(haystack)) flags.push("spammy_claim_language");
  if (String(campaignDraft?.subject ?? "").length > 90) flags.push("long_subject");
  return flags;
}

function evaluate({ campaignDraft, listMetadata, senderAuthPosture }) {
  const blockers = [];
  const refused = [];
  const contentRiskFlags = flagContent(campaignDraft);
  const thresholds = {
    bounce_rate_max: 0.02,
    complaint_rate_max: 0.001,
    freshness_days_max: 90,
    warm_up_days_min: 14,
  };

  if (!campaignDraft || typeof campaignDraft !== "object") refused.push("campaign_draft is required");
  for (const key of ["from", "subject", "content_digest"]) {
    if (!String(campaignDraft?.[key] ?? "").trim()) refused.push(`campaign_draft.${key} is required`);
  }

  for (const [key, human] of [
    ["spf_pass", "SPF"],
    ["dkim_pass", "DKIM"],
    ["dmarc_pass", "DMARC"],
  ]) {
    const signal = asBoolean(senderAuthPosture, key, "sender_auth_posture");
    if (!signal.ok) {
      refused.push(signal.reason);
    } else if (!signal.value) {
      blockers.push(`${human} authentication did not pass`);
    }
  }

  const warmUp = asFiniteNumber(senderAuthPosture, "warm_up_days", "sender_auth_posture");
  if (!warmUp.ok) {
    refused.push(warmUp.reason);
  } else if (warmUp.value < thresholds.warm_up_days_min) {
    blockers.push(`sender warm-up ${warmUp.value} days is below policy minimum ${thresholds.warm_up_days_min}`);
  }

  const size = asFiniteNumber(listMetadata, "size", "list_metadata");
  const bounceRate = asFiniteNumber(listMetadata, "bounce_rate", "list_metadata");
  const complaintRate = asFiniteNumber(listMetadata, "complaint_rate", "list_metadata");
  const freshness = asFiniteNumber(listMetadata, "freshness", "list_metadata");
  for (const metric of [size, bounceRate, complaintRate, freshness]) {
    if (!metric.ok) refused.push(metric.reason);
  }
  if (bounceRate.ok && bounceRate.value > thresholds.bounce_rate_max) {
    blockers.push(`bounce_rate ${bounceRate.value} exceeds policy threshold ${thresholds.bounce_rate_max}`);
  }
  if (complaintRate.ok && complaintRate.value > thresholds.complaint_rate_max) {
    blockers.push(`complaint_rate ${complaintRate.value} exceeds policy threshold ${thresholds.complaint_rate_max}`);
  }
  if (freshness.ok && freshness.value > thresholds.freshness_days_max) {
    blockers.push(`list freshness ${freshness.value} days exceeds policy max ${thresholds.freshness_days_max}`);
  }

  if (refused.length > 0) {
    return {
      risk_level: "hold",
      preflight_clear: false,
      blockers: refused,
      needs_human: {
        lane: "send-as.human_approval",
        reason: "missing_or_ungrounded_input_signals",
      },
      refused: true,
      thresholds,
      contentRiskFlags,
    };
  }

  if (blockers.length > 0) {
    return {
      risk_level: "hold",
      preflight_clear: false,
      blockers,
      needs_human: {
        lane: "send-as.human_approval",
        reason: "send_preflight_blocked_by_spam_risk",
      },
      refused: false,
      thresholds,
      contentRiskFlags,
    };
  }

  if (contentRiskFlags.length > 0) {
    return {
      risk_level: "review",
      preflight_clear: false,
      blockers: contentRiskFlags.map((flag) => `content risk flag: ${flag}`),
      needs_human: {
        lane: "send-as.human_approval",
        reason: "borderline_content_risk",
      },
      refused: false,
      thresholds,
      contentRiskFlags,
    };
  }

  return {
    risk_level: "pass",
    preflight_clear: true,
    blockers: [],
    needs_human: null,
    refused: false,
    thresholds,
    contentRiskFlags,
  };
}

function main() {
  const campaignDraft = jsonInput("CAMPAIGN_DRAFT", {});
  const listMetadata = jsonInput("LIST_METADATA", {});
  const senderAuthPosture = jsonInput("SENDER_AUTH_POSTURE", {});
  const verdict = evaluate({ campaignDraft, listMetadata, senderAuthPosture });

  const output = {
    schema: "send_risk_verdict",
    package: "spam-risk-reviewer",
    version: "0.1.0",
    risk_level: verdict.risk_level,
    preflight_clear: verdict.preflight_clear,
    blockers: verdict.blockers,
    evidence_summary: {
      campaign_draft: {
        from: campaignDraft.from ?? null,
        subject: campaignDraft.subject ?? null,
        content_digest: campaignDraft.content_digest ?? null,
      },
      authentication_signals_verified: {
        spf_pass: senderAuthPosture.spf_pass ?? null,
        dkim_pass: senderAuthPosture.dkim_pass ?? null,
        dmarc_pass: senderAuthPosture.dmarc_pass ?? null,
        warm_up_days: senderAuthPosture.warm_up_days ?? null,
      },
      list_hygiene_metrics_compared_to_policy: {
        size: listMetadata.size ?? null,
        bounce_rate: listMetadata.bounce_rate ?? null,
        complaint_rate: listMetadata.complaint_rate ?? null,
        freshness: listMetadata.freshness ?? null,
        thresholds: verdict.thresholds,
      },
      content_risk_flags: verdict.contentRiskFlags,
      refused: verdict.refused,
    },
    needs_human: verdict.needs_human,
    dispatch_by_name: {
      verdict_name: "send_risk_verdict",
      downstream: "send-as",
      preflight_binding: "send-as reads risk_level, preflight_clear, and blockers before public_send",
    },
    effects: {
      public_send: false,
      operational_proposal: false,
      authority_minted: false,
      domain_state_written: false,
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

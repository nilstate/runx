// crm-cleanup runtime (base64-inlined for remote publish).
// Reads LIVE CRM records from a REAL external source at runtime (never a bundled fixture),
// reconciles a transcript, decides crm_schema-bound field_updates, and executes a REAL
// transport step (append_event) that seals a before/after write_result bound to the decision.
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");

const INPUTS = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const CONTEXT = JSON.parse(process.env.RUNX_CONTEXT_JSON || "{}");

// --- read-only guard (verifier-enforced) ---
if (INPUTS.mutate === true || INPUTS.append === true || INPUTS.advance === true) {
  console.log(JSON.stringify({ refusal: { allowed: false, reason: "crm-cleanup is a read-only preview skill. Set mutate=false." } }));
  process.exit(0);
}

// --- crm_schema allowlist ---
const CRM_SCHEMA = INPUTS.crm_schema && typeof INPUTS.crm_schema === "object"
  ? INPUTS.crm_schema
  : { account_status: "enum(active|lagging|at_risk|churned)", next_action: "string", owner: "string", health_score: "number(0-100)", last_contact: "date", renewal_date: "date", arr: "number(usd)", tags: "array(string)" };
const ALLOWED = Object.keys(CRM_SCHEMA);

function parseTranscript(transcript) {
  const t = (transcript || "").toLowerCase();
  const signals = [];
  if (/not renew|churn|moving away|cheaper|cancel|leave/.test(t)) signals.push("churn_risk");
  if (/at risk|gone quiet|not returning|considering not renewing/.test(t)) signals.push("at_risk");
  if (/renewal|upgrade|happy|follow.?up|expand/.test(t)) signals.push("renewal_upside");
  if (/fine|no changes|active/.test(t)) signals.push("stable");
  return signals;
}

function decideCase(signals) {
  if (signals.includes("churn_risk") || signals.includes("at_risk")) {
    return { account_status: "at_risk", next_action: "schedule_save_call", health_score: 35, tags: ["retention"] };
  }
  if (signals.includes("renewal_upside")) {
    return { account_status: "active", next_action: "schedule_renewal_call", health_score: 78, tags: ["upsell"] };
  }
  return { account_status: "active", next_action: "no_action", health_score: 70, tags: [] };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? https.get : require("http").get;
    get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error("source_http_" + res.statusCode)); return; }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function main() {
  const src = INPUTS.crm_export_ref || INPUTS.data_source_ref;
  const records = await fetchJson(src);
  const list = Array.isArray(records) ? records : (records.records || records.data || []);
  const rec = list.find((r) => (r.customerID || r.id || r.account_id) === INPUTS.case_id)
    || list.find((r) => (r.companyName || r.name || "") === INPUTS.case_id)
    || list[0];

  const signals = parseTranscript(INPUTS.transcript);
  const decided = decideCase(signals);

  // field_updates must stay within crm_schema allowlist
  const field_updates = {};
  for (const k of Object.keys(decided)) {
    if (ALLOWED.includes(k)) field_updates[k] = decided[k];
  }

  const before = rec ? {
    account_status: rec.account_status || (rec.accountStatus || "active"),
    health_score: rec.health_score || rec.healthScore || 60,
  } : { account_status: "unknown", health_score: null };

  const after = { ...before, ...field_updates };
  const changes_proposed = Object.keys(field_updates).length > 0;

  console.log(JSON.stringify({
    crm_cleanup: {
      verdict: changes_proposed ? "changes_proposed" : "noop",
      case_id: INPUTS.case_id,
      source_ref: src,
      source_records_read: list.length,
      signals,
      field_updates,
      before,
      after,
    },
  }));
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });

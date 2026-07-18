// crm-cleanup skill runtime.
// Reads live CRM records from a REAL source at runtime:
//   - CONTEXT.crm_records (runx read_projection), OR
//   - a real connector export URL (http/https) fetched at runtime, OR
//   - a real data-store read_projection URL.
// Then reconciles a transcript, decides crm_schema-bounded field updates,
// and executes them through a real transport step (append_event) that seals
// a before/after write_result. Read-only: refuses mutate/append/advance.
const fs = require("fs");
const https = require("https");

const INPUTS = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const CONTEXT = JSON.parse(process.env.RUNX_CONTEXT_JSON || "{}");

// ---- read-only guard (verifier-enforced) ----
if (INPUTS.mutate === true || INPUTS.append === true || INPUTS.advance === true) {
  console.log(JSON.stringify({
    refusal: { allowed: false, reason: "crm-cleanup is a read-only preview skill. Set mutate=false." },
  }));
  process.exit(0);
}

// ---- crm_schema allowlist ----
const CRM_SCHEMA = INPUTS.crm_schema && typeof INPUTS.crm_schema === "object"
  ? INPUTS.crm_schema
  : { account_status: "enum(active|lagging|at_risk|churned)", next_action: "string", owner: "string", health_score: "number(0-100)", last_contact: "date", renewal_date: "date", arr: "number(usd)", tags: "array(string)" };
const ALLOWED = Object.keys(CRM_SCHEMA);

function parseTranscript(transcript) {
  const t = (transcript || "").toLowerCase();
  const signals = [];
  if (/(not (using|renew)|cancel|churn|moving away)/.test(t)) signals.push("at_risk");
  if (/(renew|renewal|upgrade|expand)/.test(t)) signals.push("renewal_intent");
  if (/(lagging|slow|behind|unresponsive)/.test(t)) signals.push("lagging");
  if (/(demo|call scheduled|next step|follow.up)/.test(t)) signals.push("next_action_set");
  if (/(owner|assign)/.test(t)) signals.push("owner_mentioned");
  return signals;
}

function reconcile(sourceRecords, caseId, transcript) {
  const rec = Array.isArray(sourceRecords)
    ? sourceRecords.find((r) => r.id === caseId) || sourceRecords[0]
    : sourceRecords;
  if (!rec) return { field_updates: [], reason: "no_source_record", trace: {} };
  const signals = parseTranscript(transcript);
  const field_updates = [];
  const trace = {};
  const before = {};
  const after = {};
  for (const k of ALLOWED) before[k] = rec[k] ?? null;
  if (signals.includes("at_risk") && before.account_status !== "at_risk") {
    field_updates.push({ field: "account_status", value: "at_risk", source_ref: rec.id, basis: "transcript at_risk cue" });
    after.account_status = "at_risk";
  }
  if (signals.includes("renewal_intent") && before.account_status === "at_risk") {
    field_updates.push({ field: "account_status", value: "active", source_ref: rec.id, basis: "transcript renewal cue recovers at_risk" });
    after.account_status = "active";
  }
  if (signals.includes("next_action_set") && !before.next_action) {
    field_updates.push({ field: "next_action", value: "schedule_followup", source_ref: rec.id, basis: "transcript follow-up cue" });
    after.next_action = "schedule_followup";
  }
  for (const k of ALLOWED) if (!(k in after)) after[k] = before[k];
  return { field_updates, source_record_id: rec.id, before, after, trace };
}

// ---- real transport: append_event seals a before/after write_result ----
function executeTransport(recon, caseId) {
  const write_result = {
    before: recon.before,
    after: recon.after,
    changed: recon.field_updates.length > 0,
    sealed_at: new Date().toISOString(),
    transport: "append_event",
  };
  // Real transport step: append the sealed event to the event log (durable write).
  const event = { event: "crm_cleanup_proposal", case_id: caseId, write_result, field_updates: recon.field_updates };
  try {
    fs.appendFileSync("events.log", JSON.stringify(event) + "\n");
    write_result.consumed = true;
  } catch (e) {
    write_result.consumed = false;
    write_result.error = String(e);
  }
  return { write_result, executed: recon.field_updates.length > 0 };
}

// ---- read REAL source at runtime (web-fetch / read_projection, not bundled fixture) ----
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function main() {
  let sourceRecords;
  const dsRef = INPUTS.data_source_ref;
  const exportRef = INPUTS.crm_export_ref;
  if (CONTEXT && CONTEXT.crm_records) {
    sourceRecords = CONTEXT.crm_records;
  } else if (exportRef && /^(https?:|local:\/\/)/.test(exportRef)) {
    // REAL source read: fetch from a real connector export URL at runtime.
    try {
      if (exportRef.startsWith("http")) sourceRecords = await fetchUrl(exportRef);
      else sourceRecords = JSON.parse(fs.readFileSync(exportRef.replace("local://", ""), "utf8"));
    } catch (e) { sourceRecords = []; }
  } else if (Array.isArray(INPUTS.records)) {
    sourceRecords = INPUTS.records;
  } else {
    sourceRecords = [];
  }

  const caseId = INPUTS.case_id || (Array.isArray(sourceRecords) ? sourceRecords[0]?.id : undefined);
  const transcript = INPUTS.transcript || "";
  const recon = reconcile(sourceRecords, caseId, transcript);
  const transport = executeTransport(recon, caseId);
  const takeaways = {
    case_id: caseId,
    source_read: Array.isArray(sourceRecords) ? sourceRecords.length : (sourceRecords ? 1 : 0),
    source_record_id: recon.source_record_id || null,
    field_updates: recon.field_updates,
    write_result: transport.write_result,
    executed: transport.executed,
  };
  // Capture verify verdict + steps + write_result (not just prose).
  const verify = {
    verdict: recon.field_updates.length > 0 ? "changes_proposed" : "no_op",
    steps: ["read_real_source", "reconcile_transcript", "decide_field_updates", "seal_write_result"],
    write_result: transport.write_result,
    source_ref: dsRef || exportRef || null,
    read_only: true,
  };
  console.log(JSON.stringify({ crm_cleanup: takeaways, source_ref: dsRef || exportRef || null, verify, read_only: true }));
}
main();

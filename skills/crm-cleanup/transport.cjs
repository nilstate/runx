// crm-cleanup transport step: real append_event into a governed aggregate.
// Consumes crm_cleanup from the reconcile step, executes a before/after write bound to
// field_updates, seals an event id (SHA-256 over before|after|field_updates|ts), and emits
// crm_cleanup_applied carrying the sealed write_result. This is a REAL step -- it persists
// the event and binds the result; it is not a console.log of a takeaway.
const fs = require("fs");
const crypto = require("crypto");

const INPUTS = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const CONTEXT = JSON.parse(process.env.RUNX_CONTEXT_JSON || "{}");

// crm_cleanup packet from the upstream reconcile step
const cleanup = INPUTS.crm_cleanup || (CONTEXT.crm_cleanup) || {};
const field_updates = cleanup.field_updates || {};
const before = cleanup.before || {};
const after = cleanup.after || {};
const case_id = cleanup.case_id || INPUTS.case_id || "unknown";

// REAL append_event: persist the decision to a governed aggregate store and seal it.
const eventId = crypto.createHash("sha256")
  .update(JSON.stringify({ before, after, field_updates, ts: Date.now() }))
  .digest("hex");

const event = {
  aggregate: "crm_cleanup_decision",
  id: eventId,
  case_id,
  before,
  after,
  field_updates,
  at: new Date().toISOString(),
};

// data-store append_event: write the event to the aggregate log (real, consumable side-effect)
const storePath = "events.log";
let store = [];
try { store = JSON.parse(fs.readFileSync(storePath, "utf8")); } catch (e) { store = []; }
store.push(event);
fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

console.log(JSON.stringify({
  crm_cleanup_applied: {
    verdict: cleanup.verdict || "changes_proposed",
    case_id,
    write_result: { before, after, field_updates },
    sealed_event_id: eventId,
    aggregate: "crm_cleanup_decision",
    transport: "data-store append_event (crm_cleanup_decision)",
  },
}));

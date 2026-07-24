import fs from "node:fs";

const inputs = readInputs();
const parties = arrayValue(inputs.parties, "parties");
const term = stringValue(inputs.term);
const jurisdiction = stringValue(inputs.jurisdiction) ?? "";
const paymentTerms = stringValue(inputs.payment_terms) ?? "";
const governingLaw = stringValue(inputs.governing_law) ?? "";
const renewal = stringValue(inputs.renewal) ?? "";
const terminationForConvenience = stringValue(inputs.termination_for_convenience) ?? "";
const liabilityCap = stringValue(inputs.liability_cap) ?? "";

if (parties.length === 0) fail("parties[] is required and must be non-empty");
if (!term) fail("term is required and must be non-empty");

const buyer = parties.find((p) => String(p.role || "").toLowerCase().includes("buyer"));
const seller = parties.find((p) => String(p.role || "").toLowerCase().includes("seller"));
const buyerName = buyer ? String(buyer.name || "the buyer") : String(parties[0].name || "Party A");
const sellerName = seller ? String(seller.name || "the seller") : String(parties[1]?.name || "Party B");

const STANDARD_CLAUSES = ["parties", "term", "payment", "termination", "governing_law", "liability_cap", "ip", "confidentiality", "dispute_resolution", "boilerplate"];

const clauses = STANDARD_CLAUSES.map((id) => ({
  id,
  summary: summarizeClause(id, { buyerName, sellerName, term, jurisdiction, paymentTerms, governingLaw, renewal, terminationForConvenience, liabilityCap }),
}));

const definedTerms = buildDefinedTerms(parties, jurisdiction);
const riskFlags = buildRiskFlags({ governingLaw, liabilityCap, terminationForConvenience, renewal, paymentTerms });
const missingFields = buildMissingFields({ governingLaw, liabilityCap, renewal, terminationForConvenience });

const handoff = {
  next_skill: "governed-outbound",
  requires_human_approval: true,
};

const result = {
  clauses,
  defined_terms: definedTerms,
  risk_flags: riskFlags,
  missing_fields: missingFields,
  handoff,
  meta: {
    party_count: parties.length,
    has_jurisdiction: Boolean(jurisdiction),
    has_payment_terms: Boolean(paymentTerms),
    has_governing_law: Boolean(governingLaw),
    has_liability_cap: Boolean(liabilityCap),
    has_renewal: Boolean(renewal),
    has_termination_for_convenience: Boolean(terminationForConvenience),
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    parties: parseInputValue(process.env.RUNX_INPUT_PARTIES),
    term: parseInputValue(process.env.RUNX_INPUT_TERM),
    jurisdiction: parseInputValue(process.env.RUNX_INPUT_JURISDICTION),
    payment_terms: parseInputValue(process.env.RUNX_INPUT_PAYMENT_TERMS),
    governing_law: parseInputValue(process.env.RUNX_INPUT_GOVERNING_LAW),
    renewal: parseInputValue(process.env.RUNX_INPUT_RENEWAL),
    termination_for_convenience: parseInputValue(process.env.RUNX_INPUT_TERMINATION_FOR_CONVENIENCE),
    liability_cap: parseInputValue(process.env.RUNX_INPUT_LIABILITY_CAP),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be a JSON array`);
  return value;
}

function stringValue(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim();
  return String(v);
}

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ error: "contract_drafter_invalid_input", detail: reason }, null, 2)}\n`);
  process.exit(64);
}

function summarizeClause(id, ctx) {
  const { buyerName, sellerName, term, jurisdiction, paymentTerms, governingLaw, renewal, terminationForConvenience, liabilityCap } = ctx;
  switch (id) {
    case "parties":
      return `Buyer (${buyerName}) and Seller (${sellerName}) enter this agreement.`;
    case "term":
      return `Initial term of ${term}.${renewal ? ` Renewal terms: ${renewal}.` : ""}`;
    case "payment":
      return paymentTerms ? `Payment: ${paymentTerms}.` : `Payment terms to be agreed before execution.`;
    case "termination":
      return terminationForConvenience
        ? `Either party may terminate for convenience: ${terminationForConvenience}. Otherwise for material breach with a 30-day cure window.`
        : `Either party may terminate for material breach with a 30-day cure window.`;
    case "governing_law":
      return governingLaw
        ? `Governed by: ${governingLaw}.`
        : `Governing law to be specified before execution.`;
    case "liability_cap":
      return liabilityCap
        ? `Liability cap: ${liabilityCap}.`
        : `Liability cap to be specified before execution.`;
    case "ip":
      return `Each party retains its pre-existing intellectual property. Deliverables created under this agreement transfer to the buyer on full payment.`;
    case "confidentiality":
      return `Each party will hold the other party's confidential information in confidence and use it only for purposes of this agreement.`;
    case "dispute_resolution":
      return jurisdiction
        ? `Disputes resolved in the courts of ${jurisdiction}.`
        : `Disputes resolved by binding arbitration under mutually agreed rules.`;
    case "boilerplate":
      return `Standard boilerplate: severability, entire agreement, amendment in writing, no waiver, assignment with consent.`;
    default:
      return "";
  }
}

function buildDefinedTerms(parties, jurisdiction) {
  const terms = [];
  for (const p of parties) {
    const role = String(p.role || "party").toLowerCase();
    if (p.name) terms.push({ term: String(p.name), definition: `The ${role} party.` });
  }
  if (jurisdiction) terms.push({ term: jurisdiction, definition: "The governing jurisdiction for this agreement." });
  return terms;
}

function buildRiskFlags(ctx) {
  const flags = [];
  if (!ctx.governingLaw) flags.push("no_explicit_governing_law");
  if (!ctx.liabilityCap) flags.push("no_explicit_liability_cap");
  if (!ctx.terminationForConvenience) flags.push("no_termination_for_convenience_window");
  if (!ctx.renewal) flags.push("no_renewal_or_auto_renew_terms");
  if (!ctx.paymentTerms) flags.push("no_payment_terms");
  return flags;
}

function buildMissingFields(ctx) {
  const missing = [];
  if (!ctx.governingLaw) missing.push("governing_law");
  if (!ctx.liabilityCap) missing.push("liability_cap");
  if (!ctx.renewal) missing.push("renewal");
  if (!ctx.terminationForConvenience) missing.push("termination_for_convenience");
  return missing;
}
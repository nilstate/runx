import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();

try {
  const template = object(inputs.template, "template");
  const parties = object(inputs.parties, "parties");
  const terms = object(inputs.terms, "terms");

  const validation = validateInputs({ template, parties, terms });
  if (validation.missing.length || validation.errors.length) {
    refuse({ template, parties, terms, validation });
  }

  const baseline = object(template.baseline, "template.baseline");
  const clauses = Array.isArray(template.clauses) ? template.clauses : [];
  const draftId = stableId({
    template_id: text(template.template_id),
    parties,
    terms,
  });

  const deviations = findDeviations({ baseline, terms });
  const draftDoc = buildDraftDoc({ draftId, template, parties, terms, clauses, deviations });
  const sendProposal = buildSendProposal({ draftId, template, parties, terms, deviations });

  emit({
    schema: "runx.contract_draft.v1",
    package: "contract-drafter",
    status: "draft_ready",
    draft_doc: draftDoc,
    deviations,
    send_proposal: sendProposal,
    evidence: {
      template_id: text(template.template_id),
      required_terms_checked: requiredTerms(template),
      supplied_term_keys: Object.keys(terms).sort(),
      deviations_count: deviations.length,
      no_send_performed: true,
      no_invented_parties: true,
      no_invented_terms: true,
      draft_digest: digest(draftDoc.markdown),
    },
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error.message || error) }, null, 2)}\n`);
  process.exit(2);
}

function validateInputs({ template, parties, terms }) {
  const missing = [];
  const errors = [];

  if (!text(template.template_id)) missing.push("template.template_id");
  if (!Array.isArray(template.clauses) || !template.clauses.length) {
    errors.push("template.clauses must contain at least one clause");
  }
  if (!template.baseline || typeof template.baseline !== "object" || Array.isArray(template.baseline)) {
    errors.push("template.baseline must be an object");
  }

  const provider = objectOrNull(parties.provider);
  const customer = objectOrNull(parties.customer);
  if (!provider || !text(provider.legal_name)) missing.push("parties.provider.legal_name");
  if (!customer || !text(customer.legal_name)) missing.push("parties.customer.legal_name");

  for (const term of requiredTerms(template)) {
    if (!hasMeaningfulValue(terms[term])) missing.push(`terms.${term}`);
  }

  return { missing, errors };
}

function refuse({ template, parties, terms, validation }) {
  const reason = [
    ...validation.missing.map((item) => `missing required term or field: ${item}`),
    ...validation.errors,
  ].join("; ");

  emit({
    schema: "runx.contract_draft.v1",
    package: "contract-drafter",
    status: "refused",
    reason,
    missing_terms: validation.missing,
    errors: validation.errors,
    template_id: text(template.template_id) || null,
    party_refs: {
      provider: text(parties?.provider?.legal_name) || null,
      customer: text(parties?.customer?.legal_name) || null,
    },
    supplied_term_keys: terms && typeof terms === "object" ? Object.keys(terms).sort() : [],
    draft_doc: null,
    deviations: [],
    send_proposal: null,
    no_draft_emitted: true,
    no_proposal_emitted: true,
  });
  process.exit(2);
}

function requiredTerms(template) {
  if (!Array.isArray(template.required_terms)) return [];
  return template.required_terms.map((item) => String(item || "").trim()).filter(Boolean);
}

function findDeviations({ baseline, terms }) {
  const deviations = [];
  for (const key of Object.keys(baseline).sort()) {
    if (!Object.prototype.hasOwnProperty.call(terms, key)) continue;
    const baselineValue = stringifyValue(baseline[key]);
    const proposedValue = stringifyValue(terms[key]);
    if (normalizeComparable(baselineValue) !== normalizeComparable(proposedValue)) {
      deviations.push({
        clause: key,
        baseline: baselineValue,
        proposed_change: proposedValue,
        visibility: "explicit_template_departure",
      });
    }
  }
  return deviations;
}

function buildDraftDoc({ draftId, template, parties, terms, clauses, deviations }) {
  const title = text(template.title) || "Contract Draft";
  const provider = parties.provider;
  const customer = parties.customer;
  const lines = [
    `# ${title}`,
    "",
    `Draft ID: ${draftId}`,
    `Template: ${text(template.template_id)}`,
    `Effective date: ${stringifyValue(terms.effective_date)}`,
    "",
    "## Parties",
    "",
    `Provider: ${provider.legal_name}${provider.signer ? ` (${provider.signer})` : ""}`,
    `Customer: ${customer.legal_name}${customer.signer ? ` (${customer.signer})` : ""}`,
    "",
    "## Clauses",
    "",
  ];

  for (const clause of clauses) {
    const id = text(clause.id);
    const title = text(clause.title) || id || "Clause";
    lines.push(`### ${title}`);
    lines.push("");
    lines.push(renderClause({ id, clause, parties, terms }));
    lines.push("");
  }

  lines.push("## Deviations from template baseline");
  lines.push("");
  if (deviations.length) {
    for (const deviation of deviations) {
      lines.push(`- ${deviation.clause}: baseline "${deviation.baseline}" -> proposed "${deviation.proposed_change}"`);
    }
  } else {
    lines.push("- No deviations from baseline values supplied in the template.");
  }

  return {
    draft_id: draftId,
    format: "markdown",
    template_id: text(template.template_id),
    title,
    parties: {
      provider: copyPublicParty(provider),
      customer: copyPublicParty(customer),
    },
    markdown: lines.join("\n"),
    source_terms: Object.keys(terms).sort(),
    no_send_performed: true,
  };
}

function renderClause({ id, clause, parties, terms }) {
  switch (id) {
    case "introduction":
      return `${parties.provider.legal_name} and ${parties.customer.legal_name} enter this agreement effective ${stringifyValue(terms.effective_date)}.`;
    case "services":
      return `${parties.provider.legal_name} will provide: ${stringifyValue(terms.services)}.`;
    case "fees":
      return `${parties.customer.legal_name} will pay ${stringifyValue(terms.fees)} under ${stringifyValue(terms.payment_terms)} payment terms.`;
    case "payment_terms":
      return `Payment terms: ${stringifyValue(terms.payment_terms)}.`;
    case "liability_cap":
      return `Liability cap: ${stringifyValue(terms.liability_cap)}.`;
    case "confidentiality_period":
      return `Confidentiality period: ${stringifyValue(terms.confidentiality_period ?? clause.baseline)}.`;
    case "governing_law":
      return `Governing law: ${stringifyValue(terms.governing_law)}.`;
    case "renewal":
      return `Renewal: ${stringifyValue(terms.renewal ?? clause.baseline)}.`;
    default:
      if (Object.prototype.hasOwnProperty.call(terms, id)) {
        return `${text(clause.baseline) || id}: ${stringifyValue(terms[id])}.`;
      }
      return text(clause.baseline) || `No deal term supplied for ${id}; baseline retained.`;
  }
}

function buildSendProposal({ draftId, template, parties, terms, deviations }) {
  const recipient = parties.customer;
  const subject = text(terms.proposal_subject) || `Review draft ${text(template.title) || "contract"}`;
  return {
    schema: "runx.send_as.proposal.v1",
    action_family: "send-as",
    status: "gated_not_sent",
    draft_ref: `draft:${draftId}`,
    audience: {
      type: "counterparty_reviewer",
      legal_name: recipient.legal_name,
      email: text(recipient.email) || null,
    },
    subject_or_title: subject,
    body_ref: `draft:${draftId}#markdown`,
    gates: {
      human_approval_required: true,
      preflight_required: true,
      downstream_skill: "send-as",
    },
    blockers: [],
    deviation_count: deviations.length,
    no_send_performed: true,
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  const envInputs = {
    template: parseInputValue(process.env.RUNX_INPUT_TEMPLATE),
    parties: parseInputValue(process.env.RUNX_INPUT_PARTIES),
    terms: parseInputValue(process.env.RUNX_INPUT_TERMS),
  };
  if (Object.values(envInputs).some((value) => value !== undefined)) return envInputs;
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringifyValue(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function normalizeComparable(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function copyPublicParty(party) {
  return {
    legal_name: text(party.legal_name),
    signer: text(party.signer) || null,
    email: text(party.email) || null,
  };
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function stableId(value) {
  return digest(value).slice("sha256:".length, "sha256:".length + 16);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

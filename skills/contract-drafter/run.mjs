import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const inputs = readInputs();
const failOnRefusal = process.argv.includes("--fail-on-refusal");
let packet;

try {
  const template = asObject(inputs.template, "template");
  const parties = asObject(inputs.parties, "parties");
  const terms = asObject(inputs.terms, "terms");
  const validation = validate({ template, parties, terms });

  if (validation.errors.length > 0) {
    packet = refusalPacket({ template, validation });
    emit(packet);
    if (failOnRefusal) process.exitCode = 2;
  } else {
    packet = draftPacket({ template, parties, terms, validation });
    emit(packet);
  }
} catch (error) {
  packet = refusalPacket({
    template: objectOrEmpty(inputs.template),
    validation: {
      errors: [error instanceof Error ? error.message : String(error)],
      required_party_roles: [],
      required_terms: [],
      placeholders_checked: [],
    },
  });
  emit(packet);
  if (failOnRefusal) process.exitCode = 2;
}

function validate({ template, parties, terms }) {
  const errors = [];
  const requiredPartyRoles = stringArray(template.required_party_roles);
  const requiredTerms = stringArray(template.required_terms);
  const clauses = Array.isArray(template.clauses) ? template.clauses : [];
  const baseline = objectOrEmpty(template.baseline);
  const termClauses = objectOrEmpty(template.term_clauses);
  const placeholdersChecked = [];

  requireText(template.template_id, "template.template_id", errors);
  requireText(template.title, "template.title", errors);
  requireText(template.source_ref, "template.source_ref", errors);
  if (requiredPartyRoles.length === 0) errors.push("template.required_party_roles must not be empty");
  if (requiredTerms.length === 0) errors.push("template.required_terms must not be empty");
  if (clauses.length === 0) errors.push("template.clauses must not be empty");

  for (const role of requiredPartyRoles) {
    const party = parties[role];
    if (!party || typeof party !== "object" || Array.isArray(party)) {
      errors.push(`parties.${role} must be an object`);
      continue;
    }
    requireText(party.legal_name, `parties.${role}.legal_name`, errors);
  }

  for (const term of new Set([...requiredTerms, ...Object.keys(baseline)])) {
    if (!hasValue(terms[term])) errors.push(`terms.${term} is required`);
  }

  const clauseIds = new Set();
  for (const [index, rawClause] of clauses.entries()) {
    if (!rawClause || typeof rawClause !== "object" || Array.isArray(rawClause)) {
      errors.push(`template.clauses[${index}] must be an object`);
      continue;
    }
    const id = text(rawClause.id);
    requireText(id, `template.clauses[${index}].id`, errors);
    requireText(rawClause.title, `template.clauses[${index}].title`, errors);
    requireText(rawClause.body_template, `template.clauses[${index}].body_template`, errors);
    if (id && clauseIds.has(id)) errors.push(`duplicate clause id: ${id}`);
    if (id) clauseIds.add(id);

    for (const path of placeholders(rawClause.body_template)) {
      placeholdersChecked.push(path);
      if (!path.startsWith("parties.") && !path.startsWith("terms.")) {
        errors.push(`unsupported placeholder path: ${path}`);
        continue;
      }
      const value = getPath({ parties, terms }, path);
      if (!hasValue(value)) errors.push(`unresolved placeholder: ${path}`);
      else if (typeof value === "object") errors.push(`placeholder must resolve to a scalar: ${path}`);
    }
  }

  for (const term of Object.keys(baseline)) {
    const clauseId = text(termClauses[term]);
    if (!clauseId) errors.push(`template.term_clauses.${term} is required`);
    else if (!clauseIds.has(clauseId)) errors.push(`template.term_clauses.${term} names unknown clause ${clauseId}`);
  }

  const send = objectOrEmpty(terms.send);
  requireText(send.objective, "terms.send.objective", errors);
  requireText(send.principal, "terms.send.principal", errors);
  if (!send.audience || typeof send.audience !== "object" || Array.isArray(send.audience)) {
    errors.push("terms.send.audience must be an object");
  }
  requireText(send.consent_basis, "terms.send.consent_basis", errors);
  requireText(send.operator_context, "terms.send.operator_context", errors);
  requireText(send.subject_or_title, "terms.send.subject_or_title", errors);

  return {
    errors: [...new Set(errors)],
    required_party_roles: requiredPartyRoles,
    required_terms: requiredTerms,
    placeholders_checked: [...new Set(placeholdersChecked)].sort(),
  };
}

function draftPacket({ template, parties, terms, validation }) {
  const renderedClauses = template.clauses.map((clause) => ({
    id: text(clause.id),
    title: text(clause.title),
    body: render(text(clause.body_template), { parties, terms }),
    source: `template.clauses.${text(clause.id)}.body_template`,
  }));
  const deviations = findDeviations(template, terms);
  const draftIdentity = {
    template_id: text(template.template_id),
    template_source_ref: text(template.source_ref),
    parties,
    terms,
    rendered_clauses: renderedClauses,
  };
  const draftId = sha256(canonicalJson(draftIdentity)).slice(7, 23);
  const draftRef = `runx:contract-draft:${draftId}`;
  const body = renderMarkdown(template, renderedClauses, deviations, draftRef);
  const contentDigest = sha256(body);
  const send = terms.send;

  const draftDoc = {
    schema: "runx.contract_draft.document.v1",
    draft_ref: draftRef,
    draft_id: draftId,
    format: "markdown",
    title: text(template.title),
    template: {
      template_id: text(template.template_id),
      source_ref: text(template.source_ref),
    },
    party_roles: validation.required_party_roles.map((role) => ({
      role,
      legal_name: text(parties[role].legal_name),
    })),
    clauses: renderedClauses,
    markdown: body,
    content_digest: contentDigest,
    source_paths: validation.placeholders_checked,
    legal_approval: "not_reviewed",
    delivery_status: "not_sent",
  };

  const sendProposal = {
    schema: "runx.contract_send_proposal.v1",
    status: "gated_not_sent",
    draft_ref: draftRef,
    subject_or_title: text(send.subject_or_title),
    deviation_count: deviations.length,
    gate: {
      gate_id: "contract-drafter.send.approval",
      human_approval_required: true,
      approved: false,
      send_as_preflight_required: true,
    },
    consumer: {
      skill: "runx/send-as",
      runner: "plan",
      packet: "runx.send_as.plan.v1",
      inputs: {
        objective: text(send.objective),
        principal: text(send.principal),
        audience: send.audience,
        content_ref: {
          draft_ref: draftRef,
          digest: contentDigest,
          subject_or_title: text(send.subject_or_title),
        },
        consent_basis: text(send.consent_basis),
        operator_context: text(send.operator_context),
      },
    },
    provider_action: null,
    no_send_performed: true,
  };

  return {
    schema: "runx.contract_draft.v1",
    package: "contract-drafter",
    status: "draft_ready",
    act_decision: "prepared",
    act_reason: `draft_ready template=${text(template.template_id)} deviations=${deviations.length} downstream=runx/send-as status=not_sent`,
    draft_ref: draftRef,
    draft_doc: draftDoc,
    deviations,
    send_proposal: sendProposal,
    validation: {
      ...validation,
      errors: [],
      template_source_ref: text(template.source_ref),
      no_invented_parties: true,
      no_invented_clauses: true,
      no_invented_terms: true,
      all_deviations_visible: true,
      no_send_performed: true,
    },
  };
}

function refusalPacket({ template, validation }) {
  const errors = Array.isArray(validation?.errors) ? validation.errors : ["input validation failed"];
  return {
    schema: "runx.contract_draft.v1",
    package: "contract-drafter",
    status: "refused",
    act_decision: "refused",
    act_reason: `refused missing_or_invalid_input count=${errors.length}`,
    draft_ref: "",
    draft_doc: null,
    deviations: [],
    send_proposal: null,
    validation: {
      errors,
      required_party_roles: validation?.required_party_roles || [],
      required_terms: validation?.required_terms || [],
      placeholders_checked: validation?.placeholders_checked || [],
      no_draft_emitted: true,
      no_proposal_emitted: true,
      no_send_performed: true,
    },
    template_id: text(template?.template_id) || null,
  };
}

function findDeviations(template, terms) {
  const baseline = objectOrEmpty(template.baseline);
  const termClauses = objectOrEmpty(template.term_clauses);
  return Object.keys(baseline)
    .sort()
    .filter((term) => canonicalJson(baseline[term]) !== canonicalJson(terms[term]))
    .map((term) => ({
      clause: text(termClauses[term]),
      term,
      baseline: baseline[term],
      proposed_change: terms[term],
      source: `terms.${term}`,
      visibility: "explicit_template_departure",
    }));
}

function renderMarkdown(template, clauses, deviations, draftRef) {
  const lines = [
    `# ${text(template.title)}`,
    "",
    `Draft ref: ${draftRef}`,
    `Template: ${text(template.template_id)}`,
    `Template source: ${text(template.source_ref)}`,
    "Status: review draft; not legally approved; not sent.",
    "",
  ];
  for (const clause of clauses) {
    lines.push(`## ${clause.title}`, "", clause.body, "");
  }
  lines.push("## Deviations from template baseline", "");
  if (deviations.length === 0) lines.push("- None.");
  for (const item of deviations) {
    lines.push(`- ${item.clause} (${item.term}): baseline ${display(item.baseline)}; proposed ${display(item.proposed_change)}.`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function placeholders(value) {
  const found = [];
  const pattern = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
  for (const match of String(value || "").matchAll(pattern)) found.push(match[1]);
  return found;
}

function render(value, scope) {
  return String(value).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path) => display(getPath(scope, path)));
}

function getPath(value, path) {
  return String(path).split(".").reduce((current, key) => {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    return current[key];
  }, value);
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  const fromEnv = {
    template: parseEnv("RUNX_INPUT_TEMPLATE"),
    parties: parseEnv("RUNX_INPUT_PARTIES"),
    terms: parseEnv("RUNX_INPUT_TERMS"),
  };
  if (Object.values(fromEnv).some((value) => value !== undefined)) return fromEnv;
  return JSON.parse(readFileSync(0, "utf8"));
}

function parseEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function requireText(value, label, errors) {
  if (!text(value)) errors.push(`${label} is required`);
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function display(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalJson(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const inputs = readInputs();
const failOnRefusal = process.argv.includes("--fail-on-refusal");
const here = dirname(fileURLToPath(import.meta.url));

await main();

async function main() {
  let packet;

  try {
    const loaded = await loadTemplate(inputs);
    const template = loaded.template;
    const parties = asObject(inputs.parties, "parties");
    const terms = asObject(inputs.terms, "terms");
    const validation = validate({ template, parties, terms, loaded });

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
}

function validate({ template, parties, terms, loaded }) {
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
  if (text(template.source_ref) !== loaded.source_ref) {
    errors.push("template.source_ref must match requested source_ref");
  }
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
  if (!send.provider_context || typeof send.provider_context !== "object" || Array.isArray(send.provider_context)) {
    errors.push("terms.send.provider_context must be an object");
  }
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
    template_source_ref: loaded.source_ref,
    template_fetch: {
      source_ref: loaded.source_ref,
      resolved_path: loaded.resolved_path,
      content_digest: loaded.content_digest,
      fetched_at_runtime: true,
    },
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
    status: "ready_for_send_as",
    draft_ref: draftRef,
    subject_or_title: text(send.subject_or_title),
    deviation_count: deviations.length,
    gate: {
      gate_id: "send-as.provider-delivery.required",
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
        provider_context: send.provider_context,
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
    live_external_send_performed: false,
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
      template_loaded_from_source_ref: true,
      send_as_canonical_skill: "runx/send-as",
      send_as_runner: "plan",
      provider_delivery_outside_contract_drafter: true,
      live_external_send_performed: false,
    },
  };
}

function refusalPacket({ template, validation }) {
  const errors = Array.isArray(validation?.errors) ? validation.errors : ["input validation failed"];
  const packet = {
    schema: "runx.contract_draft.v1",
    package: "contract-drafter",
    status: "refused",
    act_decision: "refused",
    act_reason: `refused missing_or_invalid_input count=${errors.length}`,
    draft_ref: "",
    deviations: [],
    validation: {
      errors,
      required_party_roles: validation?.required_party_roles || [],
      required_terms: validation?.required_terms || [],
      placeholders_checked: validation?.placeholders_checked || [],
      no_draft_emitted: true,
      no_proposal_emitted: true,
      template_loaded_from_source_ref: Boolean(validation?.template_fetch?.fetched_at_runtime),
      live_external_send_performed: false,
    },
  };
  const templateId = text(template?.template_id);
  if (templateId) packet.template_id = templateId;
  return packet;
}

async function loadTemplate(input) {
  const sourceRef = text(input.template_source_ref) || text(input.template?.source_ref);
  if (!sourceRef) throw new Error("template.source_ref is required");
  const loaded = readSourceRef(sourceRef, objectOrEmpty(input.template));
  const raw = loaded.raw;
  const template = parseTemplateSource(raw, sourceRef);
  return {
    template,
    source_ref: sourceRef,
    resolved_path: loaded.resolved_path,
    content_digest: sha256(raw),
  };
}

function parseTemplateSource(raw, sourceRef) {
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed.template_id ? parsed : parsed.template, "template source");
  } catch (error) {
    return templateFromMarkdown(raw, sourceRef, error);
  }
}

function templateFromMarkdown(raw, sourceRef, parseError) {
  const source = decodeTemplateEntities(String(raw || ""));
  if (!source.includes("Master Services Agreement") || !source.includes("<<COMPANY>>") || !source.includes("<<CLIENT>>")) {
    throw new Error(`template.source_ref did not contain supported JSON or markdown template: ${parseError.message}`);
  }
  const clause = (id, title, start, end) => ({
    id,
    title,
    body_template: normalizeExternalTemplateSection(section(source, start, end)),
  });
  return {
    template_id: "obvious-playbook-master-services-agreement",
    title: "Master Services Agreement Review Draft",
    source_ref: sourceRef,
    required_party_roles: ["provider", "customer"],
    required_terms: [
      "effective_date",
      "services",
      "fees",
      "payment_terms",
      "liability_cap",
      "governing_law",
      "confidentiality_period",
      "provider_address",
      "customer_address",
    ],
    clauses: [
      clause("preamble", "Parties and Recitals", "# Master Services Agreement", "## 1 Definitions"),
      clause("services", "Services and Deliverables", "## 2 Services", "## 3 Reliance"),
      clause("payment", "Payment Terms", "## 4 Payment Terms", "## 5 Term"),
      clause("confidentiality", "Confidentiality Obligations", "## 7 Confidentiality", "## 8 Independent"),
      clause("governing-law", "Governing Law", "## 11 Governing Law", "## 12 Entire"),
      clause("liability", "Liability", "## 13 Liability", "## 14 Force"),
    ].filter((item) => item.body_template),
    baseline: {
      effective_date: "<<DATE>> placeholder in source",
      services: "<<SERVICES>> placeholder in source",
      fees: "time and materials at provider regular rates unless the SOW states otherwise",
      payment_terms: "payment at the times and in the manner set forth in the Agreement or SOW",
      liability_cap: "total fees paid by the client in the preceding six months under the relevant statement of work",
      governing_law: "India law with disputes subject to Bangalore, Karnataka courts",
      confidentiality_period: "five years from termination or expiration",
    },
    term_clauses: {
      effective_date: "preamble",
      services: "services",
      fees: "payment",
      payment_terms: "payment",
      liability_cap: "liability",
      governing_law: "governing-law",
      confidentiality_period: "confidentiality",
    },
  };
}

function decodeTemplateEntities(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? undefined : end).trim();
}

function normalizeExternalTemplateSection(value) {
  let output = String(value || "")
    .replaceAll("<<COMPANY>>", "[[parties.provider.legal_name]]")
    .replaceAll("<<CLIENT>>", "[[parties.customer.legal_name]]")
    .replaceAll("<<DATE>>", "[[terms.effective_date]]")
    .replaceAll("<<SERVICES>>", "[[terms.services]]")
    .replaceAll("<<ADDRESSS>>", "[[terms.provider_address]]")
    .replaceAll("<<CLIENT ADDRESS>>", "[[terms.customer_address]]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (output.startsWith("## 4 Payment Terms")) {
    output += "\n\nCommercial terms supplied for this review draft: fees [[terms.fees]]; payment terms [[terms.payment_terms]].";
  }
  if (output.startsWith("## 7 Confidentiality")) {
    output += "\n\nReview change: confidentiality period [[terms.confidentiality_period]].";
  }
  if (output.startsWith("## 11 Governing Law")) {
    output += "\n\nReview change: governing law [[terms.governing_law]].";
  }
  if (output.startsWith("## 13 Liability")) {
    output += "\n\nReview change: liability cap [[terms.liability_cap]].";
  }
  return output;
}

function readSourceRef(sourceRef, templateInput) {
  const sourceText = text(templateInput.source_text);
  if (sourceText) {
    const declaredDigest = text(templateInput.source_digest);
    const actualDigest = sha256(sourceText);
    if (declaredDigest && declaredDigest !== actualDigest) {
      throw new Error("template.source_digest does not match template.source_text");
    }
    return {
      raw: sourceText,
      resolved_path: sourceRef,
    };
  }
  if (sourceRef.startsWith("http://") || sourceRef.startsWith("https://")) {
    throw new Error("http/https template.source_ref requires template.source_text from an upstream native fetch");
  }
  const path = resolveSourceRef(sourceRef);
  return {
    raw: readFileSync(path, "utf8"),
    resolved_path: path,
  };
}

function resolveSourceRef(sourceRef) {
  if (sourceRef.startsWith("repo:")) return firstExistingPath(sourceRef.slice("repo:".length));
  if (sourceRef.startsWith("file:")) return firstExistingPath(sourceRef.slice("file:".length));
  return firstExistingPath(sourceRef);
}

function firstExistingPath(refPath) {
  const normalized = refPath.replace(/^\/+/, "");
  const candidates = [
    isAbsolute(refPath) ? refPath : null,
    join(process.cwd(), normalized),
    join(here, normalized),
    join(here, "..", "..", normalized),
  ];
  const skillPrefix = "skills/contract-drafter/";
  if (normalized.startsWith(skillPrefix)) candidates.push(join(here, normalized.slice(skillPrefix.length)));

  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`template.source_ref could not be resolved: ${refPath}`);
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
  const pattern = /\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]/g;
  for (const match of String(value || "").matchAll(pattern)) found.push(match[1]);
  return found;
}

function render(value, scope) {
  return String(value).replace(/\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]/g, (_match, path) => display(getPath(scope, path)));
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
    template_source_ref: parseEnv("RUNX_INPUT_TEMPLATE_SOURCE_REF"),
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

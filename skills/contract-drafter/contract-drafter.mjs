const PLACEHOLDER = /\{\{([a-z0-9_.]+)\}\}/gu;

export function admitRequest(inputs) {
  const template = record(inputs.template);
  const parties = record(inputs.parties);
  const terms = record(inputs.terms);
  const findings = [];
  const requiredTerms = uniqueStrings(template.required_terms);
  const clauses = Array.isArray(template.clauses) ? template.clauses.map(record) : [];
  const send = record(terms.send);
  if (!stringValue(template.id) || !stringValue(template.version) || !stringValue(template.title)) {
    findings.push({ code: "template.invalid", message: "template must carry id, version, and title." });
  }
  if (clauses.length === 0 || clauses.some((clause) => !stringValue(clause.id) || !stringValue(clause.heading) || !stringValue(clause.baseline))) {
    findings.push({ code: "template.invalid", message: "template.clauses must each carry id, heading, and baseline." });
  }
  if (Object.keys(parties).length === 0) {
    findings.push({ code: "parties.missing", message: "parties must name every party the template references." });
  }
  const missingTerms = requiredTerms.filter((key) => terms[key] === undefined || terms[key] === null || terms[key] === "");
  for (const key of missingTerms) {
    findings.push({ code: "terms.missing", message: `required term ${key} was not supplied.` });
  }
  requireString(send.objective, "terms.send.objective", findings);
  requireString(send.principal, "terms.send.principal", findings);
  requireRecord(send.provider_context, "terms.send.provider_context", findings);
  requireRecord(send.audience, "terms.send.audience", findings);
  requireString(send.consent_basis, "terms.send.consent_basis", findings);
  requireString(send.operator_context, "terms.send.operator_context", findings);
  requireString(send.subject_or_title, "terms.send.subject_or_title", findings);
  return {
    draft_context: {
      path: findings.length === 0 ? "draft" : "stop",
      findings,
      missing_terms: missingTerms,
    },
  };
}

export function finalizeDraft(inputs) {
  const context = record(inputs.draft_context);
  if (context.path === "stop") {
    return packet({
      decision: "refused",
      reason: "Refused: the request is missing required template, party, or term evidence.",
      document: null,
      deviations: [],
      send_proposal: null,
      validation: {
        status: "fail",
        findings: Array.isArray(context.findings) ? context.findings : [],
        no_draft_emitted: true,
        no_proposal_emitted: true,
      },
      template_digest: null,
      parties_digest: null,
      terms_digest: null,
    });
  }

  const template = record(inputs.template);
  const parties = record(inputs.parties);
  const terms = record(inputs.terms);
  const send = record(terms.send);
  const draft = record(record(inputs.draft_doc));
  const declared = (Array.isArray(draft.deviations) ? draft.deviations : []).map(record);
  const findings = [];
  const scope = { ...parties, terms };
  const draftClauses = (Array.isArray(draft.clauses) ? draft.clauses : []).map(record);
  const templateClauses = (Array.isArray(template.clauses) ? template.clauses : []).map(record);
  const draftById = new Map(draftClauses.map((clause) => [stringValue(clause.id), clause]));
  const declaredById = new Map(declared.map((deviation) => [stringValue(deviation.clause_id), deviation]));
  const confirmedDeviations = [];

  for (const templateClause of templateClauses) {
    const id = stringValue(templateClause.id);
    const draftClause = draftById.get(id);
    if (!draftClause) {
      findings.push({ code: "clause.missing", message: `draft is missing template clause ${id}.` });
      continue;
    }
    const text = stringValue(draftClause.text) ?? "";
    const { rendered, unresolved } = renderBaseline(templateClause.baseline, scope);
    if (text === rendered && unresolved.length === 0) {
      if (declaredById.has(id)) {
        findings.push({ code: "deviation.not_real", message: `clause ${id} declares a deviation but matches the rendered baseline.` });
      }
      continue;
    }
    const deviation = declaredById.get(id);
    if (!deviation || !stringValue(deviation.reason)) {
      findings.push({ code: "deviation.undeclared", message: `clause ${id} differs from the rendered baseline without a declared deviation reason.` });
      continue;
    }
    if (PLACEHOLDER.test(text)) {
      findings.push({ code: "placeholder.unresolved", message: `clause ${id} still contains unresolved placeholders.` });
      PLACEHOLDER.lastIndex = 0;
      continue;
    }
    confirmedDeviations.push({ clause_id: id, reason: stringValue(deviation.reason), baseline: rendered, text });
  }
  for (const id of declaredById.keys()) {
    if (!templateClauses.some((clause) => stringValue(clause.id) === id)) {
      findings.push({ code: "deviation.unknown_clause", message: `declared deviation targets unknown clause ${id}.` });
    }
  }

  const drafted = findings.length === 0;
  const termsDigest = drafted ? requiredDigest(inputs.terms_digest) : null;
  const draftRef = drafted ? `runx:contract-draft:${termsDigest.slice("sha256:".length, "sha256:".length + 16)}` : null;
  const sendProposal = drafted
    ? {
        schema: "runx.contract_send_proposal.v1",
        status: "ready_for_send_as",
        gate: {
          gate_id: "send-as.provider-delivery.required",
          human_approval_required: true,
          approved: false,
          send_as_preflight_required: true,
        },
        delivery_skill: "send-as",
        sent: false,
        consumer: {
          skill: "runx/send-as",
          runner: "plan",
          packet: "runx.send_as.plan.v1",
          inputs: {
            objective: stringValue(send.objective),
            principal: stringValue(send.principal),
            provider_context: record(send.provider_context),
            audience: record(send.audience),
            content_ref: {
              draft_ref: draftRef,
              digest: termsDigest,
              subject_or_title: stringValue(send.subject_or_title),
            },
            consent_basis: stringValue(send.consent_basis),
            operator_context: stringValue(send.operator_context),
          },
        },
        provider_action: null,
        live_external_send_performed: false,
      }
    : null;
  return packet({
    decision: drafted ? "drafted" : "refused",
    review_status: drafted ? "requires_review" : "refused",
    delivery_status: "not_sent",
    draft_ref: draftRef,
    reason: drafted
      ? `Draft covers every template clause with all required terms bound and ${confirmedDeviations.length} declared deviation(s).`
      : "Refused: the draft does not deterministically reconcile with the template and declared deviations.",
    document: drafted
      ? {
          template_id: stringValue(template.id),
          template_version: stringValue(template.version),
          title: stringValue(draft.title) ?? stringValue(template.title),
          clauses: templateClauses.map((templateClause) => {
            const clause = draftById.get(stringValue(templateClause.id));
            return { id: stringValue(templateClause.id), heading: stringValue(templateClause.heading), text: stringValue(clause.text) ?? "" };
          }),
        }
      : null,
    deviations: confirmedDeviations,
    send_proposal: sendProposal,
    validation: {
      status: drafted ? "pass" : "fail",
      findings,
      provider_delivery_outside_contract_drafter: true,
      live_external_send_performed: false,
    },
    template_digest: requiredDigest(inputs.template_digest),
    parties_digest: requiredDigest(inputs.parties_digest),
    terms_digest: termsDigest ?? requiredDigest(inputs.terms_digest),
  });
}

export function finalizeSendPlan(inputs) {
  const draft = record(inputs.contract_draft);
  const sendPlan = record(inputs.send_plan);
  const proposal = record(draft.send_proposal);
  const proposalInputs = record(record(proposal.consumer).inputs);
  if (draft.decision !== "drafted") throw new Error("send-as planning may only finalize a drafted contract");
  assertEqual(proposal.consumer?.skill, "runx/send-as", "proposal must target canonical runx/send-as");
  assertEqual(proposal.consumer?.runner, "plan", "proposal must target send-as plan");
  assertEqual(proposal.provider_action, null, "contract-drafter must not select a provider action");
  assertEqual(proposal.live_external_send_performed, false, "contract-drafter must not perform a live send");
  assertEqual(sendPlan.decision, "ready", "send_plan decision must be ready");
  assertEqual(sendPlan.action_family, "send-as", "send_plan action_family must be send-as");
  assertEqual(record(sendPlan.principal).ref, proposalInputs.principal, "send_plan principal must match proposal");
  assertEqual(record(sendPlan.audience).ref, record(proposalInputs.audience).ref, "send_plan audience must match proposal");
  assertEqual(record(sendPlan.content).draft_ref, draft.draft_ref, "send_plan content draft_ref must match draft_ref");
  assertEqual(record(sendPlan.content).digest, record(proposalInputs.content_ref).digest, "send_plan content digest must match proposal content_ref");
  assertEqual(record(sendPlan.gates).human_approval_required, true, "send_plan must require human approval before provider delivery");
  assertEqual(record(sendPlan.gates).preflight_required, true, "send_plan must require preflight before provider delivery");
  assertEqual(record(sendPlan.success_checkpoint).milestone, "provider_delivery_required", "send_plan must leave provider delivery outstanding");
  if (sendPlan.delivery_evidence || sendPlan.provider_receipt || sendPlan.delivery_status === "delivered") {
    throw new Error("send_plan must not claim provider delivery");
  }
  return {
    contract_draft: {
      ...draft,
      send_plan: sendPlan,
      validation: {
        ...record(draft.validation),
        canonical_send_as_dependency_executed: true,
        canonical_send_as_dependency: "../send-as#plan",
        provider_delivery_outside_contract_drafter: true,
        live_external_send_performed: false,
      },
    },
  };
}

export function finishRefusal(inputs) {
  const draft = record(inputs.contract_draft);
  if (draft.decision !== "refused") throw new Error("finishRefusal only accepts refused draft evaluations");
  assertEqual(draft.review_status, "refused", "refused drafts must pin review_status");
  assertEqual(draft.delivery_status, "not_sent", "refused drafts must pin delivery_status");
  assertEqual(draft.draft_ref, null, "refused drafts must not emit a draft_ref");
  assertEqual(draft.document, null, "refused drafts must not emit a document");
  assertEqual(draft.send_proposal, null, "refused drafts must not emit a send proposal");
  return { contract_draft: draft };
}

function renderBaseline(baseline, scope) {
  const unresolved = [];
  const rendered = String(baseline ?? "").replace(PLACEHOLDER, (match, path) => {
    const value = path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), scope);
    if (value === undefined || value === null || (typeof value === "object" && !Array.isArray(value))) {
      unresolved.push(path);
      return match;
    }
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
  return { rendered, unresolved };
}

function packet(body) {
  return { contract_draft: { schema: "runx.contract_draft.v1", ...body, delivery_performed: false } };
}

function requiredDigest(value) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) {
    throw new Error("native digest evidence is missing");
  }
  return value;
}

function requireString(value, field, findings) {
  if (!stringValue(value)) findings.push({ code: "send.missing", message: `${field} is required.` });
}

function requireRecord(value, field, findings) {
  if (Object.keys(record(value)).length === 0) findings.push({ code: "send.missing", message: `${field} is required.` });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter(Boolean))];
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

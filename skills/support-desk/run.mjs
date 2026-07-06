import fs from "node:fs";

const inputs = readInputs();
const supportThread = normalizeThread(inputs.support_thread);
const docs = normalizeDocs(inputs.docs_corpus ?? inputs.source_catalog ?? []);
const customerContext = objectValue(inputs.customer_context ?? {}, "customer_context");
const policy = objectValue(inputs.support_policy ?? {}, "support_policy");

if (supportThread.length === 0) {
  fail("support_thread must contain at least one message");
}

const threadText = supportThread.map((m) => `${m.role}: ${m.body}`).join("\n");
const normalized = normalize(threadText);
const sensitiveTopics = matchedSensitiveTopics(normalized, policy);
const bugSignals = matchedSignals(normalized, listFrom(policy.issue_intake_keywords, ["bug", "error", "500", "broken", "regression", "crash", "failed"]));
const safeTopics = matchedSignals(normalized, listFrom(policy.safe_reply_topics, ["dns", "domain verification", "dkim", "setup", "configure", "docs"]));
const contextFindings = buildContextFindings(normalized, docs);
const missingContext = buildMissingContext({ docs, contextFindings, sensitiveTopics, safeTopics, bugSignals });
const summary = buildSupportSummary(supportThread, customerContext);
const lane = chooseLane({ sensitiveTopics, docs, contextFindings, safeTopics, bugSignals, normalized });
const confidence = confidenceFor({ lane, sensitiveTopics, contextFindings, safeTopics, bugSignals });
const decision = {
  lane,
  rationale: rationaleFor(lane, { sensitiveTopics, contextFindings, safeTopics, bugSignals, missingContext }),
  confidence,
};

const productName = stringValue(policy.product_name) ?? "the product";
const signature = stringValue(policy.support_signature) ?? "Support";
const proposal = buildProposal(lane, { supportThread, summary, contextFindings, missingContext, sensitiveTopics, productName, signature, bugSignals });

const result = {
  support_summary: summary,
  context_findings: contextFindings,
  decision,
  reply_only: proposal.reply_only,
  issue_intake_proposal: proposal.issue_intake_proposal,
  followup_plan: proposal.followup_plan,
  manual_review: proposal.manual_review,
  evidence: {
    side_effects: "none",
    docs_used: contextFindings.map((finding) => finding.citation),
    cited_docs_count: new Set(contextFindings.map((finding) => finding.citation)).size,
    unsupported_claims: missingContext,
    sensitive_topics: sensitiveTopics,
    thread_evidence: supportThread.map((message, index) => ({ index, role: message.role, at: message.at ?? null })),
    customer_context_keys: Object.keys(customerContext).sort(),
    proposal_type: lane,
    sends_message: false,
    opens_ticket: false,
    mutates_account: false,
    harness_case_names: ["docs-grounded-reply-only", "sensitive-billing-security-manual-review"],
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
    support_thread: parseInputValue(process.env.RUNX_INPUT_SUPPORT_THREAD),
    docs_corpus: parseInputValue(process.env.RUNX_INPUT_DOCS_CORPUS),
    source_catalog: parseInputValue(process.env.RUNX_INPUT_SOURCE_CATALOG),
    customer_context: parseInputValue(process.env.RUNX_INPUT_CUSTOMER_CONTEXT),
    support_policy: parseInputValue(process.env.RUNX_INPUT_SUPPORT_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeThread(raw) {
  if (Array.isArray(raw)) {
    return raw.map((message, index) => normalizeMessage(message, index)).filter((message) => message.body);
  }
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.messages)) {
      return raw.messages.map((message, index) => normalizeMessage(message, index)).filter((message) => message.body);
    }
    const body = [raw.subject, raw.body, raw.text].filter(Boolean).join("\n");
    return body ? [normalizeMessage({ role: "customer", body, at: raw.at }, 0)] : [];
  }
  if (typeof raw === "string" && raw.trim()) {
    return [normalizeMessage({ role: "customer", body: raw }, 0)];
  }
  return [];
}

function normalizeMessage(message, index) {
  const object = message && typeof message === "object" ? message : { body: String(message ?? "") };
  return {
    role: stringValue(object.role) ?? (index === 0 ? "customer" : "note"),
    body: stringValue(object.body ?? object.text ?? object.message) ?? "",
    at: stringValue(object.at ?? object.created_at),
  };
}

function normalizeDocs(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  return list.map((doc, index) => {
    const object = doc && typeof doc === "object" ? doc : { text: String(doc ?? "") };
    const id = stringValue(object.id ?? object.key ?? object.slug) ?? `source-${index + 1}`;
    return {
      id,
      title: stringValue(object.title ?? object.name) ?? id,
      url: stringValue(object.url ?? object.href ?? object.source_url) ?? `artifact://${id}`,
      text: stringValue(object.text ?? object.body ?? object.content ?? object.summary) ?? "",
    };
  }).filter((doc) => doc.text.trim());
}

function objectValue(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function stringValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function listFrom(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => normalize(String(item))).filter(Boolean);
  return fallback;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9@:/._\-\s]/g, " ").replace(/\s+/g, " ").trim();
}

function matchedSensitiveTopics(text, policy) {
  const defaults = ["refund", "billing", "invoice", "payment", "password", "reset", "mfa", "2fa", "security", "abuse", "legal", "account access", "delete account", "bank", "stripe", "token", "credential", "private key", "id verification"];
  return matchedSignals(text, listFrom(policy.sensitive_topics, defaults));
}

function matchedSignals(text, signals) {
  const found = [];
  for (const signal of signals) {
    const normalizedSignal = normalize(signal);
    if (normalizedSignal && text.includes(normalizedSignal) && !found.includes(normalizedSignal)) found.push(normalizedSignal);
  }
  return found;
}

function buildContextFindings(text, docs) {
  const findings = [];
  for (const doc of docs) {
    const docText = normalize(`${doc.title} ${doc.text}`);
    const score = overlapScore(text, docText);
    if (score === 0) continue;
    const claim = claimFromDoc(doc, text);
    findings.push({ claim, citation: doc.id, source_title: doc.title, source_url: doc.url, overlap_score: score });
  }
  return findings.sort((a, b) => b.overlap_score - a.overlap_score).slice(0, 4);
}

function overlapScore(a, b) {
  const important = ["dns", "domain", "verification", "verify", "dkim", "cname", "txt", "propagation", "setup", "configure", "error", "failed", "bug", "docs"];
  return important.filter((term) => a.includes(term) && b.includes(term)).length;
}

function claimFromDoc(doc, text) {
  const docText = doc.text.trim();
  const firstSentence = docText.split(/(?<=[.!?])\s+/)[0] || docText;
  if (text.includes("dns") || text.includes("domain") || text.includes("verification")) {
    return firstSentence.slice(0, 220);
  }
  return `${doc.title}: ${firstSentence}`.slice(0, 220);
}

function buildMissingContext({ docs, contextFindings, sensitiveTopics, safeTopics, bugSignals }) {
  const missing = [];
  if (docs.length === 0) missing.push("No supplied docs_corpus or source_catalog to cite.");
  if (contextFindings.length === 0 && sensitiveTopics.length === 0) missing.push("No supplied source snippet supports an answerable claim.");
  if (safeTopics.length === 0 && bugSignals.length === 0 && sensitiveTopics.length === 0) missing.push("Thread does not match a known safe reply, issue intake, or escalation topic.");
  if (sensitiveTopics.length > 0) missing.push("Request depends on sensitive/private-state handling and must remain manual.");
  return missing;
}

function buildSupportSummary(thread, customerContext) {
  const customerMessages = thread.filter((message) => /customer|user/i.test(message.role));
  const primary = customerMessages[0] ?? thread[0];
  return {
    request: summarize(primary.body),
    message_count: thread.length,
    customer_context_used: Object.keys(customerContext).sort(),
    latest_customer_message: summarize((customerMessages[customerMessages.length - 1] ?? primary).body),
  };
}

function chooseLane({ sensitiveTopics, docs, contextFindings, safeTopics, bugSignals, normalized }) {
  if (sensitiveTopics.length > 0) return "manual_review";
  if (bugSignals.length > 0) return "issue_intake_proposal";
  if (contextFindings.length > 0 && (safeTopics.length > 0 || docs.length > 0)) return "reply_only";
  if (normalized.length < 40 || docs.length === 0) return "followup_plan";
  return "manual_review";
}

function confidenceFor({ lane, sensitiveTopics, contextFindings, safeTopics, bugSignals }) {
  if (lane === "manual_review" && sensitiveTopics.length > 0) return 0.91;
  if (lane === "reply_only") return Math.min(0.92, 0.68 + contextFindings.length * 0.08 + safeTopics.length * 0.04);
  if (lane === "issue_intake_proposal") return Math.min(0.86, 0.62 + bugSignals.length * 0.08 + contextFindings.length * 0.04);
  if (lane === "followup_plan") return 0.72;
  return 0.58;
}

function rationaleFor(lane, details) {
  if (lane === "reply_only") return "The thread is answerable from supplied docs/source snippets and does not require private account state.";
  if (lane === "issue_intake_proposal") return "The thread describes a product problem that should be handed to issue-intake as a proposal, not opened directly.";
  if (lane === "followup_plan") return `More context is needed before a safe answer exists: ${details.missingContext.join("; ")}`;
  return `Manual review is required: ${details.sensitiveTopics.join(", ") || details.missingContext.join("; ") || "unsupported support request"}.`;
}

function buildProposal(lane, context) {
  return {
    reply_only: lane === "reply_only" ? buildReplyProposal(context) : null,
    issue_intake_proposal: lane === "issue_intake_proposal" ? buildIssueProposal(context) : null,
    followup_plan: lane === "followup_plan" ? buildFollowupPlan(context) : null,
    manual_review: lane === "manual_review" ? buildManualReview(context) : null,
  };
}

function buildReplyProposal({ supportThread, contextFindings, productName, signature }) {
  const customerName = firstName(extractCustomerName(supportThread));
  const greeting = customerName ? `Hi ${customerName},` : "Hi,";
  const bullets = contextFindings.map((finding) => `- ${finding.claim} (${finding.citation})`);
  return {
    subject: "Re: support request",
    body: [
      greeting,
      "",
      `Thanks for the note. Based on the supplied ${productName} docs, the safest next checks are:`,
      ...bullets,
      "",
      "This reply is a proposal only and should be reviewed before sending.",
      "",
      "Thanks,",
      signature,
    ].join("\n"),
    citations: contextFindings.map((finding) => ({ id: finding.citation, url: finding.source_url })),
    send_gate: "requires_human_or_send_as_approval",
    external_side_effects: "none",
  };
}

function buildIssueProposal({ summary, contextFindings, bugSignals }) {
  return {
    title: `Support intake: ${summary.request}`.slice(0, 120),
    problem: summary.latest_customer_message,
    evidence: contextFindings.map((finding) => ({ claim: finding.claim, citation: finding.citation, url: finding.source_url })),
    labels: ["support-intake", ...bugSignals].slice(0, 6),
    handoff_gate: "issue_intake_must_review_before_opening",
    external_side_effects: "none",
  };
}

function buildFollowupPlan({ missingContext, contextFindings }) {
  return {
    reason: "A safe answer needs more evidence or customer detail.",
    questions: missingContext.length > 0 ? missingContext : ["Please provide the exact product area, error text, and public docs/source snippet to cite."],
    usable_context: contextFindings.map((finding) => ({ claim: finding.claim, citation: finding.citation })),
    external_side_effects: "none",
  };
}

function buildManualReview({ sensitiveTopics, missingContext, summary }) {
  return {
    reason: sensitiveTopics.length > 0 ? `Sensitive/private-state topics detected: ${sensitiveTopics.join(", ")}.` : "Unsupported or ambiguous support request.",
    summary: summary.request,
    blocked_actions: ["send_customer_reply", "open_ticket", "mutate_account", "change_billing", "reset_credentials"],
    next_operator_step: missingContext.length > 0 ? missingContext[0] : "Route to an authorized support operator with the correct private-system access.",
    external_side_effects: "none",
  };
}

function summarize(text) {
  const normalizedText = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalizedText) return "No support text supplied.";
  return normalizedText.length > 180 ? `${normalizedText.slice(0, 177)}...` : normalizedText;
}

function extractCustomerName(thread) {
  for (const message of thread) {
    const match = message.body.match(/(?:from|name)[:\s]+([A-Z][a-zA-Z-]+)/);
    if (match) return match[1];
  }
  return null;
}

function firstName(value) {
  const text = stringValue(value);
  return text ? text.split(/\s+/)[0] : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

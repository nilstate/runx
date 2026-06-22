import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const inboxPacket = objectValue(inputs.inbox_packet, "inbox_packet");
const policy = objectValue(inputs.operator_policy, "operator_policy");

const messages = Array.isArray(inboxPacket.messages) ? inboxPacket.messages : [];
const latest = messages[messages.length - 1] ?? null;
const source = stringValue(inboxPacket.source);
const threadId = stringValue(inboxPacket.thread_id);
const latestBody = stringValue(latest?.body);
const latestSubject = stringValue(latest?.subject);
const sender = objectOrNull(latest?.from);
const senderEmail = stringValue(sender?.email);
const senderName = stringValue(sender?.name);
const text = normalize(`${latestSubject ?? ""}\n${latestBody ?? ""}`);
const missingContext = missingContextFor({ source, threadId, latest, latestBody, senderEmail });
if (missingContext.length > 0) {
  fail(`inbox_packet is missing required bounded context: ${missingContext.join(", ")}`);
}
const unsafeSend = matches(text, ["send this now", "send without approval", "bypass approval", "skip approval", "auto-send", "autosend"]);
const label = missingContext.length > 0
  ? "unknown"
  : unsafeSend
    ? "unsafe_send_request"
    : classify(text);
const matchedSignals = signalsFor(label, text);
const confidence = confidenceFor(label, matchedSignals, missingContext);
const urgency = urgencyFor(label, text);
const queue = queueFor(label, policy, missingContext);
const citedMessageIds = latest?.id ? [String(latest.id)] : [];
const canDraft = label === "product_question" && missingContext.length === 0 && !unsafeSend;
const productName = stringValue(policy.product_name) ?? "the product";
const supportSignature = stringValue(policy.support_signature) ?? "Support";
const draftReply = canDraft
  ? buildDraftReply({ subject: latestSubject, body: latestBody, senderEmail, senderName, productName, supportSignature })
  : {
      proposed: false,
      to: senderEmail,
      subject: null,
      body: null,
      reason: draftBlocker(label, missingContext, unsafeSend),
    };
const contentDigest = draftReply.proposed
  ? `sha256:${crypto.createHash("sha256").update(draftReply.body).digest("hex")}`
  : null;
const gatedSendProposal = {
  decision: draftReply.proposed ? "requires_human_approval" : "blocked",
  send_as_skill: "send-as",
  approval_required: true,
  principal_ref: stringValue(policy.principal_ref) ?? "operator:support",
  channel: "email",
  recipient: senderEmail,
  content_digest: contentDigest,
  provider_action: draftReply.proposed ? "compose_review_then_send_after_approval" : "none",
  blocked_reason: draftReply.proposed ? null : draftReply.reason,
  handoff_requirements: [
    "Bind the principal and provider account in send-as.",
    "Bind the recipient and content digest before approval.",
    "Require human approval before delivery.",
    "Record provider send evidence after any approved send.",
  ],
};

const result = {
  classification: {
    label,
    confidence,
    urgency,
    matched_signals: matchedSignals,
    rationale: rationaleFor(label, missingContext, unsafeSend),
  },
  triage_queue: {
    name: queue.name,
    priority: queue.priority,
    reason: queue.reason,
    cited_message_ids: citedMessageIds,
    missing_context: missingContext,
  },
  draft_reply: draftReply,
  gated_send_proposal: gatedSendProposal,
  evidence: {
    source,
    thread_id: threadId,
    message_count: messages.length,
    latest_message_id: latest?.id ?? null,
    sender_metadata_present: Boolean(senderEmail),
    body_present: Boolean(latestBody),
    private_mailbox_access: false,
    live_send_attempted: false,
    taxonomy_coverage: [
      "product_question",
      "bug_report",
      "billing",
      "account_access",
      "abuse",
      "unsafe_send_request",
      "unknown",
    ],
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
    inbox_packet: parseInputValue(process.env.RUNX_INPUT_INBOX_PACKET),
    operator_policy: parseInputValue(process.env.RUNX_INPUT_OPERATOR_POLICY),
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

function classify(value) {
  if (matches(value, ["abuse", "spam", "phishing", "harassment", "threat", "fraud", "compromised"])) return "abuse";
  if (matches(value, ["invoice", "billing", "charge", "refund", "paid", "payment", "subscription", "plan", "tax"])) return "billing";
  if (matches(value, ["login", "password", "reset", "locked out", "2fa", "mfa", "owner", "access", "account"])) return "account_access";
  if (matches(value, ["error", "bug", "broken", "500", "failed", "crash", "exception", "does not work", "regression"])) return "bug_report";
  if (matches(value, ["how do i", "how can i", "where do i", "what should", "setup", "set up", "configure", "verify", "dns", "domain", "docs"])) return "product_question";
  return "unknown";
}

function confidenceFor(label, signals, missingContext) {
  if (missingContext.length > 0) return 0.25;
  if (label === "unknown") return 0.35;
  if (label === "unsafe_send_request") return 0.94;
  if (signals.length >= 3) return 0.88;
  if (signals.length === 2) return 0.78;
  return 0.66;
}

function urgencyFor(label, value) {
  if (label === "abuse" || label === "account_access") return "high";
  if (label === "bug_report" && matches(value, ["production", "all users", "down", "data loss", "security"])) return "critical";
  if (label === "billing" || label === "bug_report" || label === "unsafe_send_request") return "elevated";
  return "normal";
}

function queueFor(label, policy, missingContext) {
  const queues = objectOrNull(policy.queues) ?? {};
  if (missingContext.length > 0) {
    return {
      name: stringValue(queues.manual_review) ?? "support.manual_review",
      priority: "elevated",
      reason: "The inbox packet is missing required bounded context.",
    };
  }
  const mapping = {
    product_question: ["reply_drafts", "support.reply_drafts", "normal", "Safe product question with enough context for a draft."],
    bug_report: ["engineering_intake", "support.engineering_intake", "elevated", "Bug reports need reproduction-focused engineering triage."],
    billing: ["billing_review", "support.billing_review", "elevated", "Billing requests require verified account context."],
    account_access: ["account_review", "support.account_review", "high", "Account access requests require identity and ownership verification."],
    abuse: ["abuse_review", "support.abuse_review", "high", "Abuse reports require specialist review."],
    unsafe_send_request: ["manual_review", "support.manual_review", "high", "The message requested bypassing send approval."],
    unknown: ["manual_review", "support.manual_review", "elevated", "The message does not contain enough signal for a safe draft."],
  };
  const [key, fallback, priority, reason] = mapping[label] ?? mapping.unknown;
  return { name: stringValue(queues[key]) ?? fallback, priority, reason };
}

function buildDraftReply({ subject, body, senderEmail, senderName, productName, supportSignature }) {
  const greeting = senderName ? `Hi ${firstName(senderName)},` : "Hi,";
  const response = answerForProductQuestion(`${subject ?? ""}\n${body ?? ""}`, productName);
  return {
    proposed: true,
    to: senderEmail,
    subject: subject && /^re:/i.test(subject) ? subject : `Re: ${subject ?? "your question"}`,
    body: [
      greeting,
      "",
      response,
      "",
      "Before this is sent, an operator should confirm the thread context and approve the send-as handoff. This skill has not sent the message.",
      "",
      "Thanks,",
      supportSignature,
    ].join("\n"),
  };
}

function answerForProductQuestion(value, productName) {
  const normalized = normalize(value);
  if (matches(normalized, ["dns", "domain", "dkim", "spf", "dmarc", "verify"])) {
    return `For ${productName} domain verification, compare the host/name and value fields with the records shown in setup, then wait for DNS propagation and run the verification check again. If your DNS provider appends the root domain automatically, make sure the host value is not duplicated.`;
  }
  if (matches(normalized, ["webhook", "api", "integration"])) {
    return `For ${productName} integrations, confirm the endpoint or API key is scoped to the environment you are testing, retry one minimal request, and save the response body if it still fails.`;
  }
  return `For ${productName}, follow the documented setup step named in your message and retry once the required fields are complete. If it still fails, reply with the exact error text, timestamp, and the screen where it happened.`;
}

function draftBlocker(label, missingContext, unsafeSend) {
  if (missingContext.length > 0) return `Missing required context: ${missingContext.join(", ")}.`;
  if (unsafeSend) return "The request asked to bypass send approval.";
  if (["billing", "account_access", "abuse"].includes(label)) return "This category requires private-state or specialist review before drafting.";
  if (label === "bug_report") return "Bug reports should be routed with reproduction evidence before a customer-facing reply is drafted.";
  return "The message is too ambiguous for a safe reply draft.";
}

function rationaleFor(label, missingContext, unsafeSend) {
  if (missingContext.length > 0) return "Required bounded inbox fields are missing.";
  if (unsafeSend) return "The message contains send-without-approval language.";
  const rationales = {
    product_question: "The message asks a bounded setup or product-use question.",
    bug_report: "The message reports failure or broken behavior.",
    billing: "The message references payment, invoices, plans, or refunds.",
    account_access: "The message references login, password, ownership, or account access.",
    abuse: "The message references abuse, spam, phishing, fraud, or compromise.",
    unknown: "The message lacks enough known signals for a confident route.",
  };
  return rationales[label] ?? rationales.unknown;
}

function missingContextFor({ source, threadId, latest, latestBody, senderEmail }) {
  const missing = [];
  if (!source) missing.push("source");
  if (!threadId) missing.push("thread_id");
  if (!latest) {
    missing.push("latest message");
    return missing;
  }
  if (!senderEmail) missing.push("sender email");
  if (!latestBody) missing.push("message body");
  return missing;
}

function signalsFor(label, value) {
  const dictionaries = {
    product_question: ["how do i", "how can i", "where do i", "what should", "setup", "set up", "configure", "verify", "dns", "domain", "docs"],
    bug_report: ["error", "bug", "broken", "500", "failed", "crash", "exception", "does not work", "regression"],
    billing: ["invoice", "billing", "charge", "refund", "paid", "payment", "subscription", "plan", "tax"],
    account_access: ["login", "password", "reset", "locked out", "2fa", "mfa", "owner", "access", "account"],
    abuse: ["abuse", "spam", "phishing", "harassment", "threat", "fraud", "compromised"],
    unsafe_send_request: ["send this now", "send without approval", "bypass approval", "skip approval", "auto-send", "autosend"],
    unknown: [],
  };
  return (dictionaries[label] ?? []).filter((signal) => value.includes(signal));
}

function matches(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function firstName(value) {
  return String(value ?? "").split(/\s+/)[0]?.replace(/[^a-zA-Z'-]/g, "") || null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

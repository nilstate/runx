import fs from "node:fs";

const inputs = readInputs();
const request = objectValue(inputs.support_request, "support_request");
const policy = objectValue(inputs.policy ?? {}, "policy");

const subject = stringValue(request.subject);
const body = stringValue(request.body);

if (!subject && !body) {
  fail("support_request.subject or support_request.body is required");
}

const text = `${subject ?? ""}\n${body ?? ""}`;
const normalized = normalize(text);
const classification = classify(normalized);
const severity = classifySeverity(classification, normalized);
const confidence = confidenceFor(classification, normalized);
const recommendedPath = recommendedPathFor(classification, confidence);
const productName = stringValue(policy.product_name) ?? "the product";
const signature = stringValue(policy.support_signature) ?? "Support";
const customerName = firstName(stringValue(request.customer_name));
const draftEmail = recommendedPath === "reply_draft"
  ? buildDraftEmail({ request, subject, body, productName, signature, customerName })
  : {
      proposed: false,
      subject: null,
      body: null,
      reason: "A customer reply is not safe from the supplied context.",
    };

const missingContext = missingContextFor(classification, normalized, request);
const matchedSignals = signalsFor(classification, normalized);
const hasDraftProposal = draftEmail.proposed !== false;
const sendGate = {
  status: "requires_human_approval",
  action: hasDraftProposal ? "send_customer_email" : "no_customer_send_proposed",
  rationale: hasDraftProposal
    ? "The draft is customer-ready, but this skill never sends. A separate governed send lane must approve delivery."
    : "The request needs review or more evidence before a customer reply is safe.",
};

const result = {
  classification,
  severity,
  confidence,
  recommended_path: recommendedPath,
  evidence: {
    source: stringValue(request.source) ?? "inline_support_request",
    source_summary: summarize(subject, body),
    matched_signals: matchedSignals,
    missing_context: missingContext,
    taxonomy_coverage: ["how_to", "billing", "account_access", "bug", "abuse", "unknown"],
    private_data_required: ["billing", "account_access"].includes(classification),
    send_side_effects: "none",
  },
  draft_email: draftEmail,
  send_gate: sendGate,
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
    support_request: parseInputValue(process.env.RUNX_INPUT_SUPPORT_REQUEST),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
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

function classify(text) {
  if (matches(text, ["abuse", "spam", "phishing", "harassment", "threat", "fraud", "compromised"])) {
    return "abuse";
  }
  if (matches(text, ["invoice", "billing", "charge", "refund", "paid", "payment", "subscription", "plan", "tax"])) {
    return "billing";
  }
  if (matches(text, ["login", "password", "reset", "locked out", "2fa", "mfa", "owner", "access", "account"])) {
    return "account_access";
  }
  if (matches(text, ["error", "bug", "broken", "500", "failed", "crash", "exception", "does not work", "regression"])) {
    return "bug";
  }
  if (matches(text, ["how do i", "how can i", "where do i", "what should", "setup", "set up", "configure", "verify", "dns", "domain", "docs"])) {
    return "how_to";
  }
  return "unknown";
}

function classifySeverity(classification, text) {
  if (classification === "abuse") return "high";
  if (classification === "billing" && matches(text, ["double charge", "charged twice", "refund"])) return "high";
  if (classification === "account_access") return "high";
  if (classification === "bug" && matches(text, ["all users", "production", "down", "data loss", "security"])) return "critical";
  if (classification === "bug") return "medium";
  if (classification === "unknown") return "medium";
  return "low";
}

function confidenceFor(classification, text) {
  const signalCount = signalsFor(classification, text).length;
  if (classification === "unknown") return 0.35;
  if (signalCount >= 3) return 0.88;
  if (signalCount === 2) return 0.78;
  return 0.66;
}

function recommendedPathFor(classification, confidence) {
  if (confidence < 0.5) return "manual_review";
  switch (classification) {
    case "how_to":
      return "reply_draft";
    case "billing":
      return "billing_review";
    case "account_access":
      return "account_review";
    case "bug":
      return "engineering_intake";
    case "abuse":
      return "abuse_review";
    default:
      return "request_info";
  }
}

function buildDraftEmail({ request, subject, body, productName, signature, customerName }) {
  const greeting = customerName ? `Hi ${customerName},` : "Hi,";
  const requestLine = summarize(subject, body);
  const answer = answerForHowTo(`${subject ?? ""}\n${body ?? ""}`, productName);
  return {
    proposed: true,
    subject: subject && /^re:/i.test(subject) ? subject : `Re: ${subject ?? "your support request"}`,
    body: [
      greeting,
      "",
      `Thanks for the note. You asked about ${requestLine}.`,
      "",
      answer,
      "",
      "Before sending, an operator should confirm the product state and any account-specific details. This draft has not been sent.",
      "",
      "Thanks,",
      signature,
    ].join("\n"),
    recipient_hint: stringValue(request.customer_email) ? "customer_email_present" : "no_customer_email",
  };
}

function answerForHowTo(text, productName) {
  const normalized = normalize(text);
  if (matches(normalized, ["dns", "domain", "dkim", "spf", "dmarc", "verify"])) {
    return `For ${productName} domain verification, check that the DNS records shown in the sending-domain setup are published exactly, then run the domain verification check again after DNS propagation. If a record still fails, compare the host/name and value fields character for character, including whether your DNS provider automatically appends the root domain.`;
  }
  if (matches(normalized, ["api", "webhook", "integration"])) {
    return `For ${productName} integration setup, start by confirming the API key or webhook endpoint is scoped for the environment you are testing, then retry with one minimal request and save the response body if it fails.`;
  }
  return `For ${productName}, the safest next step is to follow the documented setup flow for the feature named in your request and confirm each required field before retrying. If the same step fails, send us the exact screen, error text, and timestamp so we can trace it.`;
}

function missingContextFor(classification, text, request) {
  const missing = [];
  if (!stringValue(request.source)) missing.push("source locator");
  if (classification === "bug" && !matches(text, ["error", "500", "exception", "screenshot", "timestamp", "request id"])) {
    missing.push("reproduction details or captured error");
  }
  if (classification === "billing") missing.push("verified billing/account context");
  if (classification === "account_access") missing.push("verified account ownership context");
  if (classification === "unknown") missing.push("clear product surface and desired outcome");
  return missing;
}

function signalsFor(classification, text) {
  const dictionaries = {
    how_to: ["how do i", "how can i", "where do i", "what should", "setup", "set up", "configure", "verify", "dns", "domain", "docs"],
    billing: ["invoice", "billing", "charge", "refund", "paid", "payment", "subscription", "plan", "tax"],
    account_access: ["login", "password", "reset", "locked out", "2fa", "mfa", "owner", "access", "account"],
    bug: ["error", "bug", "broken", "500", "failed", "crash", "exception", "does not work", "regression"],
    abuse: ["abuse", "spam", "phishing", "harassment", "threat", "fraud", "compromised"],
    unknown: [],
  };
  return (dictionaries[classification] ?? []).filter((signal) => text.includes(signal));
}

function summarize(subject, body) {
  const candidate = subject || body || "the support request";
  const oneLine = String(candidate).replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 137)}...` : oneLine;
}

function matches(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function firstName(value) {
  if (!value) return null;
  return value.split(/\s+/)[0]?.replace(/[^a-zA-Z'-]/g, "") || null;
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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

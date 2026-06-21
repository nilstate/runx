import fs from "node:fs";

const input = readInputs();
const packet = obj(input.inbox_packet);
const sender = obj(input.sender_metadata);
const policy = obj(input.operator_policy);
const messages = Array.isArray(packet.messages) ? packet.messages : [];

if (messages.length === 0 || !hasSender(sender)) {
  emit(stop("needs_input", "inbox_packet.messages and sender_metadata are required"));
}

const queue = messages.map((message, index) => classify(message, index)).sort((a, b) => b.score - a.score);
const draftable = queue.find((entry) => entry.recommended_action === "draft_reply");
const draft = draftable ? draftReply(draftable, sender, policy) : {
  proposed: false,
  reason: "No safe reply candidate was found in the bounded inbox packet.",
};

emit({
  status: "ready",
  classification: {
    total: queue.length,
    high_priority: queue.filter((entry) => entry.priority === "high").length,
    draftable: queue.filter((entry) => entry.recommended_action === "draft_reply").length,
    manual_review: queue.filter((entry) => entry.recommended_action === "manual_review").length,
  },
  triage_queue: queue.map(({ score, ...entry }) => entry),
  draft_reply: draft,
  gated_send_proposal: {
    status: draft.proposed ? "requires_human_approval" : "no_send_proposed",
    action: draft.proposed ? "send_as_after_review" : "none",
    rationale: draft.proposed
      ? "This skill drafts only. A separate governed send lane must approve delivery."
      : "The input did not support a safe outgoing message.",
  },
  evidence: {
    source: text(packet.source) || "bounded_packet",
    message_count: queue.length,
    unsafe_count: queue.filter((entry) => entry.safety === "unsafe").length,
    side_effects: "none",
  },
});

function classify(message, index) {
  const id = text(message?.id) || `message_${index + 1}`;
  const subject = text(message?.subject) || "(no subject)";
  const body = text(message?.body) || text(message?.summary) || "";
  const full = `${subject} ${body}`.toLowerCase();
  const unsafe = /password|otp|bank account|wire transfer|legal notice|delete account|reset my/i.test(full);
  const missing = body.length === 0;
  const scheduling = /meeting|call|schedule|agenda|time/i.test(full);
  const replyable = /\?|question|confirm|can you|please|how do/i.test(full);
  const priority = unsafe || /urgent|blocked|today|approval|invoice|contract/i.test(full) ? "high" : "normal";
  const classification = unsafe
    ? "unsafe_or_sensitive"
    : missing
      ? "needs_context"
      : scheduling
        ? "scheduling"
        : replyable
          ? "replyable"
          : "informational";
  const recommended_action = unsafe
    ? "manual_review"
    : missing
      ? "request_more_context"
      : scheduling || replyable
        ? "draft_reply"
        : "archive_or_monitor";
  return {
    message_id: id,
    classification,
    priority,
    safety: unsafe ? "unsafe" : "safe_bounded_context",
    recommended_action,
    reason: reason({ unsafe, missing, scheduling, replyable }),
    source_summary: { subject, excerpt: body.replace(/\s+/g, " ").slice(0, 180) },
    redacted_sender: redact(text(message?.from) || "unknown"),
    evidence_refs: [id],
    score: (priority === "high" ? 20 : 5) + (recommended_action === "draft_reply" ? 5 : 0),
  };
}

function draftReply(entry, sender, policy) {
  const signature = text(policy.signature) || text(sender.name) || text(sender.role) || "Team";
  return {
    proposed: true,
    source_message_id: entry.message_id,
    subject: `Re: ${entry.source_summary.subject}`,
    body: [
      "Hi,",
      "",
      `Thanks for the note about ${entry.source_summary.subject}.`,
      "",
      entry.classification === "scheduling"
        ? "I can help coordinate the next step. Please confirm the preferred time window and any agenda points we should cover."
        : "I can help with this. Based on the bounded message context, the safest next step is to confirm the missing details before taking action.",
      "",
      "This draft is prepared for review and has not been sent.",
      "",
      `Thanks,\n${signature}`,
    ].join("\n"),
  };
}

function reason({ unsafe, missing, scheduling, replyable }) {
  if (unsafe) return "Sensitive wording requires manual review before any reply.";
  if (missing) return "The message has no bounded body or summary to cite.";
  if (scheduling) return "The message asks for coordination and can receive a reviewed scheduling draft.";
  if (replyable) return "The message asks a bounded question and can receive a reviewed draft.";
  return "No immediate response is required.";
}

function stop(status, reasonText) {
  return {
    status,
    classification: { total: 0, high_priority: 0, draftable: 0, manual_review: 0 },
    triage_queue: [],
    draft_reply: { proposed: false, reason: reasonText },
    gated_send_proposal: { status: "no_send_proposed", action: "none", rationale: reasonText },
    evidence: { stop_reason: reasonText, side_effects: "none" },
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}
function obj(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function hasSender(value) { return Boolean(text(value.name) || text(value.role) || text(value.email)); }
function redact(value) { return String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]"); }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }


import fs from "node:fs";
import path from "node:path";

const SCHEMA = "runx.inbox_triage.v1";
const inputs = readInputs();
const skillRoot = process.cwd();

const messages = normalizeMessages(inputs.inbox_packet);
const senderMetadata = normalizeObject(inputs.sender_metadata);
const policy = normalizePolicy(inputs.operator_policy);
const triage = buildTriage({ messages, senderMetadata, policy });
const report = renderReport(triage);

writeArtifacts(inputs.output_dir, triage, report, skillRoot);
process.stdout.write(`${JSON.stringify(triage, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizeMessages(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((message) => message && typeof message === "object")
    .map((message, index) => ({
      id: stringValue(message.id) || `message-${index + 1}`,
      from: stringValue(message.from) || stringValue(message.sender),
      subject: stringValue(message.subject),
      body: stringValue(message.body) || stringValue(message.text),
      timestamp: stringValue(message.timestamp) || stringValue(message.received_at),
      labels: normalizeStringArray(message.labels),
    }));
}

function normalizePolicy(rawValue) {
  const parsed = normalizeObject(rawValue);
  return {
    approval_gate: stringValue(parsed.approval_gate) || "send-as",
    signature: stringValue(parsed.signature),
    allowed_intents: normalizeStringArray(parsed.allowed_intents),
    blocked_terms: normalizeStringArray(parsed.blocked_terms),
    auto_send: parsed.auto_send === true,
  };
}

function buildTriage({ messages, senderMetadata, policy }) {
  const base = {
    schema: SCHEMA,
    decision: "ready",
    classification: [],
    triage_queue: [],
    draft_reply: null,
    gated_send_proposal: {
      approval_required: true,
      send_skill: "send-as",
      blocked_until_approval: true,
      approval_gate: policy.approval_gate,
    },
    missing_evidence: [],
    refusals: [],
  };

  if (policy.auto_send) {
    return {
      ...base,
      decision: "refused",
      refusals: [{
        field: "operator_policy.auto_send",
        reason: "inbox-triage never sends; auto-send must be handled by an approval-gated send skill.",
      }],
    };
  }
  if (messages.length === 0) {
    return {
      ...base,
      decision: "needs_more_evidence",
      missing_evidence: [{
        message_id: "",
        field: "inbox_packet",
        reason: "At least one bounded message is required.",
      }],
    };
  }

  for (const message of messages) {
    if (!message.from) {
      base.missing_evidence.push({
        message_id: message.id,
        field: "from",
        reason: "Sender is required before a reply can be drafted.",
      });
    }
    if (!message.body) {
      base.missing_evidence.push({
        message_id: message.id,
        field: "body",
        reason: "Body is required; subject-only replies are not safe.",
      });
    }
  }
  if (base.missing_evidence.length > 0) {
    base.decision = "needs_more_evidence";
    return base;
  }

  for (const message of messages) {
    const sender = senderMetadata[message.from] || senderMetadata[message.id] || {};
    const classification = classifyMessage(message, sender, policy);
    base.classification.push(classification);
    base.triage_queue.push({
      message_id: message.id,
      reason: classification.reason,
      next_step: classification.replyable ? "draft_reply_for_approval" : "review_without_reply",
      priority: classification.priority,
    });
  }

  base.triage_queue.sort(compareQueue);
  const replyTarget = base.classification
    .filter((entry) => entry.replyable)
    .sort(compareClassification)[0];
  if (!replyTarget) {
    base.decision = "needs_more_evidence";
    base.missing_evidence.push({
      message_id: "",
      field: "replyable_message",
      reason: "No message passed reply safety checks.",
    });
    return base;
  }

  const message = messages.find((entry) => entry.id === replyTarget.message_id);
  base.draft_reply = draftReply(message, replyTarget, policy);
  return base;
}

function classifyMessage(message, sender, policy) {
  const text = `${message.subject} ${message.body} ${message.labels.join(" ")}`.toLowerCase();
  const policyBlocked = policy.blocked_terms.some((term) => term && text.includes(term.toLowerCase()));
  const blocked = sender.blocked === true
    || policyBlocked
    || /\b(phish|password|wire transfer|gift card|credential)\b/.test(text);
  const intent = /\b(invoice|billing|payment|receipt)\b/.test(text)
    ? "billing"
    : /\b(error|bug|broken|support|help)\b/.test(text)
      ? "support"
      : /\b(meeting|schedule|calendar)\b/.test(text)
        ? "scheduling"
        : "general";
  const priority = blocked || /\b(urgent|asap|today|blocked|failed)\b/.test(text)
    ? "high"
    : /\b(friday|tomorrow|review|confirm)\b/.test(text)
      ? "medium"
      : "low";
  const risk = blocked ? "high" : sender.trusted === true ? "low" : "medium";
  const intentAllowed = policy.allowed_intents.length === 0 || policy.allowed_intents.includes(intent);
  const replyable = !blocked && intentAllowed;
  return {
    message_id: message.id,
    intent,
    priority,
    risk,
    replyable,
    reason: blocked
      ? "Message requires human review before any reply."
      : intentAllowed
        ? `${intent} message can be drafted for approval.`
        : `${intent} is outside the allowed reply intents in operator_policy.`,
  };
}

function draftReply(message, classification, policy) {
  const subject = message.subject.toLowerCase().startsWith("re:")
    ? message.subject
    : `Re: ${message.subject}`;
  const body = [
    `Hi,`,
    "",
    `Thanks for the note about "${message.subject}". I reviewed the supplied message and will follow up on the ${classification.intent} item.`,
    "I will confirm the next step after the requested detail is checked.",
    ...(policy.signature ? ["", policy.signature] : []),
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
  return {
    message_id: message.id,
    to: message.from,
    subject,
    body,
  };
}

function renderReport(packet) {
  const lines = [
    "# Inbox Triage",
    "",
    `Decision: ${packet.decision}`,
    "",
    "## Queue",
    ...packet.triage_queue.map((item) => `- ${item.message_id}: ${item.priority} - ${item.next_step} (${item.reason})`),
    "",
    "## Draft",
    packet.draft_reply ? `- ${packet.draft_reply.to}: ${packet.draft_reply.subject}` : "- None.",
    "",
    "## Gate",
    `- ${packet.gated_send_proposal.send_skill}: approval required`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function compareQueue(a, b) {
  return priorityRank(a.priority) - priorityRank(b.priority);
}

function compareClassification(a, b) {
  return priorityRank(a.priority) - priorityRank(b.priority);
}

function priorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 3;
}

function writeArtifacts(outputDir, evidence, report, root) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") return;
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function normalizeObject(value) {
  const parsed = parseMaybeJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => stringValue(entry)).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => stringValue(entry)).filter(Boolean);
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

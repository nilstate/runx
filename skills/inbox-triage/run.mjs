import fs from "node:fs";
import path from "node:path";

const SCHEMA = "runx.inbox.triage.v1";

const inputs = _readInputs();
const skillRoot = process.cwd();
const inboxPacket = _normalizeInboxPacket(inputs.inbox_packet);
const senderMetadata = _objectValue(inputs.sender_metadata ?? {});
const operatorPolicy = _normalizeOperatorPolicy(inputs.operator_policy ?? {});

const packet = _buildTriagePacket({
  objective: _stringValue(inputs.objective) ?? "Triage the bounded inbox packet and draft only gated replies.",
  inboxPacket,
  senderMetadata,
  operatorPolicy,
});
const report = _renderReport(packet);

_writeArtifacts(inputs.output_dir, packet, report, skillRoot);

process.stdout.write(`${JSON.stringify({
  ...packet,
  evidence_json: packet,
  report_md: report,
}, null, 2)}\n`);

function _readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

function _normalizeInboxPacket(value) {
  const parsed = _parseMaybeJson(value);
  const messages = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.messages)
      ? parsed.messages
      : [];
  return {
    packet_id: _stringValue(parsed?.packet_id) ?? "inline-inbox-packet",
    messages: messages
      .filter((message) => message && typeof message === "object" && !Array.isArray(message))
      .map((message, index) => ({
        id: _stringValue(message.id) ?? `message-${index + 1}`,
        received_at: _stringValue(message.received_at) ?? _stringValue(message.timestamp) ?? null,
        from: _stringValue(message.from) ?? _stringValue(message.sender) ?? null,
        subject: _stringValue(message.subject) ?? "",
        body: _stringValue(message.body) ?? _stringValue(message.text) ?? null,
        labels: _stringArray(message.labels),
      })),
  };
}

function _normalizeOperatorPolicy(value) {
  const parsed = _objectValue(value);
  return {
    reply_style: _stringValue(parsed.reply_style) ?? "concise and factual",
    allowed_commitments: _stringArray(parsed.allowed_commitments),
    forbidden_commitments: _stringArray(parsed.forbidden_commitments),
    allowed_topics: _stringArray(parsed.allowed_topics),
    allowed_intents: _stringArray(parsed.allowed_intents),
    blocked_terms: _stringArray(parsed.blocked_terms),
    send_gate: _stringValue(parsed.send_gate) ?? _stringValue(parsed.approval_gate) ?? "send-as.explicit-operator-approval",
    signature: _stringValue(parsed.signature),
    auto_send: parsed.auto_send === true,
  };
}

function _buildTriagePacket({ objective, inboxPacket, senderMetadata, operatorPolicy }) {
  const base = {
    schema: SCHEMA,
    decision: "ready",
    objective,
    inbox_packet: {
      packet_id: inboxPacket.packet_id,
      message_count: inboxPacket.messages.length,
    },
    classification: [],
    triage_queue: [],
    draft_reply: null,
    gated_send_proposal: {
      requires_approval: true,
      approval_gate: operatorPolicy.send_gate,
      proposed_channel: "email",
      to: null,
      subject: null,
      body_ref: null,
      status: "not_proposed",
      reason: "No safe draft has been selected yet.",
    },
    stop_conditions: [],
  };

  if (operatorPolicy.auto_send) {
    return {
      ...base,
      decision: "refused",
      stop_conditions: [{
        field: "operator_policy.auto_send",
        reason: "inbox-triage never sends automatically; outbound work must go through the send-as approval gate.",
      }],
    };
  }

  if (inboxPacket.messages.length === 0) {
    return {
      ...base,
      decision: "needs_more_evidence",
      stop_conditions: [{
        field: "inbox_packet.messages",
        reason: "At least one bounded message is required.",
      }],
    };
  }

  const missingEvidence = _missingMessageEvidence(inboxPacket.messages, senderMetadata);
  if (missingEvidence.length > 0) {
    return {
      ...base,
      decision: "needs_more_evidence",
      stop_conditions: missingEvidence,
    };
  }

  for (const message of inboxPacket.messages) {
    const sender = _senderFacts(message, senderMetadata);
    const classification = _classifyMessage(message, sender, operatorPolicy);
    base.classification.push(classification);
    base.triage_queue.push({
      rank: 0,
      message_id: message.id,
      action: classification.replyable ? "draft_reply_for_operator_review" : "no_reply",
      reason: classification.rationale,
      priority: classification.priority,
    });
  }

  base.triage_queue.sort(_compareQueue);
  base.triage_queue.forEach((item, index) => {
    item.rank = index + 1;
  });

  const target = base.classification
    .filter((entry) => entry.replyable)
    .sort(_compareClassification)[0];
  if (!target) {
    if (base.classification.every((entry) => entry.labels.includes("no_reply"))) {
      return base;
    }
    return {
      ...base,
      decision: "needs_more_evidence",
      stop_conditions: [{
        field: "replyable_message",
        reason: "No supplied message passed reply safety checks.",
      }],
    };
  }

  const commitmentStop = _draftCommitmentStop(operatorPolicy);
  if (commitmentStop) {
    return {
      ...base,
      decision: "needs_more_evidence",
      stop_conditions: [commitmentStop],
    };
  }

  const targetMessage = inboxPacket.messages.find((message) => message.id === target.message_id);
  base.draft_reply = _draftReply(targetMessage, target, operatorPolicy);
  base.gated_send_proposal = {
    requires_approval: true,
    approval_gate: operatorPolicy.send_gate,
    proposed_channel: "email",
    to: targetMessage.from,
    subject: base.draft_reply.subject,
    body_ref: `draft_reply.${targetMessage.id}`,
    status: "proposed_not_sent",
    reason: "Draft is ready only for send-as or human approval; no outbound effect occurred.",
  };
  return base;
}

function _missingMessageEvidence(messages, senderMetadata) {
  const missing = [];
  for (const message of messages) {
    if (!message.from) {
      missing.push({
        message_id: message.id,
        field: "from",
        reason: "Sender is required before a reply can be drafted.",
      });
    }
    if (message.from && !_hasSenderMetadata(message, senderMetadata)) {
      missing.push({
        message_id: message.id,
        field: "sender_metadata",
        reason: "Known sender metadata is required for bounded reply authority.",
      });
    }
    if (!message.body) {
      missing.push({
        message_id: message.id,
        field: "body",
        reason: "Body is required; subject-only replies are not safe.",
      });
    }
  }
  return missing;
}

function _classifyMessage(message, sender, policy) {
  const text = _normalizeText(`${message.subject} ${message.body} ${message.labels.join(" ")}`);
  const blockedBySender = sender.blocked === true;
  const blockedByPolicy = policy.blocked_terms.some((term) => text.includes(_normalizeText(term)));
  const sensitive = /\b(password|credential|wire transfer|gift card|private key|seed phrase)\b/u.test(text);
  const financial = /\b(payment|invoice|account details|billing|refund|receipt)\b/u.test(text);
  const timeSensitive = /\b(today|urgent|asap|before|deadline|blocked)\b/u.test(text);
  const digest = /\b(digest|newsletter|weekly links)\b/u.test(text) || message.from?.startsWith("noreply@");
  const intent = financial
    ? "finance"
    : /\b(meeting|calendar|schedule)\b/u.test(text)
      ? "calendar"
      : /\b(checklist|review|risk|confirm)\b/u.test(text)
        ? "coordination"
        : digest
          ? "digest"
          : "general";
  const labels = [
    digest ? "no_reply" : "needs_reply",
    timeSensitive ? "time_sensitive" : null,
    financial ? "finance" : null,
    sensitive || blockedBySender || blockedByPolicy ? "unsafe" : null,
    digest ? "digest" : null,
  ].filter(Boolean);
  const intentAllowed = _intentAllowed(intent, policy);
  const topicAllowed = _topicAllowed(text, sender, policy);
  const replyable = !digest && !sensitive && !blockedBySender && !blockedByPolicy && intentAllowed && topicAllowed;
  const priority = sensitive || timeSensitive ? "high" : digest ? "low" : "medium";
  const rationale = replyable
    ? `${intent} message can be drafted for approval from supplied context.`
    : digest
      ? "Automated digest or newsletter with no requested action."
      : !intentAllowed
        ? "Operator policy does not allow drafting for this intent."
        : !topicAllowed
          ? "Message falls outside the supplied sender or operator topic bounds."
          : "Message requires human review before drafting.";
  return {
    message_id: message.id,
    labels,
    intent,
    priority,
    risk: sensitive || blockedBySender || blockedByPolicy ? "high" : sender.trusted === true ? "low" : "medium",
    replyable,
    rationale,
  };
}

function _draftReply(message, classification, policy) {
  const subject = /^re:/iu.test(message.subject) ? message.subject : `Re: ${message.subject}`;
  const body = [
    "Thanks for the note.",
    `I have the supplied context for "${message.subject}" and will treat it as a ${classification.intent} item.`,
    "I will send the final update only after the operator confirms the status and approves the send-as handoff.",
    "I will avoid marking anything final until that review is complete.",
    policy.signature ? `\n${policy.signature}` : null,
  ].filter(Boolean).join("\n");
  return {
    message_id: message.id,
    subject,
    body,
    citations: [
      `${message.id} subject/body supplied in inbox_packet`,
      "operator_policy requires explicit send gate",
      "inbox-triage safety bar forbids automatic sending",
    ],
  };
}

function _draftCommitmentStop(policy) {
  const draftCommitments = [
    "acknowledge receipt",
    "promise a later human-confirmed update",
  ];
  if (policy.allowed_commitments.length > 0) {
    const missingAllowed = draftCommitments.filter((commitment) =>
      !policy.allowed_commitments.map(_normalizeText).includes(_normalizeText(commitment)));
    if (missingAllowed.length > 0) {
      return {
        field: "operator_policy.allowed_commitments",
        reason: `Draft requires allowed commitments: ${missingAllowed.join(", ")}.`,
      };
    }
  }

  const draftText = _normalizeText([
    "Thanks for the note.",
    "I have the supplied context and will treat it as the classified item.",
    "I will send the final update only after the operator confirms the status and approves the send-as handoff.",
    "I will avoid marking anything final until that review is complete.",
  ].join(" "));
  const forbidden = policy.forbidden_commitments.find((commitment) =>
    draftText.includes(_normalizeText(commitment)));
  if (forbidden) {
    return {
      field: "operator_policy.forbidden_commitments",
      reason: `Draft would conflict with forbidden commitment: ${forbidden}.`,
    };
  }

  return null;
}

function _renderReport(packet) {
  const lines = [
    "# Inbox Triage Report",
    "",
    `Decision: ${packet.decision}`,
    `Messages: ${packet.inbox_packet.message_count}`,
    "",
    "## Classification",
    ...packet.classification.map((entry) =>
      `- ${entry.message_id}: ${entry.labels.join(", ")}; ${entry.priority}; ${entry.rationale}`),
    "",
    "## Queue",
    ...packet.triage_queue.map((item) =>
      `- ${item.rank}. ${item.message_id}: ${item.action} (${item.reason})`),
    "",
    "## Draft",
    packet.draft_reply
      ? `- ${packet.draft_reply.subject}: ${packet.draft_reply.body.replace(/\n/g, " ")}`
      : "- No draft produced.",
    "",
    "## Send Gate",
    `- ${packet.gated_send_proposal.status}: ${packet.gated_send_proposal.approval_gate}`,
    "",
    "## Stop Conditions",
    ...(packet.stop_conditions.length > 0
      ? packet.stop_conditions.map((condition) => `- ${condition.field}: ${condition.reason}`)
      : ["- None."]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function _writeArtifacts(outputDir, evidence, report, root) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") return;
  const resolved = path.resolve(root, outputDir);
  _ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function _senderFacts(message, senderMetadata) {
  return _objectValue(senderMetadata[message.from] ?? senderMetadata[message.id] ?? {});
}

function _hasSenderMetadata(message, senderMetadata) {
  return Boolean(senderMetadata[message.from] ?? senderMetadata[message.id]);
}

function _intentAllowed(intent, policy) {
  if (policy.allowed_intents.length === 0) return true;
  return policy.allowed_intents.includes(intent);
}

function _topicAllowed(text, sender, policy) {
  const topics = [
    ..._stringArray(sender.allowed_topics),
    ...policy.allowed_topics,
  ].map((topic) => _normalizeText(topic)).filter(Boolean);
  if (topics.length === 0) return true;
  return topics.some((topic) => text.includes(topic));
}

function _compareQueue(left, right) {
  return _priorityRank(left.priority) - _priorityRank(right.priority)
    || left.message_id.localeCompare(right.message_id);
}

function _compareClassification(left, right) {
  return _priorityRank(left.priority) - _priorityRank(right.priority)
    || left.message_id.localeCompare(right.message_id);
}

function _priorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 3;
}

function _parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function _objectValue(value) {
  const parsed = _parseMaybeJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function _stringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => _stringValue(entry)).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => _stringValue(entry)).filter(Boolean);
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

function _stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function _normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function _ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

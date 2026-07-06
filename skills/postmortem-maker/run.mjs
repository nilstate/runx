import fs from "node:fs";

const inputs = readInputs();
const timeline = arrayValue(inputs.incident_timeline, "incident_timeline");
const alerts = arrayValue(inputs.alerts ?? [], "alerts");
const deployEvents = arrayValue(inputs.deploy_events ?? [], "deploy_events");
const chatNotes = arrayValue(inputs.chat_notes ?? [], "chat_notes");
const policy = objectValue(inputs.postmortem_policy, "postmortem_policy");

if (timeline.length === 0) {
  fail("incident_timeline must contain at least one event");
}

const evidenceIds = collectEvidenceIds(timeline, alerts, deployEvents, chatNotes);
const normalizedTimeline = timeline.map((event, index) => normalizeTimelineEvent(event, index));
const missingTimelineEvidence = normalizedTimeline.filter((event) => event.evidence_refs.length === 0);
const conflictSignals = findConflictSignals({ alerts, deployEvents, chatNotes });
const impact = buildImpact(alerts, normalizedTimeline);
const rootCause = buildRootCause({ deployEvents, chatNotes, conflictSignals });
const evidenceBarMet = !policy.require_evidence_refs || missingTimelineEvidence.length === 0;
const publishAllowed = policy.publish_allowed === true;
const insufficient = !evidenceBarMet || conflictSignals.length > 0 || (alerts.length === 0 && deployEvents.length !== 1);
const status = insufficient ? "refused_insufficient_evidence" : "publishable_with_hypothesis";

const unknowns = buildUnknowns({
  alerts,
  deployEvents,
  chatNotes,
  missingTimelineEvidence,
  conflictSignals,
  insufficient,
});

const postmortem = {
  summary: buildSummary({ normalizedTimeline, deployEvents, insufficient }),
  timeline: normalizedTimeline,
  impact,
  root_cause: insufficient
    ? {
        status: "unknown",
        claim: "No root-cause claim can be made from the supplied evidence.",
        evidence_refs: [],
      }
    : rootCause,
  status,
};

const actionItems = buildActionItems({ deployEvents, chatNotes, insufficient, policy, evidenceIds });
const publishProposal = buildPublishProposal({ publishAllowed, insufficient, evidenceBarMet, status });

process.stdout.write(`${JSON.stringify({
  postmortem,
  unknowns,
  action_items: actionItems,
  publish_proposal: publishProposal,
}, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    incident_timeline: parseInputValue(process.env.RUNX_INPUT_INCIDENT_TIMELINE),
    alerts: parseInputValue(process.env.RUNX_INPUT_ALERTS),
    deploy_events: parseInputValue(process.env.RUNX_INPUT_DEPLOY_EVENTS),
    chat_notes: parseInputValue(process.env.RUNX_INPUT_CHAT_NOTES),
    postmortem_policy: parseInputValue(process.env.RUNX_INPUT_POSTMORTEM_POLICY),
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

function normalizeTimelineEvent(event, index) {
  const item = objectValue(event, `incident_timeline[${index}]`);
  const id = stringValue(item.id) ?? `timeline-${index + 1}`;
  const evidenceRefs = [];
  const explicitRef = stringValue(item.evidence_ref);
  if (explicitRef) evidenceRefs.push(explicitRef);
  else if (id) evidenceRefs.push(id);
  return {
    at: stringValue(item.at) ?? "unknown",
    event: stringValue(item.event) ?? "Unspecified incident event.",
    evidence_refs: unique(evidenceRefs),
  };
}

function collectEvidenceIds(timeline, alerts, deployEvents, chatNotes) {
  return new Set([
    ...timeline.map((item) => stringValue(item?.id)),
    ...timeline.map((item) => stringValue(item?.evidence_ref)),
    ...alerts.map((item) => stringValue(item?.id)),
    ...deployEvents.map((item) => stringValue(item?.id)),
    ...chatNotes.map((item) => stringValue(item?.id)),
  ].filter(Boolean));
}

function findConflictSignals({ alerts, deployEvents, chatNotes }) {
  const signals = [];
  if (deployEvents.length > 1 && alerts.length === 0) {
    signals.push("multiple deploy candidates without alert or metric evidence");
  }
  const suspected = chatNotes
    .map((note) => normalize(stringValue(note.note)))
    .filter((note) => note.includes("suspect") || note.includes("suspected"));
  if (suspected.length > 1 && deployEvents.length > 1) {
    signals.push("conflicting operator hypotheses without supporting evidence");
  }
  return signals;
}

function buildImpact(alerts, normalizedTimeline) {
  if (alerts.length > 0) {
    return {
      user_visible: summarize(alerts.map((alert) => stringValue(alert.message)).filter(Boolean).join(" ")) || "Service impact is supported by alert evidence.",
      evidence_refs: alerts.map((alert) => stringValue(alert.id)).filter(Boolean),
    };
  }
  return {
    user_visible: "unknown",
    evidence_refs: normalizedTimeline.flatMap((event) => event.evidence_refs).slice(0, 2),
  };
}

function buildRootCause({ deployEvents, chatNotes, conflictSignals }) {
  if (deployEvents.length === 1 && conflictSignals.length === 0) {
    const deploy = deployEvents[0];
    const service = stringValue(deploy.service) ?? "the affected service";
    const version = stringValue(deploy.version) ?? "the referenced deploy";
    const change = stringValue(deploy.change) ?? "the deploy change";
    return {
      status: "hypothesis",
      claim: `${change} in ${service} ${version} likely contributed to the incident and needs confirmation against metrics.`,
      evidence_refs: unique([stringValue(deploy.id), ...chatNotes.map((note) => stringValue(note.id))].filter(Boolean)),
    };
  }
  return {
    status: "unknown",
    claim: "The supplied evidence does not isolate a single root cause.",
    evidence_refs: [],
  };
}

function buildUnknowns({ alerts, deployEvents, chatNotes, missingTimelineEvidence, conflictSignals, insufficient }) {
  const unknowns = [];
  if (alerts.length === 0) unknowns.push("No alert source or measurable impact was provided.");
  if (missingTimelineEvidence.length > 0) unknowns.push("Some timeline entries lack explicit evidence references.");
  for (const signal of conflictSignals) unknowns.push(sentenceCase(signal));
  if (deployEvents.length > 0 && chatNotes.length === 0) unknowns.push("No operator notes were supplied to explain the deploy relationship.");
  if (insufficient) unknowns.push("Publication would overstate the known facts without more evidence.");
  if (unknowns.length === 0) {
    unknowns.push("The root cause remains a hypothesis until confirmed by service metrics.");
  }
  return unique(unknowns);
}

function buildActionItems({ deployEvents, chatNotes, insufficient, policy }) {
  if (insufficient) {
    return [{
      owner: "incident-commander",
      action: "Attach alert data, service metrics, and one supported root-cause trail before publishing a postmortem.",
      evidence_refs: deployEvents.map((deploy) => stringValue(deploy.id)).filter(Boolean).slice(0, 2),
    }];
  }
  const primaryDeploy = deployEvents[0];
  const deployRef = stringValue(primaryDeploy?.id);
  const noteRef = stringValue(chatNotes[0]?.id);
  const items = [{
    owner: stringValue(primaryDeploy?.service) ?? "service-owner",
    action: "Add a regression check for the incident-linked deploy or configuration path.",
    evidence_refs: deployRef ? [deployRef] : [],
  }];
  if (policy.require_action_items !== false) {
    items.push({
      owner: "sre",
      action: "Add or review dashboards that expose the incident impact signal during future events.",
      evidence_refs: noteRef ? [noteRef] : [],
    });
  }
  return items;
}

function buildPublishProposal({ publishAllowed, insufficient, evidenceBarMet, status }) {
  if (!publishAllowed || insufficient || !evidenceBarMet) {
    return {
      proposed: false,
      channel: null,
      gated: true,
      reason: "Publication is not proposed until policy and evidence requirements are met.",
    };
  }
  return {
    proposed: true,
    channel: "postmortem_doc",
    gated: true,
    reason: `Policy allows publication and the packet status is ${status}; a human still must approve publishing.`,
  };
}

function buildSummary({ normalizedTimeline, deployEvents, insufficient }) {
  if (insufficient) return "The input packet is insufficient for a publishable postmortem.";
  const first = normalizedTimeline[0]?.event ?? "The incident began";
  const last = normalizedTimeline[normalizedTimeline.length - 1]?.event ?? "the incident recovered";
  const deploy = deployEvents[0];
  const version = stringValue(deploy?.version);
  return summarize(version ? `${first} The evidence points to deploy ${version} as a hypothesis; ${last}` : `${first} ${last}`);
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function summarize(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function sentenceCase(value) {
  const text = String(value ?? "").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : text;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

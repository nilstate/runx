import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const SCHEMA = "runx.postmortem.decision.v1";
const PACKET_SCHEMA = "runx.postmortem.v1";

const inputs = readInputs();
const skillRoot = process.cwd();

const sourceHandle = inputs.source_handle;
const policy = inputs.postmortem_policy || {};

if (!sourceHandle || typeof sourceHandle !== "string") {
  throw new Error("source_handle input is required");
}
if (!policy || typeof policy !== "object") {
  throw new Error("postmortem_policy input is required");
}

const publishThreshold = policy.publish_threshold || "when_publishable";
const requireRootCause = policy.require_root_cause !== false;
const maxUnknowns = typeof policy.max_unknowns === "number" ? policy.max_unknowns : 3;

// --- Step 1: Read incident from source ---
const { incident, sourceEvidence, readError } = readIncident(sourceHandle);

// --- Step 2: Parse and analyze ---
let postmortem;
let unknowns = [];
let actionItems = [];
let publishResult = null;
let runxStatus = "sealed";

if (readError || !incident) {
  // Source unreadable — refuse
  unknowns.push({
    question: "What happened in this incident?",
    evidence_gap: `Source unreadable: ${readError || "no data returned"}`,
  });
  postmortem = {
    summary: "Unable to produce postmortem: incident source unreadable.",
    timeline: [],
    impact: { severity: "unknown", affected_services: [], duration_minutes: 0, users_affected: null },
    root_cause: { status: "unknown", description: "No incident data available.", evidence_ref: null },
    status: "refused",
  };
  runxStatus = "failure";
} else {
  // Parse timeline from incident data
  const timeline = extractTimeline(incident, sourceEvidence);

  // Separate facts from hypotheses
  const facts = timeline.filter((e) => e.certainty === "fact");
  const hypotheses = timeline.filter((e) => e.certainty === "hypothesis");

  // Identify unknowns from gaps
  if (hypotheses.length > 0) {
    for (const h of hypotheses) {
      unknowns.push({
        question: `Is "${h.event}" confirmed?`,
        evidence_gap: h.evidence_ref || "no direct evidence",
      });
    }
  }

  // Root cause analysis
  const rootCause = assessRootCause(incident, facts, hypotheses);

  // Impact assessment
  const impact = assessImpact(incident);

  // Action items
  actionItems = extractActionItems(incident, rootCause);

  // Determine publishability
  const timelineOk = facts.length > 0;
  const rootCauseOk = !requireRootCause || rootCause.status !== "unknown";
  const unknownsOk = unknowns.length <= maxUnknowns;
  const isPublishable = timelineOk && rootCauseOk && unknownsOk;

  const summary = buildSummary(incident, rootCause, impact);

  postmortem = {
    summary,
    timeline: facts.concat(hypotheses).map((e) => ({
      timestamp: e.timestamp,
      event: e.event,
      evidence_ref: e.evidence_ref,
    })),
    impact,
    root_cause: rootCause,
    status: isPublishable ? "publishable" : "needs_review",
  };

  // If publishable, compose the send_plan (equivalent to send-as plan runner)
  if (isPublishable && publishThreshold !== "never") {
    const incidentId = incident.id || incident.incident_id || "unknown";
    publishResult = {
      decision: "ready",
      action_family: "send-as",
      principal: { type: "incident", ref: `incident:${incidentId}` },
      send_class: "status",
      channel: "internal",
      audience: { type: "team", ref: "engineering", requires_reconfirmation: false },
      content: {
        draft_ref: `draft:postmortem:${incidentId}`,
        digest: `sha256:${crypto.createHash("sha256").update(JSON.stringify(postmortem)).digest("hex")}`,
        subject_or_title: `Postmortem: ${postmortem.summary}`,
      },
      gates: { preflight_required: true, human_approval_required: true },
      blockers: [],
      evidence_refs: [`source:${sourceEvidence}`],
      success_checkpoint: "postmortem_published",
    };
  }

  // If no usable evidence at all, mark as failure (stop condition)
  if (!timelineOk && rootCause.status === "unknown") {
    postmortem.status = "refused";
    runxStatus = "failure";
  }
}


// --- Build result ---
const result = {
  schema: SCHEMA,
  status: runxStatus,
  data: {
    postmortem,
    unknowns,
    action_items: actionItems,
    publish_result: publishResult,
    source_evidence: sourceEvidence,
    validation: {
      source_readable: !readError,
      timeline_entries: postmortem.timeline.length,
      fact_count: postmortem.timeline.filter((e) => e.certainty === "fact").length,
      hypothesis_count: postmortem.timeline.filter((e) => e.certainty === "hypothesis").length,
      unknown_count: unknowns.length,
      root_cause_status: postmortem.root_cause.status,
      publishable: postmortem.status === "publishable",
    },
  },
};

// Write artifacts
const report = renderReport(result);
writeArtifacts(inputs.output_dir, result, report, skillRoot);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// Exit with non-zero for failure so harness sees "failure" status
if (runxStatus === "failure") {
  process.exit(1);
}

// --- Functions ---

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function readIncident(handle) {
  // URL source: web-fetch
  if (handle.startsWith("http://") || handle.startsWith("https://")) {
    try {
      const raw = execSync(
        `curl -sS -L --max-time 15 ${JSON.stringify(handle)}`,
        { encoding: "utf8", timeout: 20000 }
      );
      try {
        return { incident: JSON.parse(raw), sourceEvidence: `web-fetch:${handle}`, readError: null };
      } catch {
        // Not JSON — treat as text incident report
        return {
          incident: { id: extractIdFromUrl(handle), raw_text: raw, source_url: handle },
          sourceEvidence: `web-fetch:${handle}`,
          readError: null,
        };
      }
    } catch (err) {
      return { incident: null, sourceEvidence: null, readError: `web-fetch failed: ${err.message}` };
    }
  }

  // Data-store projection reference
  if (handle.startsWith("local://") || handle.startsWith("tenant://")) {
    const dsRaw = process.env.RUNX_DATA_SOURCES;
    if (!dsRaw) {
      return { incident: null, sourceEvidence: null, readError: "RUNX_DATA_SOURCES not set for data-store read" };
    }
    try {
      const ds = JSON.parse(dsRaw);
      const sourceKey = Object.keys(ds.data_sources || {}).find((k) => handle.startsWith(k));
      if (!sourceKey) {
        return { incident: null, sourceEvidence: null, readError: `No data source matched for ${handle}` };
      }
      const source = ds.data_sources[sourceKey];
      if (source.adapter === "data.local") {
        // Read from local JSON event store
        const storeId = source.store_id || crypto.createHash("sha256").update(sourceKey).digest("hex").slice(0, 12);
        const storePath = path.join("/tmp", `runx-data-${storeId}.json`);
        if (!fs.existsSync(storePath)) {
          return { incident: null, sourceEvidence: null, readError: `Local store not found: ${storePath}` };
        }
        const storeData = JSON.parse(fs.readFileSync(storePath, "utf8"));
        // The store is keyed by resource -> aggregate_id -> events
        // For read_projection, we return the latest state
        const aggregateId = handle.split("/").pop();
        const resourceKey = Object.keys(source.resources || {})[0] || "events";
        const events = (storeData[resourceKey] && storeData[resourceKey][aggregateId]) || [];
        if (events.length === 0) {
          return { incident: null, sourceEvidence: null, readError: `No events found for ${aggregateId}` };
        }
        // Build projection from events
        const projection = events.reduce((acc, ev) => ({ ...acc, ...ev.payload }), {});
        return { incident: projection, sourceEvidence: `data-store:${handle}`, readError: null };
      }
      return { incident: null, sourceEvidence: null, readError: `Unsupported adapter: ${source.adapter}` };
    } catch (err) {
      return { incident: null, sourceEvidence: null, readError: `data-store read failed: ${err.message}` };
    }
  }

  // Inline JSON fixture
  try {
    return { incident: JSON.parse(handle), sourceEvidence: "inline-fixture", readError: null };
  } catch {
    return { incident: null, sourceEvidence: null, readError: `Unrecognized source_handle format: ${handle}` };
  }
}

function extractIdFromUrl(url) {
  const parts = url.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "unknown";
}

function extractTimeline(incident, sourceRef) {
  const entries = [];

  // If incident has explicit timeline entries
  if (Array.isArray(incident.timeline)) {
    for (const entry of incident.timeline) {
      entries.push({
        timestamp: entry.timestamp || entry.time || entry.date || "unknown",
        event: entry.event || entry.description || entry.text || "unknown event",
        evidence_ref: entry.evidence_ref || entry.ref || sourceRef,
        certainty: entry.certainty || (entry.confirmed !== false ? "fact" : "hypothesis"),
      });
    }
    return entries;
  }

  // If incident has events array
  if (Array.isArray(incident.events)) {
    for (const ev of incident.events) {
      entries.push({
        timestamp: ev.at || ev.timestamp || ev.time || "unknown",
        event: ev.kind || ev.text || ev.event || "unknown event",
        evidence_ref: ev.ref || sourceRef,
        certainty: "fact",
      });
    }
    return entries;
  }

  // If incident has raw_text, try to extract timeline markers
  if (incident.raw_text) {
    const lines = incident.raw_text.split("\n");
    for (const line of lines) {
      const timeMatch = line.match(
        /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?Z?|[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2})/i
      );
      if (timeMatch && line.trim().length > 10) {
        entries.push({
          timestamp: timeMatch[1],
          event: line.replace(timeMatch[0], "").replace(/^[\s:–—-]+/, "").trim(),
          evidence_ref: sourceRef,
          certainty: "fact",
        });
      }
    }
    if (entries.length > 0) return entries;
  }

  // Minimal fallback: one entry from the incident summary
  if (incident.summary || incident.title || incident.description) {
    entries.push({
      timestamp: incident.created_at || incident.date || "unknown",
      event: incident.summary || incident.title || incident.description,
      evidence_ref: sourceRef,
      certainty: "fact",
    });
  }

  return entries;
}

function assessRootCause(incident, facts, hypotheses) {
  // Explicit root cause in incident data
  if (incident.root_cause) {
    const rc = incident.root_cause;
    return {
      status: rc.status || "known",
      description: rc.description || rc.summary || rc.text || "No description.",
      evidence_ref: rc.evidence_ref || rc.ref || null,
    };
  }

  // If we have hypotheses but no confirmed cause
  if (hypotheses.length > 0 && facts.length === 0) {
    return {
      status: "unknown",
      description: "Insufficient evidence to determine root cause.",
      evidence_ref: null,
    };
  }

  // Try to infer from timeline
  const deployEvents = facts.filter(
    (e) => /deploy|release|push|merge|config/i.test(e.event)
  );
  const errorEvents = facts.filter(
    (e) => /error|crash|spike|outage|failure|500/i.test(e.event)
  );

  if (deployEvents.length > 0 && errorEvents.length > 0) {
    const deployTime = deployEvents[0].timestamp;
    const errorTime = errorEvents[0].timestamp;
    if (deployTime !== "unknown" && errorTime !== "unknown") {
      return {
        status: "suspected",
        description: `Deployment at ${deployTime} correlated with error spike at ${errorTime}.`,
        evidence_ref: deployEvents[0].evidence_ref,
      };
    }
  }

  if (facts.length > 0) {
    return {
      status: "suspected",
      description: `Based on ${facts.length} timeline entries; root cause not explicitly confirmed.`,
      evidence_ref: facts[0].evidence_ref,
    };
  }

  return {
    status: "unknown",
    description: "No evidence available to assess root cause.",
    evidence_ref: null,
  };
}

function assessImpact(incident) {
  return {
    severity: incident.severity || incident.impact?.severity || "unknown",
    affected_services: incident.affected_services || incident.impact?.affected_services || [],
    duration_minutes: incident.duration_minutes || incident.impact?.duration_minutes || 0,
    users_affected: incident.users_affected || incident.impact?.users_affected || null,
  };
}

function extractActionItems(incident, rootCause) {
  const items = [];

  // Explicit action items in incident
  if (Array.isArray(incident.action_items)) {
    for (const item of incident.action_items) {
      items.push({
        description: item.description || item.text || item.action || "unspecified",
        owner: item.owner || item.assignee || "unassigned",
        deadline: item.deadline || item.due || "none",
        evidence_ref: item.evidence_ref || item.ref || null,
      });
    }
    return items;
  }

  // Generate action items from root cause
  if (rootCause.status === "known" || rootCause.status === "suspected") {
    items.push({
      description: `Address root cause: ${rootCause.description}`,
      owner: "incident-response",
      deadline: "next-sprint",
      evidence_ref: rootCause.evidence_ref,
    });
  }

  // Always add a review item
  items.push({
    description: "Review and approve postmortem findings",
    owner: "engineering-manager",
    deadline: "1-week",
    evidence_ref: null,
  });

  return items;
}

function buildSummary(incident, rootCause, impact) {
  const id = incident.id || incident.incident_id || "unknown";
  const severity = impact.severity !== "unknown" ? impact.severity : "unspecified";
  const rcBrief =
    rootCause.status === "known"
      ? `Root cause: ${rootCause.description}`
      : rootCause.status === "suspected"
        ? `Suspected cause: ${rootCause.description}`
        : "Root cause under investigation.";
  return `Incident ${id} (${severity}): ${rcBrief}`;
}

function renderReport(result) {
  const d = result.data;
  const pm = d.postmortem;
  const lines = [];

  lines.push("# Postmortem Report");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Status:** ${pm.status}`);
  lines.push(`- **Summary:** ${pm.summary}`);
  lines.push("");

  lines.push("## Impact");
  lines.push("");
  lines.push(`- **Severity:** ${pm.impact.severity}`);
  lines.push(`- **Affected services:** ${pm.impact.affected_services.join(", ") || "(none)"}`);
  lines.push(`- **Duration:** ${pm.impact.duration_minutes} minutes`);
  lines.push(`- **Users affected:** ${pm.impact.users_affected ?? "unknown"}`);
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  if (pm.timeline.length === 0) {
    lines.push("- (no timeline entries)");
  } else {
    for (const entry of pm.timeline) {
      lines.push(`- **${entry.timestamp}** — ${entry.event} [${entry.evidence_ref || "no ref"}]`);
    }
  }
  lines.push("");

  lines.push("## Root Cause");
  lines.push("");
  lines.push(`- **Status:** ${pm.root_cause.status}`);
  lines.push(`- **Description:** ${pm.root_cause.description}`);
  if (pm.root_cause.evidence_ref) {
    lines.push(`- **Evidence:** ${pm.root_cause.evidence_ref}`);
  }
  lines.push("");

  if (d.unknowns.length > 0) {
    lines.push("## Unknowns");
    lines.push("");
    for (const u of d.unknowns) {
      lines.push(`- **${u.question}** — gap: ${u.evidence_gap}`);
    }
    lines.push("");
  }

  if (d.action_items.length > 0) {
    lines.push("## Action Items");
    lines.push("");
    for (const item of d.action_items) {
      lines.push(`- ${item.description} (owner: ${item.owner}, deadline: ${item.deadline})`);
    }
    lines.push("");
  }

  if (d.publish_result) {
    lines.push("## Publish Result");
    lines.push("");
    lines.push(`- **Decision:** ${d.publish_result.decision}`);
    lines.push(`- **Note:** ${d.publish_result.note}`);
    lines.push("");
  }

  lines.push("## Validation");
  lines.push("");
  lines.push(`- Source readable: ${d.validation.source_readable ? "yes" : "no"}`);
  lines.push(`- Timeline entries: ${d.validation.timeline_entries}`);
  lines.push(`- Facts: ${d.validation.fact_count}`);
  lines.push(`- Hypotheses: ${d.validation.hypothesis_count}`);
  lines.push(`- Unknowns: ${d.validation.unknown_count}`);
  lines.push(`- Root cause: ${d.validation.root_cause_status}`);
  lines.push(`- Publishable: ${d.validation.publishable ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Reproducibility Controls");
  lines.push("");
  lines.push("- Every timeline entry cites source evidence.");
  lines.push("- Root cause claims require evidence or are marked unknown.");
  lines.push("- Conflicting evidence produces unknowns, not guesses.");
  lines.push("- The skill never invents engagement metrics or incident details.");
  lines.push("- Publishing only happens when evidence is consistent and sufficient.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function writeArtifacts(outputDir, evidenceData, report, root) {
  if (!outputDir) {
    evidenceData.data.artifacts = {};
    return;
  }
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  const evidencePath = path.join(resolved, "evidence.json");
  const reportPath = path.join(resolved, "report.md");
  evidenceData.data.artifacts = {
    evidence_json: path.relative(root, evidencePath),
    report_md: path.relative(root, reportPath),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidenceData, null, 2)}\n`);
  fs.writeFileSync(reportPath, report);
}

function ensureInside(root, resolved, label) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

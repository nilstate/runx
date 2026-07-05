import fs from "node:fs";

// ---------------------------------------------------------------------------
// Read inputs
// ---------------------------------------------------------------------------

const inputs = readInputs();

const queue = objectValue(inputs.queue, "queue");
const context = inputs.context ? objectValue(inputs.context, "context") : {};
const policy = inputs.escalation_policy ? objectValue(inputs.escalation_policy, "escalation_policy") : {};

// ---------------------------------------------------------------------------
// Validate queue structure
// ---------------------------------------------------------------------------

const snapshotAt = stringValue(queue.snapshot_at);
if (!snapshotAt) fail("queue.snapshot_at is required (ISO 8601 timestamp)");

const snapshotMs = parseIso(snapshotAt);
if (snapshotMs === null) fail("queue.snapshot_at must be a valid ISO 8601 timestamp");

const ticketsRaw = queue.tickets;
if (!Array.isArray(ticketsRaw)) fail("queue.tickets must be an array");
if (ticketsRaw.length === 0) fail("queue.tickets is empty — nothing to monitor");

// ---------------------------------------------------------------------------
// Escalation policy defaults
// ---------------------------------------------------------------------------

const clusterMinTickets = intPolicy(policy.cluster_min_tickets, 3);
const severityTrendMinDelta = intPolicy(policy.severity_trend_min_delta, 2);
const staleAfterHours = numPolicy(policy.stale_after_hours, 48);
const confidenceThreshold = numPolicy(policy.confidence_threshold, 0.6);

const product = stringValue(context.product);
const team = stringValue(context.team);

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "is",
  "are", "was", "were", "be", "been", "being", "with", "at", "by", "from",
  "this", "that", "it", "as", "not", "no", "do", "does", "did", "has", "have",
  "had", "i", "we", "you", "they", "he", "she", "my", "our", "your", "me",
  "when", "where", "how", "what", "why", "who", "can", "cannot", "cant",
  "could", "would", "should", "will", "shall", "may", "might", "must",
  "get", "got", "getting", "try", "trying", "tried", "please", "help",
  "issue", "problem", "error", "bug", "wrong", "broken",
]);

// ---------------------------------------------------------------------------
// Regulated-action guard: skip tickets that require a stronger authority gate
// ---------------------------------------------------------------------------

const REGULATED_SIGNALS = [
  "refund", "cancel my subscription", "delete my account", "delete my data",
  "password reset", "reset my password", "data export", "export my data",
  "change my billing", "credit card", "pci", "hipaa", "gdpr",
  "right to be forgotten", "close my account",
];

// ---------------------------------------------------------------------------
// Parse and validate tickets
// ---------------------------------------------------------------------------

const validTickets = [];
let invalidCount = 0;
let regulatedCount = 0;

for (const raw of ticketsRaw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalidCount++;
    continue;
  }
  const ticketId = stringValue(raw.ticket_id);
  const subject = stringValue(raw.subject);
  const severity = normalizeSeverity(raw.severity);
  const createdAt = stringValue(raw.created_at);
  const status = stringValue(raw.status) || "open";

  if (!ticketId || !subject || !severity || !createdAt) {
    invalidCount++;
    continue;
  }

  const createdMs = parseIso(createdAt);
  if (createdMs === null) {
    invalidCount++;
    continue;
  }

  const normalizedSubject = normalize(subject);
  const regulatedHit = REGULATED_SIGNALS.find((s) => normalizedSubject.includes(s));
  if (regulatedHit) {
    // Regulated tickets are out of scope — skip, do not cluster or escalate.
    regulatedCount++;
    continue;
  }

  const keywords = keywordSet(normalizedSubject);

  validTickets.push({
    ticket_id: ticketId,
    subject: subject,
    normalized_subject: normalizedSubject,
    keywords: keywords,
    severity: severity,
    severity_rank: SEVERITY_RANK[severity] || 0,
    status: status,
    created_at: createdAt,
    created_ms: createdMs,
    age_hours: Math.max(0, (snapshotMs - createdMs) / 3_600_000),
  });
}

// Stop if every ticket was invalid or regulated — queue is unusable / out of scope
if (validTickets.length === 0) {
  if (regulatedCount > 0 && invalidCount === 0) {
    fail("queue contains only regulated-action tickets — out of scope; a stronger authority gate is required");
  }
  fail("queue has no valid support tickets to monitor (all tickets missing required fields or unparseable)");
}

// ---------------------------------------------------------------------------
// Cluster tickets by signature similarity (Jaccard on keyword sets)
// ---------------------------------------------------------------------------

// Each valid ticket carries a `keywords` Set. Two tickets belong to the same
// cluster when their Jaccard similarity (|A∩B| / |A∪B|) meets SIMILARITY_THRESHOLD.
// We use union-find so that transitive links still group together, while keeping
// weak/accidental overlaps from merging unrelated issues.
const SIMILARITY_THRESHOLD = 0.34;

const clusters = unionFindClusters(validTickets, SIMILARITY_THRESHOLD);

// The cluster signature is the union of member keywords, sorted — a stable
// label that summarizes what the cluster is about.
function labelCluster(tickets) {
  const union = new Set();
  for (const t of tickets) for (const kw of t.keywords) union.add(kw);
  return [...union].sort().join(" ");
}

// ---------------------------------------------------------------------------
// Evaluate each cluster for escalation signals
// ---------------------------------------------------------------------------

const escalations = [];

for (const clusterTickets of clusters) {
  const signature = labelCluster(clusterTickets);
  const sortedByTime = [...clusterTickets].sort((a, b) => a.created_ms - b.created_ms);

  const signals = [];
  let confidence = 0;

  // --- Volume signal ---
  if (clusterTickets.length >= clusterMinTickets) {
    signals.push("volume_signal");
    confidence += 0.4;
  }

  // --- Severity trend signal ---
  const ranks = sortedByTime.map((t) => t.severity_rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const delta = maxRank - minRank;
  const trendingUp = isTrendingUp(ranks);

  if (delta >= severityTrendMinDelta && trendingUp) {
    signals.push("severity_trend_signal");
    confidence += 0.4;
  } else if (delta >= severityTrendMinDelta) {
    // Large spread but not a clean upward trend — weaker signal
    signals.push("severity_trend_signal");
    confidence += 0.25;
  }

  // --- Stale signal ---
  const staleTickets = clusterTickets.filter(
    (t) => t.age_hours > staleAfterHours && isUnresolved(t.status)
  );
  if (staleTickets.length > 0) {
    signals.push("stale_signal");
    confidence += 0.3;
  }

  confidence = Math.min(1, round(confidence));

  // --- Flag if confidence meets threshold and at least one signal ---
  if (signals.length === 0 || confidence < confidenceThreshold) continue;

  const maxSeverity = severityName(maxRank);
  const oldestAgeHours = Math.max(...clusterTickets.map((t) => t.age_hours));
  const ticketIds = sortedByTime.map((t) => t.ticket_id);

  escalations.push({
    "runx.support.firewatch.v1": {
      cluster_signature: signature,
      signals: signals,
      ticket_ids: ticketIds,
      ticket_count: clusterTickets.length,
      max_severity: maxSeverity,
      oldest_ticket_age_hours: round(oldestAgeHours),
      escalation_target: escalationTargetFor(maxSeverity, product),
      recommended_priority: priorityFor(maxSeverity, team),
    },
  });
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

const result = {
  queue_summary: {
    snapshot_at: snapshotAt,
    total_tickets: ticketsRaw.length,
    valid_tickets: validTickets.length,
    invalid_ticket_count: invalidCount,
    regulated_ticket_count: regulatedCount,
    cluster_count: clusters.size,
    escalation_count: escalations.length,
  },
  escalations: escalations,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTrendingUp(ranks) {
  // True if the sequence is non-decreasing OR shows an overall upward jump
  // from the first half to the second half (allows for one plateau/dip).
  if (ranks.length < 2) return false;
  let nonDecreasing = true;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] < ranks[i - 1]) {
      nonDecreasing = false;
      break;
    }
  }
  if (nonDecreasing && ranks[ranks.length - 1] > ranks[0]) return true;

  // Half-jump: average of second half strictly greater than first half
  const mid = Math.floor(ranks.length / 2);
  const firstHalf = ranks.slice(0, mid);
  const secondHalf = ranks.slice(mid);
  if (secondHalf.length === 0) return false;
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  return avgSecond > avgFirst;
}

function isUnresolved(status) {
  const s = String(status || "").toLowerCase().trim();
  const resolved = ["closed", "resolved", "done", "complete", "cancelled", "canceled"];
  return !resolved.includes(s);
}

function severityName(rank) {
  for (const [name, r] of Object.entries(SEVERITY_RANK)) {
    if (r === rank) return name;
  }
  return "unknown";
}

function escalationTargetFor(maxSeverity, product) {
  if (maxSeverity === "urgent" || maxSeverity === "high") return "on-call-engineer";
  if (product) return `${product}-support-lead`;
  return "support-lead";
}

function priorityFor(maxSeverity, team) {
  if (maxSeverity === "urgent") return team === "platform" ? "P1" : "P2";
  if (maxSeverity === "high") return "P2";
  if (maxSeverity === "medium") return "P3";
  return "P4";
}

function keywordSet(normalizedSubject) {
  // Extract content keywords: numbers and alpha tokens, drop stopwords and
  // very short tokens. Returns a Set of unique lowercased keywords used as
  // the clustering feature. Numbers (e.g. "500") are kept because they are
  // strong clustering signals (error codes, status codes).
  const tokens = normalizedSubject
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0)
    .filter((t) => !STOPWORDS.has(t) && t.length > 1);
  return new Set(tokens);
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function unionFindClusters(tickets, threshold) {
  // Union-find over tickets: link two tickets when their keyword Jaccard
  // similarity meets `threshold`. Returns an array of clusters (arrays of
  // tickets). Singletons are kept as their own clusters.
  const parent = tickets.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => { parent[find(a)] = find(b); };

  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      if (jaccard(tickets[i].keywords, tickets[j].keywords) >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < tickets.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(tickets[i]);
  }
  // Sort each cluster's tickets by created time for deterministic output.
  return [...groups.values()].map((g) => g.sort((a, b) => a.created_ms - b.created_ms));
}

function normalizeSeverity(value) {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase().trim();
  if (SEVERITY_RANK[v] !== undefined) return v;
  // Accept some aliases
  if (v === "crit" || v === "critical" || v === "p1" || v === "sev1" || v === "sev-1") return "urgent";
  if (v === "med" || v === "p2" || v === "sev2" || v === "sev-2") return "medium";
  if (v === "p3" || v === "sev3" || v === "sev-3") return "high";
  if (v === "p4" || v === "low" || v === "minor") return "low";
  return null;
}

function parseIso(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  // Reject non-ISO strings (must contain a 'T' or be a plain date)
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Input / utility plumbing
// ---------------------------------------------------------------------------

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    queue: parseInputValue(process.env.RUNX_INPUT_QUEUE),
    context: parseInputValue(process.env.RUNX_INPUT_CONTEXT),
    escalation_policy: parseInputValue(process.env.RUNX_INPUT_ESCALATION_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function normalize(value) { return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim(); }
function round(n) { return Math.round(n * 100) / 100; }
function stringValue(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
function intPolicy(value, def) { return Number.isInteger(value) ? value : (typeof value === "number" ? Math.floor(value) : def); }
function numPolicy(value, def) { return typeof value === "number" && Number.isFinite(value) ? value : def; }
function objectValue(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(name + " must be an object"); return value; }
function fail(message) { process.stderr.write(message + "\n"); process.exit(64); }

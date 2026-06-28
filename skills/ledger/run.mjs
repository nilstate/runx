import fs from "node:fs";
import { spawnSync } from "node:child_process";

// In-sandbox receipt-ledger reader. Shells the shipped `runx history`/`runx
// verify` engine (the one source of truth for the no-body projection and the
// tree-rooted chain verdict) and projects each matched receipt down to an
// id-stub. A `receipts` caller-override input replays a fixed ledger without
// shelling out, mirroring reflect-digest's reflect_projections override, so the
// inline harness is deterministic regardless of the receipt store or binary
// linkage. The reader never writes and never copies a receipt body.

const inputs = readInputs();
const question = stringValue(inputs.question);
const filter = readFilter(inputs.filter);
const proofRequested = readProofRequested(inputs.proof);
const overrideRows = Array.isArray(inputs.receipts) && inputs.receipts.length > 0
  ? inputs.receipts
  : undefined;

const query = {
  principal: filter.principal || "",
  skill_ref: filter.skill_ref || "",
  status: filter.status,
  time_range: {
    from: filter.from || "",
    to: filter.to || "",
  },
};

let packet;
if (!question) {
  // No question bounds the read. The reader is deterministic and always seals,
  // so it reports the stop in the packet rather than deferring to an agent.
  packet = {
    ledger_answer: {
      decision: "needs_agent",
      question: "",
      query,
    },
    matched_receipts: [],
    chain_verification: { checked: false, intact: null, breaks: [] },
    summary: "No audit question was provided, so there is nothing to query against the ledger.",
  };
} else {
  const rows = overrideRows !== undefined ? overrideRows : historyRows(filter);
  const matched = rows.map(projectIdStub).filter((stub) => matchesFilter(stub, filter));

  let chain;
  if (!proofRequested) {
    chain = { checked: false, intact: null, breaks: [] };
  } else if (overrideRows !== undefined) {
    // The override path replays a fixed ledger and does not consult the verify
    // engine, so the chain cannot be proven here. Fail closed: unverified.
    chain = { checked: true, intact: null, breaks: [] };
  } else {
    chain = verifyChain();
  }

  const decision = matched.length === 0 ? "needs_more_evidence" : "answered";
  packet = {
    ledger_answer: {
      decision,
      question,
      query,
    },
    matched_receipts: matched,
    chain_verification: chain,
    summary: renderSummary({ decision, matched, chain, proofRequested, query }),
  };
}

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function readFilter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { principal: null, skill_ref: null, status: [], from: null, to: null, source: null, actor: null };
  }
  const timeRange = value.time_range && typeof value.time_range === "object" ? value.time_range : {};
  const status = Array.isArray(value.status)
    ? value.status.map(String).filter((entry) => entry.trim().length > 0)
    : stringValue(value.status)
      ? [stringValue(value.status)]
      : [];
  return {
    principal: stringValue(value.principal),
    skill_ref: stringValue(value.skill_ref),
    status,
    from: stringValue(timeRange.from),
    to: stringValue(timeRange.to),
    source: stringValue(value.source),
    actor: stringValue(value.actor) || stringValue(value.principal),
  };
}

function readProofRequested(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return value.verify_chain === true;
}

// Shell the shipped `runx history --json` so the no-body projection (store.rs)
// and signature policy stay the one source of truth. Inherits RUNX_RECEIPT_DIR
// from the sandbox env; never re-reads the store with a custom parser.
function historyRows(filter) {
  const args = ["history", "--json"];
  if (filter.skill_ref) args.push("--skill", filter.skill_ref);
  if (filter.status.length === 1) args.push("--status", filter.status[0]);
  if (filter.source) args.push("--source", filter.source);
  if (filter.actor) args.push("--actor", filter.actor);
  if (filter.from) args.push("--since", filter.from);
  if (filter.to) args.push("--until", filter.to);
  const result = spawnSync("runx", args, { env: process.env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || "").trim() || "runx history failed");
  }
  const projection = JSON.parse(result.stdout || "{}");
  return Array.isArray(projection.receipts) ? projection.receipts : [];
}

// Shell the shipped `runx verify --json`, which is TREE-grouped, not a linear
// link walk. Reconcile the tree verdict honestly: intact <- report.valid,
// breaks <- each tree's parent_missing plus its findings, named by id ref.
// When the engine ran without verify keys (signature_mode != production), the
// chain is reported unverified (fail closed), never silently intact.
function verifyChain() {
  const result = spawnSync("runx", ["verify", "--json"], { env: process.env, encoding: "utf8" });
  // verify exits non-zero when the chain is invalid; the JSON report still
  // carries the verdict, so parse it before treating the exit as a hard error.
  let report;
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error((result.stderr || "").trim() || "runx verify failed");
  }
  if (report.signature_mode !== "production") {
    return { checked: true, intact: null, breaks: [] };
  }
  const breaks = [];
  for (const tree of Array.isArray(report.trees) ? report.trees : []) {
    if (tree.parent_missing) {
      breaks.push({
        from_receipt_id: String(tree.parent_missing),
        to_receipt_id: String(tree.root_receipt_id || ""),
        reason: "parent receipt missing from the verified tree",
      });
    }
    for (const finding of Array.isArray(tree.findings) ? tree.findings : []) {
      breaks.push({
        from_receipt_id: String(tree.root_receipt_id || ""),
        to_receipt_id: String(finding.path || ""),
        reason: stringValue(finding.message) || stringValue(finding.code) || "verification finding",
      });
    }
  }
  return { checked: true, intact: report.valid === true, breaks };
}

// Project ONE receipt down to an id-stub. Accepts the engine row shape
// (id/name) or an already-stubbed override row (receipt_id/skill_ref). Copies
// ONLY {receipt_id, skill_ref, status, created_at}; summary, actors,
// artifact_types, verification, and any harness body are dropped.
function projectIdStub(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("ledger row must be an object");
  }
  const receiptId = stringValue(row.receipt_id) || stringValue(row.id);
  if (!receiptId) {
    throw new Error("ledger row is missing a receipt id");
  }
  return {
    receipt_id: receiptId,
    skill_ref: stringValue(row.skill_ref) || stringValue(row.name) || "",
    status: stringValue(row.status) || "",
    created_at: stringValue(row.created_at) || "",
  };
}

// The engine already filters by skill/status/time when shelled. The override
// replay path supplies raw rows, so apply the same narrowing in-process so a
// seeded ledger and a shelled ledger answer the same query.
function matchesFilter(stub, filter) {
  if (filter.skill_ref && stub.skill_ref !== filter.skill_ref) return false;
  if (filter.status.length > 0 && !filter.status.includes(stub.status)) return false;
  if (filter.from && stub.created_at && stub.created_at < filter.from) return false;
  if (filter.to && stub.created_at && stub.created_at > filter.to) return false;
  return true;
}

function renderSummary({ decision, matched, chain, proofRequested, query }) {
  if (decision === "needs_more_evidence") {
    const scope = query.skill_ref || query.principal || "the ledger";
    return `No receipts matched the resolved query against ${scope}; the gap is the query, not a confirmed zero.`;
  }
  const count = matched.length;
  const noun = count === 1 ? "receipt" : "receipts";
  if (!proofRequested) {
    return `${count} ${noun} matched the resolved query; chain verification was not requested.`;
  }
  if (chain.intact === null) {
    return `${count} ${noun} matched the resolved query; the chain is unverified because verify keys were not available.`;
  }
  if (chain.intact) {
    return `${count} ${noun} matched the resolved query, and the engine's tree-rooted verify verdict is intact.`;
  }
  return `${count} ${noun} matched the resolved query, but the engine's tree-rooted verify verdict reports ${chain.breaks.length} break(s).`;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

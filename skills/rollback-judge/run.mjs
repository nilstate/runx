function readJsonInput(name, fallback = null) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readStringInput(name, fallback = "") {
  const value = readJsonInput(name, fallback);
  return typeof value === "string" ? value : fallback;
}

const deploySignal = readJsonInput("DEPLOY_SIGNAL", {});
const currentVersion = readJsonInput("CURRENT_VERSION", {});
const priorVersion = readJsonInput("PRIOR_VERSION", null);
const forwardFixEvidence = readJsonInput("FORWARD_FIX_EVIDENCE", {});
const boundDecision = readStringInput("ACT_DECISION", "");
const boundTargetRef = readStringInput("ACT_TARGET_REF", "");

const evidence = deploySignal?.evidence ?? {};
const severity = String(deploySignal?.severity ?? "");
const kind = String(deploySignal?.kind ?? "");
const failing =
  evidence.failing === true ||
  severity.toLowerCase() === "critical" ||
  String(evidence.observed ?? "") !== "";
const contradictory =
  evidence.failing === false ||
  typeof evidence.contradiction === "string" ||
  kind.toLowerCase().includes("mixed");

function releaseTargetRef(version) {
  if (boundTargetRef) {
    return boundTargetRef;
  }
  const service = currentVersion?.service ?? deploySignal?.service ?? "checkout";
  return version ? `runx:release:${service}@${version}` : "";
}

function hold(reason, missingEvidence = []) {
  const actReason = `action=hold reason=${reason}`;
  return {
    act_decision: boundDecision || "defer",
    act_reason: actReason,
    act_target_ref: "",
    decision: {
      action: "hold",
      reason,
      version_target: null,
    },
    escalation: {
      required: true,
      reason,
      missing_evidence: missingEvidence,
    },
    release_publish_approval: {
      gate_id: "release.publish.approval",
      approved: false,
      reason,
      dispatch: {
        skill: "release",
        answer_key: "release.publish.approval",
        note: "Release graph owns the rollback consequence.",
      },
    },
    review_record: {
      form: "review",
      signal: { severity, kind },
      evidence_used: ["deploy_signal.severity", "deploy_signal.kind"],
      refused: { reason },
    },
  };
}

let packet;
if (contradictory) {
  packet = hold("contradictory_signal", ["deploy_signal.evidence.failing"]);
} else if (!failing) {
  packet = hold("nonfailing_signal", ["deploy_signal.evidence.failing"]);
} else if (priorVersion?.version) {
  const targetRef = releaseTargetRef(priorVersion.version);
  const actReason = `action=rollback reason=error_rate_critical target=${priorVersion.version}`;
  packet = {
    act_decision: boundDecision || "approve",
    act_reason: actReason,
    act_target_ref: targetRef,
    decision: {
      action: "rollback",
      reason: "error_rate_critical",
      version_target: {
        version: priorVersion.version,
        digest: priorVersion.digest ?? null,
        source: "prior_version",
      },
    },
    escalation: {
      required: false,
      reason: null,
      missing_evidence: [],
    },
    release_publish_approval: {
      gate_id: "release.publish.approval",
      approved: true,
      reason: "error_rate_critical",
      dispatch: {
        skill: "release",
        answer_key: "release.publish.approval",
        note: "Release graph owns the rollback consequence.",
      },
    },
    review_record: {
      form: "review",
      signal: { severity, kind },
      evidence_used: [
        "deploy_signal.evidence.metric",
        "deploy_signal.evidence.observed",
        "deploy_signal.evidence.threshold",
        "prior_version.version",
      ],
      refused: { reason: null },
    },
  };
} else if (
  Array.isArray(forwardFixEvidence?.test_runs) &&
  forwardFixEvidence.test_runs.length > 0 &&
  forwardFixEvidence?.review_signoff
) {
  packet = {
    act_decision: boundDecision || "approve",
    act_reason: "action=roll_forward reason=tested_forward_fix",
    act_target_ref: boundTargetRef,
    decision: {
      action: "roll_forward",
      reason: "tested_forward_fix",
      version_target: null,
    },
    escalation: {
      required: false,
      reason: null,
      missing_evidence: [],
    },
    release_publish_approval: {
      gate_id: "release.publish.approval",
      approved: true,
      reason: "tested_forward_fix",
      dispatch: {
        skill: "release",
        answer_key: "release.publish.approval",
        note: "Release graph owns the rollback consequence.",
      },
    },
    review_record: {
      form: "review",
      signal: { severity, kind },
      evidence_used: ["forward_fix_evidence.test_runs", "forward_fix_evidence.review_signoff"],
      refused: { reason: null },
    },
  };
} else {
  packet = hold("missing_rollback_or_forward_fix_evidence", [
    "prior_version",
    "forward_fix_evidence.test_runs",
    "forward_fix_evidence.review_signoff",
  ]);
}

process.stdout.write(`${JSON.stringify(packet)}\n`);

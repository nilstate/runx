import {
  MAX_ENGAGEMENT_ACTS,
  MAX_THREAD_SEGMENTS,
  actKind,
  buildRequestBatch,
  executionActLimit,
} from "./twitter-execution-requests.mjs";
import {
  activeThread,
  array,
  nonNegativeInteger,
  record,
  text,
} from "./twitter-execution-values.mjs";

export function prepareExecution(inputs) {
  const plan = record(inputs.plan_json);
  const digest = text(record(inputs.digest_result).digest);
  const acts = array(plan.acts);
  const blockers = validatePlan(plan, acts, digest, text(inputs.plan_digest));
  const progress = readProgress(record(inputs.execution_ledger), digest, acts, blockers);
  const expectedVersion = nonNegativeInteger(inputs.expected_version);
  const idempotencyKey = expectedVersion === null
    ? ""
    : batchIdempotencyKey(digest, expectedVersion);
  validateBatchBinding(
    inputs,
    expectedVersion,
    progress.version,
    idempotencyKey,
    blockers,
  );
  const base = executionPlanBase(
    plan,
    acts.length,
    digest,
    progress,
    expectedVersion,
    idempotencyKey,
  );
  if (blockers.length > 0) {
    return { twitter_execution_plan: { ...base, decision: "refused", blockers } };
  }
  if (progress.nextActIndex === acts.length) {
    return { twitter_execution_plan: { ...base, decision: "noop" } };
  }
  return {
    twitter_execution_plan: {
      ...base,
      decision: "ready",
      ...buildRequestBatch(acts, progress, executionActLimit(inputs.max_acts)),
    },
  };
}

function validateBatchBinding(
  inputs,
  expectedVersion,
  durableVersion,
  canonicalIdempotencyKey,
  blockers,
) {
  if (expectedVersion === null) {
    blockers.push("expected_version must be a non-negative safe integer");
  } else if (expectedVersion !== durableVersion) {
    blockers.push(
      `expected_version ${expectedVersion} does not match durable version ${durableVersion}`,
    );
  }
  if (text(inputs.idempotency_key) !== canonicalIdempotencyKey) {
    blockers.push(
      `idempotency_key must equal ${canonicalIdempotencyKey || "the canonical batch key"}`,
    );
  }
}

function executionPlanBase(
  plan,
  totalActCount,
  digest,
  progress,
  expectedVersion,
  idempotencyKey,
) {
  return {
    decision: "refused",
    plan_digest: digest,
    principal: plan.principal ?? null,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    start_act_index: progress.nextActIndex,
    next_act_index: progress.nextActIndex,
    total_act_count: totalActCount,
    remaining_count: Math.max(0, totalActCount - progress.nextActIndex),
    active_thread: progress.activeThread,
    auth: { type: "oauth1", secret_env: "TWITTER_USER_AUTH" },
    allowed_hosts: ["api.x.com"],
    requests: [],
    act_groups: [],
    selected_act_count: 0,
    blockers: [],
  };
}

function readProgress(ledger, planDigest, acts, blockers) {
  const version = nonNegativeInteger(ledger.after_version);
  const events = array(ledger.events);
  const empty = { version: version ?? 0, nextActIndex: 0, activeThread: null };
  if (version === null) {
    blockers.push("execution ledger omitted a valid after_version");
    return empty;
  }
  if (version === 0) {
    if (events.length !== 0) blockers.push("an empty execution ledger returned events");
    return empty;
  }
  if (events.length !== 1) {
    blockers.push("execution ledger tail must contain exactly one durable progress event");
    return empty;
  }
  const latest = record(events[0]);
  const event = record(latest.event);
  const nextActIndex = nonNegativeInteger(event.next_act_index);
  const totalActCount = nonNegativeInteger(event.total_act_count);
  const currentThread = activeThread(event.active_thread);
  if (nonNegativeInteger(latest.version) !== version) {
    blockers.push("execution ledger tail version does not match after_version");
  }
  if (event.schema !== "twitter.execution.progress.v1" || event.type !== "twitter.execution.progress") {
    blockers.push("execution ledger requires the compact twitter.execution.progress.v1 shape");
  }
  if (text(event.plan_digest) !== planDigest) {
    blockers.push("execution ledger progress is bound to a different plan digest");
  }
  if (totalActCount !== acts.length) {
    blockers.push("execution ledger progress has a different total act count");
  }
  if (nextActIndex === null || nextActIndex > acts.length) {
    blockers.push("execution ledger next_act_index is outside the plan");
  }
  validateActiveThread(currentThread, acts, nextActIndex, blockers);
  return { version, nextActIndex: nextActIndex ?? 0, activeThread: currentThread };
}

function validateActiveThread(current, acts, nextActIndex, blockers) {
  if (!current) return;
  const act = acts[current.act_index];
  const segmentCount = array(record(act?.params).texts).length;
  if (
    current.act_index !== nextActIndex
    || act?.kind !== "thread"
    || current.next_segment_index <= 0
    || current.next_segment_index >= segmentCount
    || !text(current.in_reply_to)
  ) {
    blockers.push("execution ledger active_thread is inconsistent with the next plan act");
  }
}

function validatePlan(value, acts, canonicalDigest, suppliedDigest) {
  const errors = [];
  if (!suppliedDigest) {
    errors.push("plan_digest is required; refusing unbound content");
  } else if (suppliedDigest !== canonicalDigest) {
    errors.push(
      `plan_digest mismatch: expected ${suppliedDigest}, canonical digest is ${canonicalDigest}`,
    );
  }
  if (value.decision !== "ready") errors.push("plan_json.decision must be ready");
  if (!text(value.principal)) errors.push("plan_json.principal is required");
  if (record(value.gates).human_approval_required !== true) {
    errors.push("plan_json must require human approval");
  }
  if (acts.length === 0) errors.push("plan_json.acts must be a non-empty array");
  if (acts.filter((act) => actKind(act?.kind)?.engagement).length > MAX_ENGAGEMENT_ACTS) {
    errors.push(`plan exceeds the ${MAX_ENGAGEMENT_ACTS}-act engagement cap`);
  }
  const seen = new Set();
  for (const act of acts) validateAct(act, seen, errors);
  return errors;
}

function validateAct(act, seen, errors) {
  if (!act || typeof act !== "object" || !text(act.act_id) || !text(act.kind)) {
    errors.push("every act needs act_id and kind");
    return;
  }
  if (seen.has(String(act.act_id))) errors.push(`duplicate act_id ${act.act_id}`);
  seen.add(String(act.act_id));
  if (!actKind(act.kind)) {
    errors.push(`unknown act kind ${act.kind}`);
    return;
  }
  const missing = requiredParams(act.kind)
    .filter((field) => missingValue(record(act.params)[field]));
  if (missing.length > 0) {
    errors.push(`act ${act.act_id} is missing params: ${missing.join(", ")}`);
  }
  if (
    act.kind === "thread"
    && array(record(act.params).texts).length > MAX_THREAD_SEGMENTS
  ) {
    errors.push(`thread ${act.act_id} exceeds ${MAX_THREAD_SEGMENTS} segments`);
  }
}

function requiredParams(kind) {
  return {
    post: ["text"],
    reply: ["text", "in_reply_to"],
    quote: ["text", "quote_of"],
    thread: ["texts"],
    delete_post: ["post_id"],
    unfollow: ["target_user_id"],
    follow: ["target_user_id"],
    mute: ["target_user_id"],
    block: ["target_user_id"],
    like: ["post_id"],
    repost: ["post_id"],
  }[kind] ?? [];
}

function missingValue(value) {
  return value === undefined
    || value === null
    || value === ""
    || (Array.isArray(value) && value.length === 0);
}

function batchIdempotencyKey(planDigest, expectedVersion) {
  return planDigest ? `twitter:${planDigest}:v${expectedVersion + 1}` : "";
}

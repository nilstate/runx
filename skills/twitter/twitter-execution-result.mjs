import {
  activeThread,
  array,
  nonNegativeInteger,
  number,
  record,
  text,
} from "./twitter-execution-values.mjs";

export function finalizeExecution(inputs) {
  const plan = record(inputs.execution_plan);
  if (plan.decision !== "ready") {
    return { twitter_execution: executionPacket(plan, plan.decision) };
  }
  const execution = record(inputs.http_execution);
  const responseById = new Map(
    array(execution.responses).map((value) => [text(record(value).id), record(value)]),
  );
  const state = consumeContiguousResults(plan, execution, responseById);
  const decision = state.nextActIndex === state.totalActCount
    ? "executed"
    : state.rateLimited
      ? "stopped"
      : "partial";
  const remainingCount = Math.max(0, state.totalActCount - state.nextActIndex);
  return {
    twitter_execution: executionPacket(plan, decision, {
      results: state.results,
      next_act_index: state.nextActIndex,
      remaining_count: remainingCount,
      active_thread: state.activeThread,
      ledger_delta: progressEvent(plan, decision, state),
      rate: rate(state.rateResponse),
      success_checkpoint: {
        milestone: decision === "executed"
          ? "plan_fully_executed"
          : "plan_partially_executed",
        description: `${state.nextActIndex - state.startActIndex} acts completed in this batch, ${remainingCount} remaining`,
      },
    }),
  };
}

function consumeContiguousResults(plan, execution, responseById) {
  const startActIndex = nonNegativeInteger(plan.start_act_index) ?? 0;
  const state = {
    startActIndex,
    nextActIndex: startActIndex,
    totalActCount: nonNegativeInteger(plan.total_act_count) ?? 0,
    activeThread: activeThread(plan.active_thread),
    results: [],
    failure: null,
    rateLimited: false,
    rateResponse: null,
  };
  for (const group of array(plan.act_groups).map(record)) {
    if (nonNegativeInteger(group.act_index) !== state.nextActIndex) {
      state.failure = "execution groups were not a contiguous plan prefix";
      break;
    }
    const responses = array(group.request_ids)
      .map((id) => responseById.get(String(id)))
      .filter(Boolean);
    const directFailure = responses.find((response) => response.ok !== true);
    const failedResponse = directFailure
      ?? (responses.length === 0 ? lastFailure(execution.responses) : null);
    if (failedResponse || responses.length === 0) {
      const satisfied = directFailure
        ? terminalProviderState(group, directFailure)
        : null;
      if (satisfied) {
        state.results.push(satisfied);
        state.activeThread = null;
        state.nextActIndex += 1;
        break;
      }
      state.rateResponse = number(failedResponse?.status, 0) === 429 ? failedResponse : null;
      state.rateLimited = Boolean(state.rateResponse);
      state.failure = failedResponse
        ? text(failedResponse.skip_reason) || providerError(failedResponse)
        : "provider execution produced no response for the next act";
      state.activeThread = partialThreadProgress(group, responses, state.activeThread);
      state.results.push(result(group, "failed", providerRefs(responses), state.failure));
      break;
    }
    const completed = completedResult(group, responses);
    state.results.push(completed.result);
    if (!completed.ok) {
      state.failure = completed.result.detail;
      break;
    }
    state.activeThread = null;
    state.nextActIndex += 1;
  }
  return state;
}

function terminalProviderState(group, response) {
  if (
    group.kind !== "unfollow"
    || number(response?.status, 0) !== 400
    || providerError(response) !== "You cannot unfollow an account that is not active."
  ) {
    return null;
  }
  return result(
    group,
    "done",
    group.fallback_provider_ref ?? null,
    "Target account is inactive; the requested not-following state is already satisfied.",
  );
}

function completedResult(group, responses) {
  if (group.kind === "thread") {
    const refs = providerRefs(responses);
    return {
      ok: true,
      result: result(
        group,
        "done",
        refs,
        `${refs.split(",").filter(Boolean).length} segments posted`,
      ),
    };
  }
  const data = record(record(responses[0].json).data);
  if (reachedRequestedState(group.kind, data) === false) {
    return {
      ok: false,
      result: result(
        group,
        "failed",
        null,
        "provider reported that the requested state was not reached",
      ),
    };
  }
  return {
    ok: true,
    result: result(group, "done", data.id ?? group.fallback_provider_ref ?? null, null),
  };
}

const BOOLEAN_OUTCOMES = Object.freeze({
  delete_post: ["deleted", true],
  unfollow: ["following", false],
  follow: ["following", true],
  mute: ["muting", true],
  block: ["blocking", true],
  like: ["liked", true],
  repost: ["retweeted", true],
});

function reachedRequestedState(kind, data) {
  const expectation = BOOLEAN_OUTCOMES[kind];
  if (!expectation) return null;
  const [field, expected] = expectation;
  return typeof data[field] === "boolean" ? data[field] === expected : null;
}

function progressEvent(plan, decision, state) {
  return {
    schema: "twitter.execution.progress.v1",
    type: "twitter.execution.progress",
    plan_digest: text(plan.plan_digest),
    decision,
    next_act_index: state.nextActIndex,
    total_act_count: state.totalActCount,
    active_thread: state.activeThread,
    batch: {
      start_act_index: state.startActIndex,
      selected_act_count: array(plan.act_groups).length,
      completed_act_count: state.nextActIndex - state.startActIndex,
      failed: state.failure !== null,
      rate_limited: state.rateLimited,
    },
  };
}

function executionPacket(plan, decision, overrides = {}) {
  return {
    decision,
    plan_digest: text(plan.plan_digest),
    principal: plan.principal ?? null,
    next_act_index: nonNegativeInteger(plan.next_act_index) ?? 0,
    total_act_count: nonNegativeInteger(plan.total_act_count) ?? 0,
    remaining_count: nonNegativeInteger(plan.remaining_count) ?? 0,
    active_thread: activeThread(plan.active_thread),
    results: [],
    ledger_delta: null,
    rate: rate(),
    blockers: array(plan.blockers),
    success_checkpoint: {
      milestone: decision === "noop" ? "plan_fully_executed" : "plan_refused",
      description: decision === "noop"
        ? "The durable cursor is already at the end of the plan."
        : "The execution contract was refused before provider work.",
    },
    ...overrides,
  };
}

function partialThreadProgress(group, responses, current) {
  if (group.kind !== "thread") return null;
  const failureIndex = responses.findIndex((response) => response.ok !== true);
  const succeededCount = failureIndex === -1 ? responses.length : failureIndex;
  if (succeededCount === 0) return current;
  const inReplyTo = text(record(record(responses[succeededCount - 1].json).data).id);
  const nextSegmentIndex = (nonNegativeInteger(group.segment_start) ?? 0) + succeededCount;
  if (!inReplyTo || nextSegmentIndex >= (nonNegativeInteger(group.segment_count) ?? 0)) {
    return current;
  }
  return {
    act_index: nonNegativeInteger(group.act_index) ?? 0,
    next_segment_index: nextSegmentIndex,
    in_reply_to: inReplyTo,
  };
}

function result(group, status, providerRef, detail) {
  return {
    act_id: String(group.act_id),
    kind: group.kind,
    consequence: group.consequence,
    status,
    provider_ref: providerRef || null,
    detail,
  };
}

function providerRefs(responses) {
  return responses
    .filter((response) => response.ok === true)
    .map((response) => record(record(response.json).data).id)
    .filter(Boolean)
    .join(",");
}

function providerError(response) {
  const body = record(response.json);
  const first = array(body.errors).map(record)[0] ?? {};
  return text(first.detail)
    || text(first.message)
    || text(body.detail)
    || text(body.title)
    || `provider returned HTTP ${number(response.status, 0)}`;
}

function lastFailure(values) {
  const responses = array(values);
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = record(responses[index]);
    if (response.ok !== true) return response;
  }
  return null;
}

function rate(value = {}) {
  const response = record(value);
  const headers = record(response.headers);
  const reset = Number(headers["x-rate-limit-reset"]);
  return {
    limited: number(response.status, 0) === 429,
    remaining: number(headers["x-rate-limit-remaining"], -1),
    reset_at: Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000).toISOString()
      : null,
  };
}

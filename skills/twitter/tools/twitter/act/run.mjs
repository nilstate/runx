#!/usr/bin/env node

import {
  ACT_KINDS,
  USER_AUTH_BLOCKER,
  apiErrorDetail,
  apiRequest,
  canonicalDigest,
  fail,
  readInputs,
  userCredentials,
  writePacket,
} from "../lib/client.mjs";

const DEFAULT_MAX_ACTS = 50;
const DEFAULT_MAX_ENGAGEMENT_ACTS = 10;
const MAX_THREAD_SEGMENTS = 25;

function packet(overrides) {
  return {
    decision: "executed",
    plan_digest: "",
    principal: null,
    results: [],
    remaining_act_ids: [],
    rate: { limited: false, reset_at: null },
    blockers: [],
    success_checkpoint: null,
    ...overrides,
  };
}

function refusal(plan, digest, blockers) {
  return packet({
    decision: "refused",
    plan_digest: digest,
    principal: plan?.principal ?? null,
    blockers,
  });
}

function validateActs(acts, maxActs) {
  const blockers = [];
  if (!Array.isArray(acts) || acts.length === 0) {
    blockers.push("plan_json.acts must be a non-empty array");
    return blockers;
  }
  if (acts.length > maxActs) {
    blockers.push(`plan carries ${acts.length} acts; the per-execution cap is ${maxActs}`);
  }
  const engagementCount = acts.filter((act) => ACT_KINDS[act?.kind]?.engagement).length;
  if (engagementCount > DEFAULT_MAX_ENGAGEMENT_ACTS) {
    blockers.push(
      `plan carries ${engagementCount} engagement acts (follow/like/repost); the cap is ${DEFAULT_MAX_ENGAGEMENT_ACTS}`,
    );
  }
  const seen = new Set();
  for (const act of acts) {
    if (!act || typeof act !== "object" || !act.act_id || !act.kind) {
      blockers.push("every act needs act_id and kind");
      break;
    }
    if (seen.has(act.act_id)) blockers.push(`duplicate act_id ${act.act_id}`);
    seen.add(act.act_id);
    if (!ACT_KINDS[act.kind]) blockers.push(`unknown act kind ${act.kind}`);
    if (act.kind === "thread" && (act.params?.texts ?? []).length > MAX_THREAD_SEGMENTS) {
      blockers.push(`thread ${act.act_id} exceeds ${MAX_THREAD_SEGMENTS} segments`);
    }
  }
  return blockers;
}

async function selfUserId(state) {
  if (!state.selfId) {
    const result = await apiRequest({ method: "GET", pathName: "/2/users/me", auth: "user" });
    if (!result.ok) throw Object.assign(new Error(apiErrorDetail(result)), { rate: result.rate });
    state.selfId = result.json.data.id;
  }
  return state.selfId;
}

async function performAct(act, state) {
  const params = act.params ?? {};
  switch (act.kind) {
    case "post":
      return apiRequest({ method: "POST", pathName: "/2/tweets", body: { text: params.text }, auth: "user" });
    case "reply":
      return apiRequest({
        method: "POST",
        pathName: "/2/tweets",
        body: { text: params.text, reply: { in_reply_to_tweet_id: params.in_reply_to } },
        auth: "user",
      });
    case "quote":
      return apiRequest({
        method: "POST",
        pathName: "/2/tweets",
        body: { text: params.text, quote_tweet_id: params.quote_of },
        auth: "user",
      });
    case "delete_post":
      return apiRequest({ method: "DELETE", pathName: `/2/tweets/${params.post_id}`, auth: "user" });
    case "unfollow":
      return apiRequest({
        method: "DELETE",
        pathName: `/2/users/${await selfUserId(state)}/following/${params.target_user_id}`,
        auth: "user",
      });
    case "follow":
      return apiRequest({
        method: "POST",
        pathName: `/2/users/${await selfUserId(state)}/following`,
        body: { target_user_id: params.target_user_id },
        auth: "user",
      });
    case "mute":
      return apiRequest({
        method: "POST",
        pathName: `/2/users/${await selfUserId(state)}/muting`,
        body: { target_user_id: params.target_user_id },
        auth: "user",
      });
    case "block":
      return apiRequest({
        method: "POST",
        pathName: `/2/users/${await selfUserId(state)}/blocking`,
        body: { target_user_id: params.target_user_id },
        auth: "user",
      });
    case "like":
      return apiRequest({
        method: "POST",
        pathName: `/2/users/${await selfUserId(state)}/likes`,
        body: { tweet_id: params.post_id },
        auth: "user",
      });
    case "repost":
      return apiRequest({
        method: "POST",
        pathName: `/2/users/${await selfUserId(state)}/retweets`,
        body: { tweet_id: params.post_id },
        auth: "user",
      });
    default:
      throw new Error(`unknown act kind ${act.kind}`);
  }
}

async function performThread(act, state) {
  const texts = act.params?.texts ?? [];
  const createdIds = [];
  let previousId = act.params?.in_reply_to ?? null;
  for (const text of texts) {
    const body = previousId ? { text, reply: { in_reply_to_tweet_id: previousId } } : { text };
    const result = await apiRequest({ method: "POST", pathName: "/2/tweets", body, auth: "user" });
    if (!result.ok) return { result, createdIds };
    previousId = result.json.data.id;
    createdIds.push(previousId);
  }
  return { result: { ok: true, status: 201, rate: { limited: false, reset_at: null } }, createdIds };
}

function actParamBlocker(act) {
  const params = act.params ?? {};
  const required = {
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
  }[act.kind];
  const missing = required.filter((key) => {
    const value = params[key];
    return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  });
  return missing.length > 0 ? `act ${act.act_id} is missing params: ${missing.join(", ")}` : null;
}

async function main() {
  const inputs = readInputs();
  const rawPlan = typeof inputs.plan_json === "object" && inputs.plan_json !== null ? inputs.plan_json : null;
  if (!rawPlan) {
    writePacket(refusal(null, "", ["plan_json is required and must be the twitter plan object"]));
    return;
  }
  const plan = typeof rawPlan.twitter_plan === "object" && rawPlan.twitter_plan !== null ? rawPlan.twitter_plan : rawPlan;
  const digest = canonicalDigest(plan);
  if (inputs.plan_digest && inputs.plan_digest !== digest) {
    writePacket(refusal(plan, digest, [
      `plan_digest mismatch: expected ${inputs.plan_digest}, canonical digest of plan_json is ${digest}; refusing to execute unverified content`,
    ]));
    return;
  }

  const maxActs = Number.isFinite(Number(inputs.max_acts)) && Number(inputs.max_acts) > 0
    ? Math.floor(Number(inputs.max_acts))
    : DEFAULT_MAX_ACTS;
  const blockers = validateActs(plan.acts, maxActs);
  for (const act of plan.acts ?? []) {
    if (ACT_KINDS[act?.kind] && !blockers.length) {
      const paramBlocker = actParamBlocker(act);
      if (paramBlocker) blockers.push(paramBlocker);
    }
  }
  if (blockers.length > 0) {
    writePacket(refusal(plan, digest, blockers));
    return;
  }

  const alreadyExecuted = new Set(
    Array.isArray(inputs.already_executed_act_ids) ? inputs.already_executed_act_ids.map(String) : [],
  );
  const pending = plan.acts.filter((act) => !alreadyExecuted.has(String(act.act_id)));
  if (pending.length > 0 && !userCredentials()) {
    writePacket(refusal(plan, digest, [USER_AUTH_BLOCKER]));
    return;
  }

  const state = { selfId: null };
  const results = [];
  const remaining = [];
  let rate = { limited: false, reset_at: null };
  let stopped = false;
  let failed = 0;

  for (const act of plan.acts) {
    const consequence = ACT_KINDS[act.kind].consequence;
    if (alreadyExecuted.has(String(act.act_id))) {
      results.push({ act_id: act.act_id, kind: act.kind, consequence, status: "skipped", provider_ref: null, detail: "already executed in a prior run" });
      continue;
    }
    if (stopped) {
      remaining.push(act.act_id);
      continue;
    }
    try {
      if (act.kind === "thread") {
        const { result, createdIds } = await performThread(act, state);
        rate = result.rate ?? rate;
        if (result.ok) {
          results.push({ act_id: act.act_id, kind: act.kind, consequence, status: "done", provider_ref: createdIds.join(","), detail: `${createdIds.length} segments posted` });
        } else if (result.rate?.limited) {
          stopped = true;
          remaining.push(act.act_id);
          results.push({ act_id: act.act_id, kind: act.kind, consequence, status: "failed", provider_ref: createdIds.join(","), detail: `rate limited after ${createdIds.length} segments` });
        } else {
          failed += 1;
          results.push({ act_id: act.act_id, kind: act.kind, consequence, status: "failed", provider_ref: createdIds.join(","), detail: apiErrorDetail(result) });
        }
        continue;
      }
      const result = await performAct(act, state);
      rate = result.rate ?? rate;
      if (result.rate?.limited) {
        stopped = true;
        remaining.push(act.act_id);
        continue;
      }
      if (result.ok) {
        const data = result.json?.data ?? {};
        results.push({
          act_id: act.act_id,
          kind: act.kind,
          consequence,
          status: "done",
          provider_ref: data.id ?? (act.params?.post_id ?? act.params?.target_user_id ?? null),
          detail: null,
        });
      } else {
        failed += 1;
        results.push({ act_id: act.act_id, kind: act.kind, consequence, status: "failed", provider_ref: null, detail: apiErrorDetail(result) });
      }
    } catch (error) {
      failed += 1;
      results.push({
        act_id: act.act_id,
        kind: act.kind,
        consequence,
        status: "failed",
        provider_ref: null,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const decision = stopped ? "stopped" : failed > 0 ? "partial" : "executed";
  writePacket(packet({
    decision,
    plan_digest: digest,
    principal: plan.principal ?? null,
    results,
    remaining_act_ids: remaining,
    rate,
    success_checkpoint: {
      milestone: decision === "executed" ? "plan_fully_executed" : "plan_partially_executed",
      description: `${results.filter((r) => r.status === "done").length} done, ${results.filter((r) => r.status === "skipped").length} skipped, ${failed} failed, ${remaining.length} remaining`,
    },
  }));
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

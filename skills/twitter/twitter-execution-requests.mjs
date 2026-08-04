import { array, positiveInteger, record, text } from "./twitter-execution-values.mjs";

const MAX_ACTS = 50;
const MAX_REQUESTS = 50;
export const MAX_ENGAGEMENT_ACTS = 10;
export const MAX_THREAD_SEGMENTS = 25;

const SELF_KINDS = new Set(["unfollow", "follow", "mute", "block", "like", "repost"]);
const ACT_KINDS = {
  post: { consequence: "public_send" },
  reply: { consequence: "public_send" },
  quote: { consequence: "public_send" },
  thread: { consequence: "public_send" },
  repost: { consequence: "public_send", engagement: true },
  delete_post: { consequence: "live_mutation" },
  unfollow: { consequence: "live_mutation" },
  mute: { consequence: "live_mutation" },
  block: { consequence: "live_mutation" },
  follow: { consequence: "live_mutation", engagement: true },
  like: { consequence: "live_mutation", engagement: true },
};

export function actKind(kind) {
  return ACT_KINDS[kind] ?? null;
}

export function executionActLimit(value) {
  return Math.min(positiveInteger(value, MAX_ACTS), MAX_ACTS);
}

export function buildRequestBatch(acts, progress, maxActs) {
  const selected = selectContiguousBatch(acts, progress, maxActs);
  const requests = [];
  const actGroups = [];
  let selfAdded = false;
  for (const selection of selected) {
    if (SELF_KINDS.has(selection.act.kind) && !selfAdded) {
      requests.push({ id: "self", method: "GET", url: "https://api.x.com/2/users/me" });
      selfAdded = true;
    }
    const group = requestGroup(selection, progress.activeThread);
    requests.push(...group.requests);
    actGroups.push(group.metadata);
  }
  return { requests, act_groups: actGroups, selected_act_count: selected.length };
}

function selectContiguousBatch(acts, progress, maxActs) {
  const selected = [];
  let requestBudget = 0;
  let needsSelf = false;
  for (let index = progress.nextActIndex; index < acts.length; index += 1) {
    const act = acts[index];
    const threadStart = progress.activeThread?.act_index === index
      ? progress.activeThread.next_segment_index
      : 0;
    const requestCost = act.kind === "thread"
      ? array(record(act.params).texts).length - threadStart
      : 1;
    const selfCost = SELF_KINDS.has(act.kind) && !needsSelf ? 1 : 0;
    if (
      selected.length >= maxActs
      || requestBudget + requestCost + selfCost > MAX_REQUESTS
    ) break;
    selected.push({ act, index, threadStart });
    requestBudget += requestCost + selfCost;
    needsSelf ||= SELF_KINDS.has(act.kind);
  }
  return selected;
}

function requestGroup(selection, activeThread) {
  const { act, index: actIndex, threadStart } = selection;
  const id = String(act.act_id);
  const params = record(act.params);
  const consequence = ACT_KINDS[act.kind].consequence;
  if (act.kind === "thread") {
    return threadRequestGroup(id, actIndex, params, consequence, threadStart, activeThread);
  }
  const requestId = `act:${id}`;
  return {
    requests: [singleRequest(requestId, act.kind, params)],
    metadata: {
      act_id: id,
      act_index: actIndex,
      kind: act.kind,
      consequence,
      request_ids: [requestId],
      fallback_provider_ref: params.post_id ?? params.target_user_id ?? null,
    },
  };
}

function threadRequestGroup(id, actIndex, params, consequence, threadStart, activeThread) {
  const requestIds = [];
  const requests = [];
  let previous = activeThread?.act_index === actIndex
    ? text(activeThread.in_reply_to)
    : text(params.in_reply_to);
  array(params.texts).slice(threadStart).forEach((segment, offset) => {
    const index = threadStart + offset;
    const requestId = `act:${id}:segment:${index}`;
    const dependency = offset > 0 ? requestIds[offset - 1] : null;
    const replyId = previous
      || (dependency ? { $response: `${dependency}.json.data.id` } : null);
    requests.push({
      id: requestId,
      method: "POST",
      url: "https://api.x.com/2/tweets",
      ...(dependency ? { requires_success_of: [dependency] } : {}),
      body: replyId
        ? { text: String(segment), reply: { in_reply_to_tweet_id: replyId } }
        : { text: String(segment) },
    });
    requestIds.push(requestId);
    previous = "";
  });
  return {
    requests,
    metadata: {
      act_id: id,
      act_index: actIndex,
      kind: "thread",
      consequence,
      request_ids: requestIds,
      segment_start: threadStart,
      segment_count: array(params.texts).length,
    },
  };
}

function singleRequest(requestId, kind, params) {
  const self = "{$response:self.json.data.id}";
  if (kind === "delete_post") {
    return {
      id: requestId,
      method: "DELETE",
      url: `https://api.x.com/2/tweets/${encodeURIComponent(params.post_id)}`,
    };
  }
  if (kind === "unfollow") {
    return {
      id: requestId,
      method: "DELETE",
      url: `https://api.x.com/2/users/${self}/following/${encodeURIComponent(params.target_user_id)}`,
      requires_success_of: ["self"],
    };
  }
  if (["follow", "mute", "block"].includes(kind)) {
    const endpoint = { follow: "following", mute: "muting", block: "blocking" }[kind];
    return {
      id: requestId,
      method: "POST",
      url: `https://api.x.com/2/users/${self}/${endpoint}`,
      requires_success_of: ["self"],
      body: { target_user_id: params.target_user_id },
    };
  }
  if (["like", "repost"].includes(kind)) {
    const endpoint = kind === "like" ? "likes" : "retweets";
    return {
      id: requestId,
      method: "POST",
      url: `https://api.x.com/2/users/${self}/${endpoint}`,
      requires_success_of: ["self"],
      body: { tweet_id: params.post_id },
    };
  }
  return {
    id: requestId,
    method: "POST",
    url: "https://api.x.com/2/tweets",
    body: tweetBody(kind, params),
  };
}

function tweetBody(kind, params) {
  if (kind === "post") return { text: params.text };
  if (kind === "reply") {
    return { text: params.text, reply: { in_reply_to_tweet_id: params.in_reply_to } };
  }
  return { text: params.text, quote_tweet_id: params.quote_of };
}

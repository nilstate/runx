const QUERIES = new Set(["snapshot", "posts", "mentions", "search", "following", "followers"]);
const TWEET_FIELDS = "created_at,public_metrics,entities,referenced_tweets,in_reply_to_user_id";
const USER_FIELDS = "created_at,description,public_metrics";

export function prepareRead(inputs) {
  const query = text(inputs.query);
  const params = record(inputs.params);
  const maxItems = positiveInteger(inputs.max_items, 200, 10_000);
  const authMode = inputs.auth === "app" ? "app" : "user";
  const source = text(inputs.source) || "live";
  const packet = (decision, overrides = {}) => readPlan(query, params, maxItems, decision, overrides);

  if (!QUERIES.has(query)) {
    return {
      twitter_read_plan: packet("needs_input", {
        blockers: [`query must be one of: ${[...QUERIES].join(", ")}`],
      }),
    };
  }
  if (source === "archive") {
    const archiveFile = text(inputs.archive_file);
    if (!archiveFile) {
      return {
        twitter_read_plan: packet("needs_input", {
          source,
          blockers: ["archive_file is required for archive reads"],
        }),
      };
    }
    return {
      twitter_read_plan: packet("archive", {
        source: "archive",
        archive_files: [],
        retrieved_via: "runtime_artifact",
      }),
    };
  }
  if (source !== "live") {
    return {
      twitter_read_plan: packet("needs_input", {
        blockers: ["source must be live or archive"],
      }),
    };
  }
  if (query === "search" && !text(params.q)) {
    return {
      twitter_read_plan: packet("needs_input", {
        blockers: ["params.q is required for search"],
      }),
    };
  }

  const needsSelf = query === "snapshot" || (!text(params.user_id) && query !== "search");
  if (needsSelf && authMode === "app") {
    return {
      twitter_read_plan: packet("needs_input", {
        blockers: ["params.user_id is required for app-context reads that target an account"],
        stop_conditions: ["needs_authority"],
      }),
    };
  }
  return {
    twitter_read_plan: packet("live", {
      source: "live",
      auth: authMode === "app"
        ? { type: "bearer", secret_env: "TWITTER_BEARER_TOKEN" }
        : { type: "oauth1", secret_env: "TWITTER_USER_AUTH" },
      requests: liveRequests(query, params, maxItems, needsSelf),
    }),
  };
}

export function normalizeRead(inputs) {
  const plan = record(inputs.read_plan);
  const execution = record(inputs.http_execution);

  if (plan.decision !== "live") {
    return {
      twitter_read_result: readResult(plan, {
        decision: "needs_input",
        source: text(plan.source) || "live",
        blockers: array(plan.blockers),
        stop_conditions: array(plan.stop_conditions),
      }),
    };
  }

  const responses = new Map(
    array(execution.responses).map((value) => [text(record(value).id), record(value)]),
  );
  const self = responses.get("self");
  const collection = responses.get("collection");
  const failure = [self, collection]
    .filter(Boolean)
    .find((response) => response.performed !== false && response.ok !== true);
  if (failure) {
    const status = number(failure.status, 0);
    const authority = [401, 402, 403].includes(status);
    return {
      twitter_read_result: readResult(plan, {
        decision: status === 429 ? "stopped" : authority ? "needs_input" : "provider_error",
        blockers: [providerError(failure)],
        rate: rate(failure),
        stop_conditions: status === 429 ? ["rate_limited"] : authority ? ["needs_authority"] : [],
        request_count: number(execution.request_count, 0),
      }),
    };
  }

  const kind = text(record(plan.query).kind);
  const pages = collection ? array(collection.pages) : [];
  const rawItems = pages.flatMap((page) => array(record(record(page).json).data));
  const mapped = rawItems.map(kind === "following" || kind === "followers" ? mapUser : mapPost);
  const maxItems = number(plan.max_items, 200);
  const items = mapped.slice(0, maxItems);
  const last = collection || self || {};
  return {
    twitter_read_result: readResult(plan, {
      decision: execution.stopped === true ? "stopped" : "ok",
      account: self?.json?.data ? mapUser(self.json.data) : null,
      items,
      truncated: mapped.length > items.length || Boolean(collection?.next_cursor),
      rate: rate(last),
      request_count: number(execution.request_count, 0),
      stop_conditions: execution.stopped === true ? ["rate_limited"] : [],
    }),
  };
}

export function normalizeArchivePage(inputs) {
  const plan = record(inputs.read_plan);
  const page = record(inputs.runx_page);
  const prior = record(page.state);
  const items = array(prior.items);
  const blockers = array(prior.blockers).map(text).filter(Boolean);
  const maxItems = number(plan.max_items, 200);
  let scanned = number(prior.scanned, 0);
  let truncated = prior.truncated === true;
  const kind = text(record(plan.query).kind);

  if (plan.decision !== "archive") {
    blockers.push("archive page execution requires an archive read plan");
  }
  for (const encoded of array(page.records)) {
    let raw;
    try {
      raw = record(JSON.parse(String(encoded)));
    } catch {
      blockers.push("runtime-framed archive record could not be decoded");
      break;
    }
    scanned += 1;
    if (items.length >= maxItems) {
      truncated = true;
      break;
    }
    if (kind === "following" || kind === "followers") {
      const value = record(raw.following ?? raw.follower ?? raw);
      items.push({
        id: value.accountId ?? value.id,
        username: null,
        name: null,
        description: "",
        metrics: null,
      });
    } else {
      items.push(mapArchivePost(record(raw.tweet ?? raw)));
    }
  }

  const state = { items, blockers, scanned, truncated };
  const done = blockers.length > 0 || truncated || page.eof === true;
  const runx_page = { state, done };
  if (!done) return { runx_page };
  return {
    runx_page,
    twitter_read_result: readResult(plan, {
      decision: blockers.length > 0 ? "needs_input" : "ok",
      source: "archive",
      items,
      truncated,
      retrieved_via: text(page.artifact_ref),
      request_count: 0,
      blockers,
    }),
  };
}

export function finalizeRead(inputs) {
  const value = record(inputs.read_result);
  const items = array(value.items);
  return {
    twitter_evidence: {
      decision: text(value.decision) || "provider_error",
      source: text(value.source) || "live",
      query: record(value.query),
      account: value.account ?? null,
      items,
      item_count: items.length,
      truncated: value.truncated === true,
      provenance: {
        retrieved_via: text(value.retrieved_via),
        request_count: number(value.request_count, 0),
        content_digest: text(record(inputs.digest_result).digest),
      },
      rate: record(value.rate),
      blockers: array(value.blockers),
      stop_conditions: array(value.stop_conditions),
    },
  };
}

function readPlan(query, params, maxItems, decision, overrides = {}) {
  return {
    decision,
    source: "live",
    query: { kind: query, params },
    max_items: maxItems,
    auth: null,
    allowed_hosts: ["api.x.com"],
    requests: [],
    archive_files: [],
    items: [],
    truncated: false,
    retrieved_via: "api.x.com",
    blockers: [],
    stop_conditions: [],
    ...overrides,
  };
}

function liveRequests(kind, requestParams, limit, needsSelf) {
  const requests = [];
  if (needsSelf) {
    requests.push({
      id: "self",
      method: "GET",
      url: "https://api.x.com/2/users/me",
      query: { "user.fields": USER_FIELDS },
    });
  }
  if (kind === "snapshot") return requests;

  const userId = text(requestParams.user_id);
  const target = userId || "{$response:self.json.data.id}";
  let url;
  let query;
  if (kind === "posts") {
    url = `https://api.x.com/2/users/${target}/tweets`;
    query = { "tweet.fields": TWEET_FIELDS };
  } else if (kind === "mentions") {
    url = `https://api.x.com/2/users/${target}/mentions`;
    query = { "tweet.fields": TWEET_FIELDS };
  } else if (kind === "search") {
    url = "https://api.x.com/2/tweets/search/recent";
    query = { query: text(requestParams.q), "tweet.fields": TWEET_FIELDS };
  } else if (kind === "following") {
    url = `https://api.x.com/2/users/${target}/following`;
    query = { "user.fields": USER_FIELDS };
  } else {
    url = `https://api.x.com/2/users/${target}/followers`;
    query = { "user.fields": USER_FIELDS };
  }
  const pageSize = Math.max(10, Math.min(100, limit));
  const initialCursor = text(requestParams.pagination_token);
  requests.push({
    id: "collection",
    method: "GET",
    url,
    query: {
      ...query,
      max_results: pageSize,
      ...(initialCursor ? { pagination_token: initialCursor } : {}),
    },
    ...(needsSelf ? { requires_success_of: ["self"] } : {}),
    pagination: {
      cursor_param: "pagination_token",
      cursor_path: "meta.next_token",
      items_path: "data",
      max_pages: Math.min(20, Math.max(1, Math.ceil(limit / pageSize))),
      max_items: limit,
    },
  });
  return requests;
}

function readResult(plan, overrides = {}) {
  return {
    decision: "ok",
    source: text(plan.source) || "live",
    query: record(plan.query),
    account: null,
    items: [],
    truncated: false,
    retrieved_via: text(plan.retrieved_via) || "api.x.com",
    request_count: 0,
    rate: { limited: false, remaining: -1, reset_at: null },
    blockers: [],
    stop_conditions: [],
    ...overrides,
  };
}

function mapPost(raw) {
  const metrics = record(raw.public_metrics);
  return {
    id: raw.id,
    text: raw.text,
    created_at: raw.created_at ?? null,
    metrics: {
      likes: number(metrics.like_count, 0),
      reposts: number(metrics.retweet_count, 0),
      replies: number(metrics.reply_count, 0),
      quotes: number(metrics.quote_count, 0),
      impressions: metrics.impression_count ?? null,
    },
    has_link: array(record(raw.entities).urls).length > 0,
    in_reply_to: raw.in_reply_to_user_id ?? null,
  };
}

function mapArchivePost(tweet) {
  return {
    id: tweet.id_str ?? tweet.id,
    text: tweet.full_text ?? tweet.text ?? "",
    created_at: tweet.created_at ?? null,
    metrics: {
      likes: number(tweet.favorite_count, 0),
      reposts: number(tweet.retweet_count, 0),
      replies: null,
      quotes: null,
      impressions: null,
    },
    has_link: array(record(tweet.entities).urls).length > 0,
    in_reply_to: tweet.in_reply_to_status_id_str ?? null,
  };
}

function mapUser(raw) {
  const metrics = record(raw.public_metrics);
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    description: raw.description ?? "",
    metrics: {
      followers: number(metrics.followers_count, 0),
      following: number(metrics.following_count, 0),
      posts: number(metrics.tweet_count, 0),
    },
  };
}

function rate(response = {}) {
  const headers = record(response.headers);
  const reset = Number(headers["x-rate-limit-reset"]);
  return {
    limited: number(response.status, 0) === 429,
    remaining: number(headers["x-rate-limit-remaining"], -1),
    reset_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  };
}

function providerError(response) {
  const body = record(response.json);
  const first = array(body.errors).map(record)[0] ?? {};
  const status = number(response.status, 0);
  const specific = text(first.detail) || text(first.message) || text(body.detail) || text(body.title);
  if (specific) return specific;
  if (status === 401) return "provider rejected the credentials (401); check the token values and app access";
  if (status === 402) return "provider requires payment (402); add API credits or a spending cap";
  if (status === 403) return "provider refused the request (403); check the required scopes";
  return `provider returned HTTP ${status}`;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback, cap) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, cap) : fallback;
}

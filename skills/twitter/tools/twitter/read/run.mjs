#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  USER_AUTH_BLOCKER,
  apiErrorDetail,
  apiRequest,
  bearerToken,
  fail,
  readInputs,
  resolveSkillPath,
  userCredentials,
  writePacket,
} from "../lib/client.mjs";

const QUERIES = new Set(["snapshot", "posts", "mentions", "search", "following", "followers"]);
const TWEET_FIELDS = "created_at,public_metrics,entities,referenced_tweets,in_reply_to_user_id";
const USER_FIELDS = "created_at,description,public_metrics";

function packet(overrides) {
  return {
    decision: "ok",
    source: "live",
    query: {},
    account: null,
    items: [],
    item_count: 0,
    truncated: false,
    provenance: { retrieved_via: "", request_count: 0, content_digest: "" },
    rate: { limited: false, reset_at: null },
    blockers: [],
    stop_conditions: [],
    ...overrides,
  };
}

function digestItems(items) {
  return `sha256:${createHash("sha256").update(JSON.stringify(items)).digest("hex")}`;
}

function mapPost(raw) {
  const metrics = raw.public_metrics ?? {};
  return {
    id: raw.id,
    text: raw.text,
    created_at: raw.created_at ?? null,
    metrics: {
      likes: metrics.like_count ?? 0,
      reposts: metrics.retweet_count ?? 0,
      replies: metrics.reply_count ?? 0,
      quotes: metrics.quote_count ?? 0,
      impressions: metrics.impression_count ?? null,
    },
    has_link: (raw.entities?.urls ?? []).length > 0,
    in_reply_to: raw.in_reply_to_user_id ?? null,
  };
}

function mapUser(raw) {
  const metrics = raw.public_metrics ?? {};
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    description: raw.description ?? "",
    metrics: {
      followers: metrics.followers_count ?? 0,
      following: metrics.following_count ?? 0,
      posts: metrics.tweet_count ?? 0,
    },
  };
}

function mapArchivePost(entry) {
  const tweet = entry.tweet ?? entry;
  return {
    id: tweet.id_str ?? tweet.id,
    text: tweet.full_text ?? tweet.text ?? "",
    created_at: tweet.created_at ?? null,
    metrics: {
      likes: Number(tweet.favorite_count ?? 0),
      reposts: Number(tweet.retweet_count ?? 0),
      replies: null,
      quotes: null,
      impressions: null,
    },
    has_link: (tweet.entities?.urls ?? []).length > 0,
    in_reply_to: tweet.in_reply_to_status_id_str ?? null,
  };
}

function parseArchive(filePath, query) {
  const raw = fs.readFileSync(filePath, "utf8");
  const eq = raw.indexOf("=");
  const body = eq >= 0 ? raw.slice(eq + 1) : raw;
  const entries = JSON.parse(body.trim());
  if (!Array.isArray(entries)) throw new Error("archive file did not contain an array");
  if (query === "following" || query === "followers") {
    return entries.map((entry) => {
      const record = entry.following ?? entry.follower ?? entry;
      return { id: record.accountId ?? record.id, username: null, name: null, description: "", metrics: null };
    });
  }
  return entries.map(mapArchivePost);
}

async function resolveSelf(auth, state) {
  const result = await apiRequest({
    method: "GET",
    pathName: "/2/users/me",
    query: { "user.fields": USER_FIELDS },
    auth,
  });
  state.requestCount += 1;
  if (!result.ok) throw Object.assign(new Error(apiErrorDetail(result)), { rate: result.rate, status: result.status });
  return result.json.data;
}

async function collect(pathName, query, mapItem, maxItems, auth, state) {
  const items = [];
  let paginationToken = state.paginationToken;
  let rate = { limited: false, reset_at: null };
  while (items.length < maxItems) {
    const pageSize = Math.min(100, maxItems - items.length);
    const result = await apiRequest({
      method: "GET",
      pathName,
      query: { ...query, max_results: Math.max(pageSize, 5), pagination_token: paginationToken },
      auth,
    });
    state.requestCount += 1;
    rate = result.rate;
    if (result.rate.limited) return { items, rate, stopped: true };
    if (!result.ok) throw Object.assign(new Error(apiErrorDetail(result)), { rate: result.rate, status: result.status });
    for (const raw of result.json.data ?? []) items.push(mapItem(raw));
    paginationToken = result.json.meta?.next_token ?? null;
    if (!paginationToken) break;
  }
  return { items, rate, stopped: false, next_token: paginationToken };
}

async function main() {
  const inputs = readInputs();
  const query = typeof inputs.query === "string" ? inputs.query.trim() : "";
  const params = typeof inputs.params === "object" && inputs.params !== null ? inputs.params : {};
  const maxItems = Number.isFinite(Number(inputs.max_items)) && Number(inputs.max_items) > 0
    ? Math.floor(Number(inputs.max_items))
    : 200;
  const auth = inputs.auth === "app" ? "app" : "user";

  if (!QUERIES.has(query)) {
    writePacket(packet({
      decision: "needs_input",
      query: { kind: query },
      blockers: [`query must be one of: ${[...QUERIES].join(", ")}`],
    }));
    return;
  }

  if (inputs.archive_file) {
    const filePath = resolveSkillPath(String(inputs.archive_file));
    if (!filePath) {
      writePacket(packet({
        decision: "needs_input",
        source: "archive",
        query: { kind: query },
        blockers: [`archive_file ${inputs.archive_file} was not found`],
      }));
      return;
    }
    const all = parseArchive(filePath, query);
    const items = all.slice(0, maxItems);
    writePacket(packet({
      source: "archive",
      query: { kind: query, params },
      items,
      item_count: items.length,
      truncated: all.length > items.length,
      provenance: {
        retrieved_via: `archive:${inputs.archive_file}`,
        request_count: 0,
        content_digest: digestItems(items),
      },
    }));
    return;
  }

  const missing = auth === "user" ? !userCredentials() : !bearerToken();
  if (missing) {
    writePacket(packet({
      decision: "needs_input",
      query: { kind: query, params },
      blockers: [
        auth === "user"
          ? USER_AUTH_BLOCKER
          : "app-context credential is missing: deliver TWITTER_BEARER_TOKEN via runx skill --credential twitter:bearer:<material_ref> --credential-scope twitter:read --secret-env TWITTER_BEARER_TOKEN",
      ],
      stop_conditions: ["needs_authority"],
    }));
    return;
  }

  const state = { requestCount: 0, paginationToken: params.pagination_token ?? null };
  let account = null;
  let userId = params.user_id ?? null;
  if (query === "snapshot" || (!userId && query !== "search")) {
    const self = await resolveSelf(auth === "app" ? "user" : auth, state);
    account = mapUser(self);
    userId = userId ?? self.id;
  }

  let outcome = { items: [], rate: { limited: false, reset_at: null }, stopped: false };
  if (query === "posts") {
    outcome = await collect(`/2/users/${userId}/tweets`, { "tweet.fields": TWEET_FIELDS }, mapPost, maxItems, auth, state);
  } else if (query === "mentions") {
    outcome = await collect(`/2/users/${userId}/mentions`, { "tweet.fields": TWEET_FIELDS }, mapPost, maxItems, auth, state);
  } else if (query === "search") {
    if (!params.q) {
      writePacket(packet({ decision: "needs_input", query: { kind: query }, blockers: ["params.q is required for search"] }));
      return;
    }
    outcome = await collect("/2/tweets/search/recent", { query: params.q, "tweet.fields": TWEET_FIELDS }, mapPost, maxItems, auth, state);
  } else if (query === "following") {
    outcome = await collect(`/2/users/${userId}/following`, { "user.fields": USER_FIELDS }, mapUser, maxItems, auth, state);
  } else if (query === "followers") {
    outcome = await collect(`/2/users/${userId}/followers`, { "user.fields": USER_FIELDS }, mapUser, maxItems, auth, state);
  }

  writePacket(packet({
    decision: outcome.stopped ? "stopped" : "ok",
    query: { kind: query, params },
    account,
    items: outcome.items,
    item_count: outcome.items.length,
    truncated: Boolean(outcome.next_token),
    provenance: {
      retrieved_via: "api.x.com",
      request_count: state.requestCount,
      content_digest: digestItems(outcome.items),
    },
    rate: outcome.rate,
    stop_conditions: outcome.stopped ? ["rate_limited"] : [],
  }));
}

try {
  await main();
} catch (error) {
  const status = error?.status;
  if (status === 401 || status === 402 || status === 403) {
    const reasons = {
      401: "provider rejected the credentials (401); check the token values and the app's access level",
      402: "provider requires payment (402); the app has no API credits, add credits or a spending cap in the developer portal",
      403: "provider refused the request (403); the app may lack the required access or scopes",
    };
    writePacket(packet({
      decision: "needs_input",
      blockers: [reasons[status]],
      stop_conditions: ["needs_authority"],
    }));
  } else {
    fail(error instanceof Error ? error.message : String(error));
  }
}

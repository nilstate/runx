import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_HOSTS = new Set(["api.x.com", "api.twitter.com", "upload.twitter.com"]);

export const API_BASE = "https://api.x.com";

// Single source of truth for the governed act vocabulary. `engagement` acts
// share a tighter per-execution cap because they are the abuse surface.
export const ACT_KINDS = {
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

export function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

export function writePacket(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: { message } })}\n`);
  process.exitCode = 1;
}

export function skillRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function resolveSkillPath(candidate) {
  if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  const fromCwd = path.resolve(process.cwd(), candidate);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromRoot = path.resolve(skillRoot(), candidate);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return null;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function canonicalDigest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

// User-context credentials arrive as one delivered secret: TWITTER_USER_AUTH,
// a JSON object {consumer_key, consumer_secret, access_token, access_secret}.
// One env var means the whole OAuth 1.0a material fits a single runx
// credential envelope (--credential twitter:oauth1_user:<ref>
// --credential-scope twitter:write --secret-env TWITTER_USER_AUTH).
export function userCredentials() {
  const packed = process.env.TWITTER_USER_AUTH;
  if (typeof packed !== "string" || packed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(packed);
  } catch {
    return null;
  }
  const creds = {
    consumerKey: parsed.consumer_key,
    consumerSecret: parsed.consumer_secret,
    accessToken: parsed.access_token,
    accessSecret: parsed.access_secret,
  };
  return Object.values(creds).every((value) => typeof value === "string" && value.length > 0)
    ? creds
    : null;
}

export const USER_AUTH_BLOCKER =
  "user-context credential is missing: deliver TWITTER_USER_AUTH (JSON with consumer_key, consumer_secret, access_token, access_secret) via runx skill --credential twitter:oauth1_user:<material_ref> --credential-scope twitter:write --secret-env TWITTER_USER_AUTH";

export function bearerToken() {
  const token = process.env.TWITTER_BEARER_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function percentEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function oauth1Header(method, url, queryParams, creds) {
  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: `${Math.floor(Date.now() / 1000)}`,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const allParams = { ...queryParams, ...oauthParams };
  const paramString = Object.keys(allParams)
    .map((key) => [percentEncode(key), percentEncode(String(allParams[key]))])
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const baseUrl = url.split("?")[0];
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");
  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header = Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

function rateInfo(response) {
  const reset = response.headers.get("x-rate-limit-reset");
  return {
    limited: response.status === 429,
    remaining: Number(response.headers.get("x-rate-limit-remaining") ?? -1),
    reset_at: reset ? new Date(Number(reset) * 1000).toISOString() : null,
  };
}

export async function apiRequest({ method, pathName, query = {}, body = null, auth = "user" }) {
  const url = new URL(pathName, API_BASE);
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`host ${url.hostname} is outside the twitter provider allowlist`);
  }
  const cleanQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") cleanQuery[key] = String(value);
  }
  for (const [key, value] of Object.entries(cleanQuery)) url.searchParams.set(key, value);

  const headers = {};
  if (auth === "user") {
    const creds = userCredentials();
    if (!creds) throw new Error("user-context credentials are missing");
    headers.authorization = oauth1Header(method, url.toString(), cleanQuery, creds);
  } else {
    const token = bearerToken();
    if (!token) throw new Error("TWITTER_BEARER_TOKEN is missing");
    headers.authorization = `Bearer ${token}`;
  }
  const init = { method: method.toUpperCase(), headers };
  if (body !== null) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: response.status, ok: response.ok, json, rate: rateInfo(response) };
}

export function apiErrorDetail(result) {
  const body = result.json ?? {};
  const first = Array.isArray(body.errors) ? body.errors[0] : null;
  return first?.detail || first?.message || body.detail || body.title || `HTTP ${result.status}`;
}

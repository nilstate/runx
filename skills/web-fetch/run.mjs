#!/usr/bin/env node

import { createHash } from "node:crypto";

const inputs = loadInputs();
const urlInput = optionalString(inputs.url);
const allowlist = normalizeAllowlist(inputs.allowlist);
const extractMode = optionalString(inputs.extract) ?? "text";
const maxBytes = positiveInteger(inputs.max_bytes, 1_000_000);

if (!urlInput || allowlist.length === 0) {
  writeResult({
    decision: "needs_agent",
    final_url: "",
    status: 0,
    content_digest: "",
    extract_mode: extractMode,
    extracted: extractMode === "metadata" ? {} : extractMode === "links" ? [] : "",
    provenance: emptyProvenance(),
    policy: {
      allowlist_decision: "denied",
      attempted_host: urlInput ? safeHost(urlInput) : "",
      allowlist_checked: allowlist,
    },
    blockers: [
      ...(!urlInput ? ["url is missing"] : []),
      ...(allowlist.length === 0 ? ["allowlist is missing"] : []),
    ],
  });
  process.exit(0);
}

if (!new Set(["text", "metadata", "links"]).has(extractMode)) {
  writeResult(failedResult({
    decision: "needs_agent",
    attemptedHost: safeHost(urlInput),
    allowlist,
    extractMode,
    blocker: "extract must be text, metadata, or links",
  }));
  process.exit(0);
}

let initialUrl;
try {
  initialUrl = parseHttpUrl(urlInput);
} catch (error) {
  writeResult(failedResult({
    decision: "needs_agent",
    attemptedHost: safeHost(urlInput),
    allowlist,
    extractMode,
    blocker: error instanceof Error ? error.message : String(error),
  }));
  process.exit(0);
}

if (!hostAllowed(initialUrl.hostname, allowlist)) {
  writeResult(failedResult({
    decision: "policy_denied",
    attemptedHost: initialUrl.hostname,
    allowlist,
    extractMode,
    blocker: `host '${initialUrl.hostname}' is not allowlisted`,
  }));
  process.exit(0);
}

try {
  const fetched = await fetchBounded(initialUrl, allowlist, maxBytes);
  const contentType = fetched.headers.get("content-type") ?? "";
  const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(fetched.bytes);
  writeResult({
    decision: fetched.status >= 200 && fetched.status < 300 ? "ready" : "provider_error",
    final_url: fetched.url.href,
    status: fetched.status,
    content_digest: `sha256:${createHash("sha256").update(fetched.bytes).digest("hex")}`,
    extract_mode: extractMode,
    extracted: extractContent(bodyText, extractMode, fetched.url, contentType),
    provenance: {
      fetched_at: new Date().toISOString(),
      redirects: fetched.redirects,
      bytes: fetched.bytes.length,
      truncated: fetched.truncated,
    },
    policy: {
      allowlist_decision: "allowed",
      attempted_host: initialUrl.hostname,
      allowlist_checked: allowlist,
    },
    blockers: fetched.status >= 200 && fetched.status < 300
      ? []
      : [`provider returned HTTP ${fetched.status}`],
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const denied = message.startsWith("redirect host '");
  writeResult(failedResult({
    decision: denied ? "policy_denied" : "provider_error",
    attemptedHost: initialUrl.hostname,
    allowlist,
    extractMode,
    blocker: message,
  }));
}

async function fetchBounded(startUrl, allowedHosts, byteLimit) {
  let current = startUrl;
  const redirects = [];
  for (let hop = 0; hop <= 10; hop += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1",
        "user-agent": "runx-web-fetch/0.2",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`provider returned redirect HTTP ${response.status} without a location`);
      }
      if (hop === 10) {
        throw new Error("provider exceeded 10 redirects");
      }
      const next = parseHttpUrl(new URL(location, current).href);
      if (!hostAllowed(next.hostname, allowedHosts)) {
        throw new Error(`redirect host '${next.hostname}' is not allowlisted`);
      }
      redirects.push({ status: response.status, from: current.href, to: next.href });
      current = next;
      continue;
    }
    const { bytes, truncated } = await readBounded(response.body, byteLimit);
    return {
      url: current,
      status: response.status,
      headers: response.headers,
      bytes,
      truncated,
      redirects,
    };
  }
  throw new Error("provider exceeded redirect limit");
}

async function readBounded(body, byteLimit) {
  if (!body) {
    return { bytes: new Uint8Array(), truncated: false };
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > byteLimit) {
      chunks.push(value.subarray(0, byteLimit - total));
      total = byteLimit;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function extractContent(body, mode, baseUrl, contentType) {
  if (mode === "metadata") {
    return {
      title: firstMatch(body, /<title[^>]*>([\s\S]*?)<\/title>/iu),
      description: metaContent(body, "description"),
      canonical: linkHref(body, "canonical", baseUrl),
      declared_language: firstMatch(body, /<html[^>]*\blang=["']([^"']+)["']/iu),
      content_type: contentType,
    };
  }
  if (mode === "links") {
    const links = [];
    const seen = new Set();
    for (const match of body.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/giu)) {
      try {
        const href = new URL(decodeEntities(match[1]), baseUrl).href;
        if (!seen.has(href)) {
          seen.add(href);
          links.push(href);
        }
      } catch {
        // Ignore malformed link targets; provenance remains bound to the body.
      }
    }
    return links;
  }
  return decodeEntities(
    body
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function normalizeAllowlist(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.hosts)
      ? value.hosts
      : [];
  return [...new Set(entries
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/u, ""))
    .filter(Boolean))];
}

function hostAllowed(hostname, allowlist) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return allowlist.some((entry) => entry === host
    || (entry.startsWith("*.") && host.endsWith(entry.slice(1)) && host !== entry.slice(2)));
}

function parseHttpUrl(value) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("url must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("url must not contain credentials");
  }
  return parsed;
}

function failedResult({ decision, attemptedHost, allowlist, extractMode, blocker }) {
  return {
    decision,
    final_url: "",
    status: 0,
    content_digest: "",
    extract_mode: extractMode,
    extracted: extractMode === "metadata" ? {} : extractMode === "links" ? [] : "",
    provenance: emptyProvenance(),
    policy: {
      allowlist_decision: "denied",
      attempted_host: attemptedHost,
      allowlist_checked: allowlist,
    },
    blockers: [blocker],
  };
}

function emptyProvenance() {
  return { fetched_at: "", redirects: [], bytes: 0, truncated: false };
}

function metaContent(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return firstMatch(body, new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "iu"))
    ?? firstMatch(body, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`, "iu"));
}

function linkHref(body, rel, baseUrl) {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const href = firstMatch(body, new RegExp(`<link[^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]+href=["']([^"']+)["']`, "iu"));
  if (!href) return null;
  try {
    return new URL(decodeEntities(href), baseUrl).href;
  } catch {
    return null;
  }
}

function firstMatch(value, pattern) {
  const match = pattern.exec(value);
  return match ? decodeEntities(match[1].replace(/\s+/gu, " ").trim()) : null;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function safeHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function loadInputs() {
  try {
    const parsed = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeResult(fetchResult) {
  process.stdout.write(`${JSON.stringify({ fetch_result: fetchResult })}\n`);
}

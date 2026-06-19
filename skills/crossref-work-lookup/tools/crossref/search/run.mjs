import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(toolDir, "../../..");

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : (process.env.RUNX_INPUTS_JSON || "{}");
  return JSON.parse(raw);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

async function providerPayload(inputs) {
  if (inputs.fixture_path) {
    const file = path.resolve(packageRoot, String(inputs.fixture_path));
    if (file !== packageRoot && !file.startsWith(packageRoot + path.sep)) {
      throw new Error("fixture_path escapes the skill package");
    }
    return {
      mode: "fixture",
      url: `file://${String(inputs.fixture_path).replaceAll("\\", "/")}`,
      status: 200,
      body: fs.readFileSync(file, "utf8"),
    };
  }

  const query = encodeURIComponent(inputs.query);
  const url = `https://api.crossref.org/works?query.bibliographic=${query}&rows=${inputs.limit}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "runx-crossref-work-lookup/0.1.0 (mailto:community@runx.ai)",
    },
  });
  return { mode: "live", url, status: response.status, body: await response.text() };
}

function yearOf(item) {
  const parts = item?.published?.["date-parts"];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? Number(parts[0][0]) : NaN;
  return Number.isFinite(year) ? year : null;
}

function compact(item) {
  return {
    doi: String(item?.DOI || ""),
    title: String(Array.isArray(item?.title) ? item.title[0] || "" : item?.title || ""),
    authors: Array.isArray(item?.author)
      ? item.author.slice(0, 5).map((author) => [author?.given, author?.family].filter(Boolean).join(" "))
      : [],
    published_year: yearOf(item),
    url: String(item?.URL || ""),
  };
}

async function main() {
  const rawInputs = readInputs();
  const query = String(rawInputs.query || "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.max(1, Math.min(Number(rawInputs.limit || 3), 10));
  const observed = await providerPayload({ ...rawInputs, query, limit });
  if (observed.status !== 200) throw new Error(`Crossref returned HTTP ${observed.status}`);
  const parsed = JSON.parse(observed.body);
  const items = Array.isArray(parsed?.message?.items) ? parsed.message.items : [];

  process.stdout.write(JSON.stringify({
    schema: "runx.crossref.work_search_result.v1",
    data: {
      decision: "ready",
      provider: "crossref",
      connector: {
        id: "crossref-public-works",
        transport: "nango",
        auth: "none",
        scope_used: "crossref:works:read"
      },
      request: { method: "GET", host: "api.crossref.org", path: "/works", query, limit },
      result: {
        total_results: Number(parsed?.message?.["total-results"] || items.length),
        returned: Math.min(items.length, limit),
        works: items.slice(0, limit).map(compact)
      },
      provenance: {
        mode: observed.mode,
        final_url: observed.url,
        status: observed.status,
        payload_digest: digest(observed.body),
        observed_at: observed.mode === "fixture" ? "2026-06-19T22:45:00Z" : new Date().toISOString()
      },
      policy: {
        allowlist_decision: "allowed",
        allowed_host: "api.crossref.org",
        allowed_path: "/works",
        allowed_method: "GET",
        mutation_allowed: false,
        credential_material_allowed: false
      }
    }
  }));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
  process.exitCode = 1;
});


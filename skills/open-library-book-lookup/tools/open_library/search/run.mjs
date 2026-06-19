import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILTIN_FIXTURES = {
  "fixtures/open-library-search-response.json": JSON.stringify({
    numFound: 2,
    start: 0,
    numFoundExact: true,
    docs: [
      {
        key: "/works/OL31574W",
        title: "The Left Hand of Darkness",
        author_name: ["Ursula K. Le Guin"],
        first_publish_year: 1969,
        edition_count: 95,
      },
      {
        key: "/works/OL27396W",
        title: "The Dispossessed",
        author_name: ["Ursula K. Le Guin"],
        first_publish_year: 1974,
        edition_count: 88,
      },
    ],
  }),
};

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : (process.env.RUNX_INPUTS_JSON || "{}");
  return JSON.parse(raw);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function resolvePackageRoot() {
  return path.resolve(__dirname, "../../..");
}

async function readProviderPayload(inputs) {
  if (inputs.fixture_path) {
    const fixturePath = path.resolve(resolvePackageRoot(), String(inputs.fixture_path));
    const root = resolvePackageRoot();
    if (!fixturePath.startsWith(root + path.sep) && fixturePath !== root) {
      throw new Error("fixture_path escapes the skill package");
    }
    if (!fs.existsSync(fixturePath) && BUILTIN_FIXTURES[String(inputs.fixture_path)]) {
      return {
        mode: "fixture",
        url: `builtin://${String(inputs.fixture_path).replaceAll("\\", "/")}`,
        body: BUILTIN_FIXTURES[String(inputs.fixture_path)],
        status: 200,
      };
    }
    return {
      mode: "fixture",
      url: `file://${String(inputs.fixture_path).replaceAll("\\", "/")}`,
      body: fs.readFileSync(fixturePath, "utf8"),
      status: 200,
    };
  }

  const query = encodeURIComponent(String(inputs.query || ""));
  const limit = Math.max(1, Math.min(Number(inputs.limit || 3), 10));
  const url = `https://openlibrary.org/search.json?q=${query}&limit=${limit}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "runx-open-library-book-lookup/0.1.0",
      "Accept": "application/json",
    },
  });
  return {
    mode: "live",
    url,
    body: await response.text(),
    status: response.status,
  };
}

function compactDocs(docs, limit) {
  return docs.slice(0, limit).map((doc) => ({
    key: String(doc.key || ""),
    title: String(doc.title || ""),
    author_names: Array.isArray(doc.author_name) ? doc.author_name.slice(0, 3).map(String) : [],
    first_publish_year: Number.isFinite(Number(doc.first_publish_year)) ? Number(doc.first_publish_year) : null,
    edition_count: Number.isFinite(Number(doc.edition_count)) ? Number(doc.edition_count) : 0,
  }));
}

async function main() {
  const inputs = readInputs();
  const query = String(inputs.query || "").trim();
  if (!query) {
    throw new Error("query is required");
  }
  const limit = Math.max(1, Math.min(Number(inputs.limit || 3), 10));
  const observed = await readProviderPayload({ ...inputs, query, limit });
  const parsed = JSON.parse(observed.body);
  const docs = Array.isArray(parsed.docs) ? parsed.docs : [];
  const packet = {
    schema: "runx.open_library.search_result.v1",
    data: {
      decision: "ready",
      provider: "open-library",
      connector: {
        id: "open-library-public-search",
        transport: "nango",
        auth: "none",
        scope_used: "open-library:search:read",
      },
      request: {
        method: "GET",
        host: "openlibrary.org",
        path: "/search.json",
        query,
        limit,
      },
      result: {
        num_found: Number.isFinite(Number(parsed.numFound)) ? Number(parsed.numFound) : docs.length,
        returned: Math.min(docs.length, limit),
        works: compactDocs(docs, limit),
      },
      provenance: {
        mode: observed.mode,
        final_url: observed.url,
        status: observed.status,
        payload_digest: sha256(observed.body),
        observed_at: observed.mode === "fixture" ? "2026-06-19T07:45:00Z" : new Date().toISOString(),
      },
      policy: {
        allowlist_decision: "allowed",
        allowed_host: "openlibrary.org",
        allowed_path: "/search.json",
        allowed_method: "GET",
        mutation_allowed: false,
        credential_material_allowed: false,
      },
    },
  };
  process.stdout.write(JSON.stringify(packet));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
  process.exitCode = 1;
});

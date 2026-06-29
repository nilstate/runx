import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "runx.verifiable_web_research.result.v1";
const LEVELS = new Set(["basic", "detailed", "audit_ready"]);
const BUILTIN_FIXTURES = {
  "builtin:ai-agent-frameworks": {
    sources: [
      {
        url: "https://example.org/langchain-pricing",
        final_url: "https://example.org/langchain-pricing",
        fetched_at: "2026-06-22T00:00:00Z",
        status: 200,
        content: "LangChain is open source. LangSmith is an optional hosted observability product with a free developer tier.",
        extracts: [
          {
            claim: "LangChain has an open-source framework and an optional hosted observability product.",
            quote: "LangChain is open source. LangSmith is an optional hosted observability product with a free developer tier.",
          },
        ],
      },
      {
        url: "https://example.org/crewai-docs",
        final_url: "https://example.org/crewai-docs",
        fetched_at: "2026-06-22T00:00:05Z",
        status: 200,
        content: "CrewAI provides a multi-agent framework with hosted enterprise options for teams.",
        extracts: [
          {
            claim: "CrewAI offers a multi-agent framework with hosted enterprise options.",
            quote: "CrewAI provides a multi-agent framework with hosted enterprise options for teams.",
          },
        ],
      },
    ],
  },
};

const inputs = readInputs();
const skillRoot = process.cwd();
const objective = stringValue(inputs.objective);
const fixturePath = stringValue(inputs.source_fixture_path);
const verificationLevel = stringValue(inputs.verification_level) || "detailed";
const maxClaims = Number.isFinite(inputs.max_claims) ? Math.max(1, Math.trunc(inputs.max_claims)) : 10;

if (!objective) throw new Error("objective is required");
if (!fixturePath) throw new Error("source_fixture_path is required");
if (!LEVELS.has(verificationLevel)) throw new Error("verification_level must be basic, detailed, or audit_ready");

const fixture = readFixture(fixturePath, skillRoot);
const packet = buildPacket({ objective, fixture, verificationLevel, maxClaims });
const report = renderReport(packet);

writeArtifacts(inputs.output_dir, packet, report, skillRoot);

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function readFixture(relativePath, root) {
  if (Object.hasOwn(BUILTIN_FIXTURES, relativePath)) {
    const text = JSON.stringify(BUILTIN_FIXTURES[relativePath]);
    return { ref: relativePath, text, sources: BUILTIN_FIXTURES[relativePath].sources };
  }
  const resolved = path.resolve(root, relativePath);
  ensureInside(root, resolved, "source_fixture_path");
  const text = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    throw new Error("fixture must contain a non-empty sources array");
  }
  return { ref: relativePath, text, sources: parsed.sources };
}

function buildPacket({ objective, fixture, verificationLevel, maxClaims }) {
  const sourceRecords = fixture.sources.map((source) => normalizeSource(source));
  const claims = [];

  for (const source of sourceRecords) {
    for (const extract of source.extracts) {
      if (claims.length >= maxClaims) break;
      claims.push({
        claim: extract.claim,
        source_url: source.url,
        final_url: source.final_url,
        accessed_at: source.fetched_at,
        content_digest: source.content_digest,
        extract: extract.quote,
        confidence: "verified",
        confidence_reasoning: "The claim is backed by an exact extract from the captured source snapshot.",
        http_status: source.status,
        bytes: source.bytes,
      });
    }
    if (claims.length >= maxClaims) break;
  }

  const data = {
    objective,
    verification_level: verificationLevel,
    summary: `${claims.length} claim(s) are backed by exact source extracts from ${sourceRecords.length} captured source(s).`,
    claims: verificationLevel === "basic"
      ? claims.map(({ content_digest, http_status, bytes, ...claim }) => claim)
      : claims,
    open_questions: [],
    verification_guide: verificationGuide(sourceRecords, verificationLevel),
    fixture: {
      ref: fixture.ref,
      sha256: sha256(fixture.text),
      sources: sourceRecords.length,
    },
  };

  if (verificationLevel !== "basic") {
    data.evidence_archive = {
      sources: verificationLevel === "audit_ready"
        ? sourceRecords
        : sourceRecords.map(({ content, ...source }) => source),
    };
  }

  return { schema: SCHEMA, data };
}

function normalizeSource(source) {
  for (const field of ["url", "final_url", "fetched_at", "content"]) {
    if (!stringValue(source[field])) throw new Error(`source.${field} is required`);
  }
  if (!Array.isArray(source.extracts) || source.extracts.length === 0) {
    throw new Error(`source ${source.url} must contain extracts`);
  }
  return {
    url: source.url,
    final_url: source.final_url,
    fetched_at: source.fetched_at,
    status: Number.isFinite(source.status) ? source.status : null,
    bytes: Buffer.byteLength(source.content),
    content_digest: `sha256:${sha256(source.content)}`,
    content: source.content,
    extracts: source.extracts.map((extract) => {
      if (!stringValue(extract.claim) || !stringValue(extract.quote)) {
        throw new Error(`source ${source.url} extracts require claim and quote`);
      }
      if (!source.content.includes(extract.quote)) {
        throw new Error(`source ${source.url} quote must appear in content`);
      }
      return { claim: extract.claim, quote: extract.quote };
    }),
  };
}

function verificationGuide(sources, level) {
  const steps = sources.map((source) => ({
    action: "Re-fetch source and compare the quoted extract",
    target: source.final_url,
    expected: `HTTP ${source.status}; content includes at least one recorded extract; captured digest was ${source.content_digest}`,
  }));

  const guide = {
    overview: "Each claim can be checked by re-fetching the final URL and comparing the exact extract. Digest mismatch means the source changed after capture.",
    steps,
  };

  if (level === "audit_ready") {
    guide.replay_instructions = {
      commands: sources.map((source) => `curl -L ${source.final_url}`),
      digest_algorithm: "sha256 over the captured response body",
    };
  }

  return guide;
}

function renderReport(packet) {
  const data = packet.data;
  const lines = [
    "# Verifiable Web Research Packet",
    "",
    `Objective: ${data.objective}`,
    `Verification level: ${data.verification_level}`,
    "",
    "## Summary",
    "",
    data.summary,
    "",
    "## Claims",
    "",
  ];

  for (const claim of data.claims) {
    lines.push(`- ${claim.claim}`);
    lines.push(`  - Source: ${claim.final_url}`);
    lines.push(`  - Extract: ${claim.extract}`);
    if (claim.content_digest) lines.push(`  - Digest: ${claim.content_digest}`);
  }

  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push(data.verification_guide.overview);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function writeArtifacts(outputDir, packet, report, root) {
  if (!outputDir) {
    packet.data.artifacts = {};
    return;
  }
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  const evidencePath = path.join(resolved, "evidence.json");
  const reportPath = path.join(resolved, "report.md");
  packet.data.artifacts = {
    evidence_json: path.relative(root, evidencePath),
    report_md: path.relative(root, reportPath),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(reportPath, report);
}

function ensureInside(root, resolved, label) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

import fs from "node:fs";
import net from "node:net";
import { createHash } from "node:crypto";

const inputs = readInputs();
const prospect = objectValue(inputs.prospect);
const icp = normalizeIcp(inputs.icp);
const allowlist = normalizeAllowlist(inputs.source_allowlist);

try {
  const result = await buildPacket({ prospect, icp, allowlist });
  emit(result);
} catch (error) {
  emit(refusal(error.code ?? "invalid_input", error.message));
  process.exit(2);
}

async function buildPacket({ prospect, icp, allowlist }) {
  const company = stringField(prospect, "company");
  if (!company) throw problem("missing_company", "prospect.company is required.");
  if (!icp.target && !icp.offer) {
    throw problem("missing_icp", "icp must describe the target or offer.");
  }
  if (allowlist.length === 0) {
    throw problem("missing_allowlist", "source_allowlist must contain at least one public host.");
  }

  const declaredSources = Array.isArray(prospect.public_sources) ? prospect.public_sources : [];
  if (declaredSources.length === 0) {
    throw problem("missing_public_sources", "At least one public source is required; refusing to invent account facts.");
  }

  const sources = [];
  for (const source of declaredSources) {
    sources.push(await readSource(source, allowlist));
  }

  const usableSources = sources.filter((source) => source.snippets.length > 0);
  if (usableSources.length === 0) {
    throw problem("thin_sources", "No usable public-source snippets were available.");
  }

  const angle = buildAngle(company, prospect.contact, icp, usableSources);
  const sequence = buildSequence(company, prospect.contact, icp, usableSources, angle);
  const sendProposal = buildSendProposal(company, prospect.contact, sequence, usableSources, icp);

  return {
    schema: "prospect_sequence_packet.v1",
    status: "sealed",
    prospect: {
      company,
      contact: contactSummary(prospect.contact),
    },
    research: {
      sources: usableSources.map(({ content, ...source }) => source),
      angle,
      guardrails: {
        source_policy: "allowlisted public HTTP(S) sources only",
        fabrication_policy: "facts must appear in cited snippets",
        citation_policy: "every source used in the angle has a citation marker",
      },
    },
    sequence,
    send_proposal: sendProposal,
  };
}

async function readSource(rawSource, allowlist) {
  const url = stringField(rawSource, "url");
  if (!url) throw problem("missing_source_url", "Each public source must include url.");
  const parsed = validatePublicUrl(url, allowlist);
  const contentFromFixture = stringField(rawSource, "content");
  const title = stringField(rawSource, "title") ?? parsed.hostname;

  let content = contentFromFixture;
  let readMode = "fixture_content";
  if (!content) {
    content = await fetchPublicSource(url);
    readMode = "governed_http_fetch";
  }

  const snippets = extractSnippets(content);
  return {
    citation_id: `S${hashShort(url)}`,
    url,
    host: parsed.hostname,
    title,
    read_mode: readMode,
    snippets,
    content,
  };
}

function validatePublicUrl(rawUrl, allowlist) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw problem("invalid_url", `Invalid source URL: ${rawUrl}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw problem("unsupported_scheme", `Only HTTP(S) public sources are allowed: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw problem("private_network_refused", `Private, localhost, or link-local host refused: ${host}`);
  }
  if (!allowlist.includes(host)) {
    throw problem("off_allowlist_refused", `Host ${host} is not in source_allowlist.`);
  }
  return parsed;
}

async function fetchPublicSource(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "runx-prospect-sequence/0.1" },
    });
    if (!response.ok) {
      throw problem("source_fetch_failed", `Public source returned HTTP ${response.status}: ${url}`);
    }
    const text = await response.text();
    return text.slice(0, 6000);
  } finally {
    clearTimeout(timeout);
  }
}

function extractSnippets(content) {
  const text = stripHtml(String(content ?? ""));
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 30);
  return sentences.slice(0, 3);
}

function buildAngle(company, contact, icp, sources) {
  const sourceText = sources
    .map((source) => `${source.snippets[0]} [${source.citation_id}]`)
    .join(" ");
  const role = contactSummary(contact)?.title ?? icp.target ?? "the team";
  const offer = icp.offer ?? "a focused review";
  return {
    summary: `${company} appears relevant to ${role} because ${sourceText} The outreach angle is to offer ${offer} while keeping every claim tied to those public citations.`,
    citations: sources.map((source) => source.citation_id),
    source_count: sources.length,
  };
}

function buildSequence(company, contact, icp, sources, angle) {
  const name = contactSummary(contact)?.name ?? "there";
  const firstEvidence = sources[0].snippets[0];
  const secondEvidence = sources[1]?.snippets[0] ?? sources[0].snippets[1] ?? firstEvidence;
  const offer = icp.offer ?? "a short account-specific review";
  const pain = icp.pain ?? "the workflow described in the public sources";
  const tone = icp.tone ?? "concise";
  const citations = angle.citations;

  return [
    {
      step: 1,
      channel: "email",
      subject: `${company} and ${pain}`,
      body: `Hi ${name}, I noticed ${firstEvidence} [${citations[0]}]. If ${pain} is on your list, I can share ${offer}.`,
      citations: [citations[0]],
      tone,
    },
    {
      step: 2,
      channel: "email",
      subject: `Quick follow-up for ${company}`,
      body: `Following up because the public material also points to ${secondEvidence} [${citations[Math.min(1, citations.length - 1)]}]. A small governed workflow review could turn that into a repeatable sequence.`,
      citations: [citations[Math.min(1, citations.length - 1)]],
      tone,
    },
    {
      step: 3,
      channel: "email",
      subject: `Close the loop?`,
      body: `I do not want to assume priorities beyond the public sources. If useful, I can send a one-page review mapped to ${citations.map((id) => `[${id}]`).join(" ")} and you can decide whether it is worth a deeper look.`,
      citations,
      tone,
    },
  ];
}

function buildSendProposal(company, contact, sequence, sources, icp) {
  const digest = createHash("sha256").update(JSON.stringify(sequence)).digest("hex");
  return {
    effect: "proposed",
    catalog_skill: "send-as",
    action_family: "send-as",
    send_class: "outreach",
    required_scope: "send_as.outreach.propose",
    human_approval_required: true,
    live_send_authorized: false,
    principal: { type: "account", ref: "caller_supplied_principal_required" },
    audience: {
      type: "recipient",
      ref: contactSummary(contact)?.name ?? `${company} contact`,
      requires_reconfirmation: true,
    },
    content: {
      draft_ref: `prospect-sequence:${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      digest: `sha256:${digest}`,
      subject_or_title: sequence[0].subject,
    },
    consent_basis: icp.consent_basis ?? "requires caller-provided lawful outreach basis before send-as execution",
    evidence_refs: sources.map((source) => ({
      citation_id: source.citation_id,
      url: source.url,
    })),
    gates: {
      preflight_required: true,
      human_approval_required: true,
      executor: "send-as",
    },
    provider_actions: ["send-as.plan", "human_approval", "provider_send_after_gate"],
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    prospect: parseMaybeJson(process.env.RUNX_INPUT_PROSPECT),
    icp: parseMaybeJson(process.env.RUNX_INPUT_ICP),
    source_allowlist: parseMaybeJson(process.env.RUNX_INPUT_SOURCE_ALLOWLIST),
  };
}

function parseMaybeJson(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeIcp(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") return { target: value };
  return {};
}

function normalizeAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map((item) => item.replace(/^https?:\/\//, "").split("/")[0]);
}

function stringField(object, key) {
  const value = objectValue(object)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contactSummary(contact) {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) return null;
  const name = typeof contact.name === "string" ? contact.name.trim() : "";
  const title = typeof contact.title === "string" ? contact.title.trim() : "";
  return {
    name: name || null,
    title: title || null,
  };
}

function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe80:");
  }
  return false;
}

function stripHtml(value) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function hashShort(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function refusal(reasonCode, message) {
  return {
    schema: "prospect_sequence_packet.v1",
    status: "refused",
    refusal: {
      reason_code: reasonCode,
      message,
    },
    research: {
      sources: [],
      angle: null,
    },
    sequence: [],
    send_proposal: null,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const prospect = objectInput(inputs.prospect, "prospect");
const icp = objectInput(inputs.icp, "icp");
const sourceAllowlist = normalizeSourceAllowlist(inputs.source_allowlist);

const result = decide(prospect, icp, sourceAllowlist);
process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
if (!result.ok) process.exit(64);

function decide(prospectInput, icpInput, allowlist) {
  const company = stringValue(prospectInput.company);
  const contact = stringValue(prospectInput.contact) ?? stringValue(prospectInput.role) ?? "operator";
  const product = stringValue(icpInput.product) ?? "the product";
  const audience = stringValue(icpInput.audience) ?? "operators";
  const valueProps = arrayStrings(icpInput.value_props);
  const pains = arrayStrings(icpInput.pain_points);

  const validSources = [];
  const refusedSources = [];
  for (const source of allowlist.sources) {
    const checked = checkSource(source, allowlist.allowedHosts);
    if (checked.ok) validSources.push(checked.source);
    else refusedSources.push({ url: stringValue(source.url), reason: checked.reason });
  }

  if (!company) return refusal("missing_company", prospectInput, icpInput, allowlist, refusedSources);
  if (validSources.length === 0) {
    return refusal("no_allowlisted_public_sources", prospectInput, icpInput, allowlist, refusedSources);
  }

  const sourceFacts = validSources.map((source) => ({
    title: source.title,
    url: source.url,
    facts: extractFacts(source.text, company, pains, valueProps),
  }));
  const citedFact = sourceFacts.find((source) => source.facts.length > 0) ?? sourceFacts[0];
  const factText = citedFact.facts[0] ?? `${company} has public source material available for account research.`;
  const valueProp = valueProps[0] ?? "reduce operational risk with a focused workflow";
  const pain = pains[0] ?? "manual review load";
  const angle = `${company} appears to be dealing with ${pain}; position ${product} around ${valueProp}. Source: ${citedFact.url}`;
  const sequence = [
    {
      touch: 1,
      channel: "email",
      subject: `${company} and ${pain}`,
      body: `Hi ${contact}, I noticed ${factText} (${citedFact.url}). ${product} may help ${audience} ${valueProp}. Worth comparing notes?`,
    },
    {
      touch: 2,
      channel: "email",
      subject: `Quick follow-up on ${company}`,
      body: `Following up with the specific angle: ${angle} If this is a priority, I can share a short checklist tailored to your public workflow.`,
    },
    {
      touch: 3,
      channel: "email",
      subject: `Checklist for ${pain}`,
      body: `A useful first step is mapping the current ${pain} process, the approval owner, and the failure mode. ${product} fits when that process needs a repeatable evidence trail.`,
    },
    {
      touch: 4,
      channel: "email",
      subject: `Close the loop?`,
      body: `I will close the loop unless ${pain} is active this quarter. If helpful, I can send a one-page plan based only on public sources already cited above.`,
    },
  ];

  const proposalId = `send:${digest({ company, contact, angle })}`;
  return {
    ok: true,
    output: {
      summary: `Prepared a sourced ${sequence.length}-touch outreach sequence for ${company}; send is gated through send-as.`,
      research: {
        sources: sourceFacts,
        angle,
      },
      sequence,
      send_proposal: {
        id: proposalId,
        gated: true,
        effect: {
          kind: "send_proposal",
          consumer: "send-as",
          performs_send: false,
        },
        prospect: { company, contact },
        sequence_length: sequence.length,
        required_review: ["confirm recipient consent or legitimate outreach basis", "operator approval before send-as"],
      },
    },
  };
}

function refusal(reason, prospectInput, icpInput, allowlist, refusedSources) {
  return {
    ok: false,
    output: {
      summary: `Prospect sequence refused: ${reason}. No send proposal was emitted.`,
      research: {
        sources: [],
        angle: null,
      },
      sequence: [],
      send_proposal: null,
      refusal: {
        reason,
        prospect: prospectInput,
        icp: icpInput,
        allowed_hosts: allowlist.allowedHosts,
        refused_sources: refusedSources,
        required_evidence: ["allowlisted public http(s) source with readable text"],
      },
    },
  };
}

function normalizeSourceAllowlist(value) {
  const input = objectInput(value, "source_allowlist");
  const sources = Array.isArray(input) ? input : input.sources;
  const allowedHosts = new Set(arrayStrings(input.allowed_hosts).map((host) => host.toLowerCase()));
  return { sources: Array.isArray(sources) ? sources : [], allowedHosts };
}

function checkSource(source, allowedHosts) {
  if (!source || typeof source !== "object") return { ok: false, reason: "source_not_object" };
  const urlText = stringValue(source.url);
  const text = stringValue(source.text);
  const title = stringValue(source.title) ?? urlText;
  if (!urlText || !text) return { ok: false, reason: "missing_url_or_text" };
  let url;
  try {
    url = new URL(urlText);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!["https:", "http:"].includes(url.protocol)) return { ok: false, reason: "non_http_source" };
  if (isPrivateHost(url.hostname)) return { ok: false, reason: "private_or_loopback_host" };
  if (allowedHosts.size > 0 && !allowedHosts.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: "host_not_allowlisted" };
  }
  return { ok: true, source: { url: url.href, title, text } };
}

function extractFacts(text, company, pains, valueProps) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const terms = [company, ...pains, ...valueProps].map((term) => term.toLowerCase()).filter(Boolean);
  return sentences
    .filter((sentence) => terms.some((term) => sentence.toLowerCase().includes(term)))
    .slice(0, 3);
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    prospect: parseInputValue(process.env.RUNX_INPUT_PROSPECT),
    icp: parseInputValue(process.env.RUNX_INPUT_ICP),
    source_allowlist: parseInputValue(process.env.RUNX_INPUT_SOURCE_ALLOWLIST),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectInput(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    process.stderr.write(`${name} must be an object\n`);
    process.exit(64);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayStrings(value) {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^(10|127)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

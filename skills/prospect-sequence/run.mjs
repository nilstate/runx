#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const input = readInput();
const prospect = input.prospect ?? {};
const icp = input.icp ?? {};
const allowlist = Array.isArray(input.source_allowlist) ? input.source_allowlist : [];
const sources = Array.isArray(input.sources) ? input.sources : [];

const output = decide();
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function decide() {
  if (!prospect.company || !icp.offer) {
    return refused("prospect.company and icp.offer are required");
  }
  if (allowlist.length === 0) {
    return refused("source_allowlist must contain at least one public host or URL prefix");
  }
  if (sources.length === 0) {
    return needsAgent("no public sources supplied; refusing to fabricate account facts");
  }

  const checked = [];
  for (const source of sources) {
    const check = checkSource(source);
    checked.push(check);
    if (check.decision !== "allowed") {
      return policyDenied(check.reason, checked);
    }
  }

  const usedSources = checked.map((check, index) => ({
    id: `source-${index + 1}`,
    url: check.url,
    title: sources[index].title ?? check.host,
    excerpt_digest: digest(sources[index].excerpt ?? ""),
    citation: `[source-${index + 1}] ${sources[index].title ?? check.host} (${check.url})`,
  }));

  const angle = [
    `${prospect.company} has public signals around ${icp.pain ?? "the stated operating pain"}.`,
    `That maps to ${icp.offer}.`,
    `Use ${usedSources.map((source) => source.id).join(", ")} as the evidence base; do not add unsourced claims.`,
  ].join(" ");

  const sequence = [
    {
      step: 1,
      channel: "email",
      subject: `Idea for ${prospect.company}'s exception workflow`,
      body: `${prospect.contact ?? "Hi"} - I noticed ${summarizeSource(sources[0])}. It seems adjacent to ${icp.pain ?? "your operating priorities"}. Would it be useful to compare how governed agent workflows keep that motion auditable?`,
      citations: [usedSources[0].id],
    },
    {
      step: 2,
      channel: "email",
      subject: `A governed follow-up for ${prospect.company}`,
      body: `Following up with a narrower angle: ${icp.offer} can propose next actions while keeping sends behind approval. The public source trail is ${usedSources.map((source) => source.id).join(", ")}.`,
      citations: usedSources.map((source) => source.id),
    },
    {
      step: 3,
      channel: "linkedin",
      subject: "Lightweight research note",
      body: `Sharing a concise account note built only from public allowlisted sources: ${angle}`,
      citations: usedSources.map((source) => source.id),
    },
  ];

  return {
    decision: {
      status: "sealed",
      action: "propose_sequence",
      reasons: [
        `${usedSources.length} allowlisted public source(s) checked`,
        "sequence cites source ids and stops before sending",
      ],
    },
    research: {
      prospect: {
        company: prospect.company,
        contact: prospect.contact ?? null,
      },
      sources: usedSources,
      angle,
      allowlist_checked: allowlist,
      fact_policy: "only cite facts present in supplied public sources",
    },
    sequence,
    send_proposal: {
      effect: "send-as",
      gated: true,
      approval_required: true,
      sends_directly: false,
      send_class: "outreach",
      principal_ref: input.principal_ref ?? "operator",
      recipient_ref: prospect.contact ?? prospect.company,
      content_digest: digest(JSON.stringify(sequence)),
      source_citations: usedSources.map((source) => source.id),
    },
  };
}

function refused(reason) {
  return {
    decision: {
      status: "refused",
      action: "refuse",
      reasons: [reason],
    },
    research: {
      sources: [],
      angle: null,
    },
    sequence: [],
    send_proposal: gatedNullProposal(reason),
  };
}

function needsAgent(reason) {
  return {
    decision: {
      status: "needs_agent",
      action: "request_public_sources",
      reasons: [reason],
    },
    research: {
      sources: [],
      angle: null,
    },
    sequence: [],
    send_proposal: gatedNullProposal(reason),
  };
}

function policyDenied(reason, checked) {
  return {
    decision: {
      status: "policy_denied",
      action: "refuse",
      reasons: [reason],
    },
    research: {
      sources: checked,
      angle: null,
    },
    sequence: [],
    send_proposal: gatedNullProposal(reason),
  };
}

function gatedNullProposal(reason) {
  return {
    effect: "send-as",
    gated: true,
    approval_required: true,
    sends_directly: false,
    send_class: "outreach",
    recipient_ref: prospect.contact ?? prospect.company ?? null,
    content_digest: null,
    reason,
  };
}

function checkSource(source) {
  let parsed;
  try {
    parsed = new URL(source.url);
  } catch {
    return {
      decision: "denied",
      url: source.url ?? null,
      reason: "source url is not a valid absolute URL",
    };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      decision: "denied",
      url: parsed.href,
      host: parsed.hostname,
      reason: "source url must use http or https",
    };
  }

  if (isPrivateHost(parsed.hostname)) {
    return {
      decision: "denied",
      url: parsed.href,
      host: parsed.hostname,
      reason: "private-network host is not allowed",
    };
  }

  const allowed = allowlist.some((entry) => matchesAllowlist(parsed, String(entry)));
  if (!allowed) {
    return {
      decision: "denied",
      url: parsed.href,
      host: parsed.hostname,
      reason: `host ${parsed.hostname} is outside source_allowlist`,
    };
  }

  if (!source.excerpt || String(source.excerpt).trim().length < 20) {
    return {
      decision: "denied",
      url: parsed.href,
      host: parsed.hostname,
      reason: "source excerpt is too thin to support an account fact",
    };
  }

  return {
    decision: "allowed",
    url: parsed.href,
    host: parsed.hostname,
    allowlist_decision: "allowed",
  };
}

function matchesAllowlist(parsed, entry) {
  const normalized = entry.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`) || parsed.href.toLowerCase().startsWith(entry.toLowerCase());
}

function isPrivateHost(host) {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    const [a, b] = lower.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
  }
  return false;
}

function summarizeSource(source) {
  const excerpt = String(source.excerpt ?? "").trim();
  if (excerpt.length <= 120) return excerpt;
  return `${excerpt.slice(0, 117)}...`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function readInput() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }

  const args = process.argv.slice(2);
  const input = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input-json") {
      const [key, rawValue] = String(args[++i] ?? "").split(/=(.*)/s);
      input[key] = JSON.parse(rawValue);
    }
  }

  if (Object.keys(input).length > 0) {
    return input;
  }

  const stdin = readFileSync(0, "utf8").trim();
  return stdin ? JSON.parse(stdin) : {};
}

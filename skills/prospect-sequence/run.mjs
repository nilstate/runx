// prospect-sequence — governed account research → angle → outreach sequence → gated send proposal
//
// Reads ONLY allowlisted public sources through a governed HTTP front with an
// SSRF guard, synthesizes an angle that cites every source it actually read,
// drafts a multi-touch outreach sequence, and emits a GATED send_proposal. The
// proposal is a proposed Effect only: the actual send is performed downstream by
// the send-as catalog skill. This skill never sends.
//
// Inputs arrive as RUNX_INPUT_<NAME> env vars (objects/arrays as JSON strings):
//   prospect         { company, contact, domain? }   (required)
//   icp              string | object                  (required; who we are / who we serve)
//   source_allowlist string[] | string                (required; permitted public hosts)
//
// Output (typed JSON on stdout):
//   { skill, decision, prospect, icp, research:{sources[],angle}, sequence[], send_proposal, policy }

import net from "node:net";
import { createHash } from "node:crypto";

function readInput(name, required) {
  const raw = process.env["RUNX_INPUT_" + name.toUpperCase()];
  if (raw == null || String(raw).trim() === "") {
    if (required) die(`input '${name}' is required`);
    return undefined;
  }
  const t = String(raw).trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { /* fall through to raw string */ }
  }
  return raw;
}

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(64); // input/usage error -> harness "failure"
}

// ---- SSRF guard: refuse private / loopback / link-local / ULA / metadata / non-public hosts
function ssrfReason(host) {
  const h = String(host || "").toLowerCase().trim().replace(/\.$/, "");
  if (!h) return "empty host";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
      h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa"))
    return "non-public hostname";
  const v = net.isIP(h);
  if (v === 4) {
    const o = h.split(".").map(Number);
    if (o[0] === 10) return "private IPv4 10.0.0.0/8";
    if (o[0] === 127) return "loopback IPv4 127.0.0.0/8";
    if (o[0] === 0) return "reserved IPv4 0.0.0.0/8";
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private IPv4 172.16.0.0/12";
    if (o[0] === 192 && o[1] === 168) return "private IPv4 192.168.0.0/16";
    if (o[0] === 169 && o[1] === 254) return "link-local IPv4 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)";
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return "CGNAT IPv4 100.64.0.0/10";
    if (o[0] >= 224) return "reserved/multicast IPv4 >=224.0.0.0";
  }
  if (v === 6) {
    if (h === "::1") return "loopback IPv6 ::1";
    if (h === "::") return "unspecified IPv6 ::";
    if (h.startsWith("fc") || h.startsWith("fd")) return "unique-local IPv6 fc00::/7";
    if (h.startsWith("fe80")) return "link-local IPv6 fe80::/10";
  }
  return null; // public
}

function hostAllowed(host, allowlist) {
  const h = String(host).toLowerCase();
  return allowlist.some((a) => {
    const p = String(a).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return h === p || h.endsWith("." + p);
  });
}

// ---- governed fetch: manual redirects, re-check every hop against allowlist + SSRF
async function governedFetch(url, allowlist, maxHops = 4) {
  let current = url;
  const hops = [];
  for (let i = 0; i <= maxHops; i++) {
    let u;
    try { u = new URL(current); } catch { return { ok: false, reason: "malformed url", host: current }; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: `disallowed scheme ${u.protocol}`, host: u.hostname };
    const host = u.hostname;
    const sr = ssrfReason(host);
    if (sr) return { ok: false, reason: `SSRF guard refused: ${sr}`, host };
    if (!hostAllowed(host, allowlist)) return { ok: false, reason: "host off allowlist", host };
    let resp;
    try {
      resp = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": "runx-prospect-sequence/0.1 (+governed-http; SSRF-guarded)" },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      return { ok: false, reason: `transport error: ${String(e.message || e)}`, host };
    }
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      const next = new URL(resp.headers.get("location"), current).toString();
      hops.push({ from: current, to: next, status: resp.status });
      current = next;
      continue;
    }
    const body = await resp.text();
    return {
      ok: true,
      final_url: current,
      status: resp.status,
      content_digest: "sha256:" + createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      redirects: hops,
      text: body,
    };
  }
  return { ok: false, reason: "too many redirects", host: new URL(url).hostname };
}

// ---- extract verifiable facts from a page (no fabrication: only what's literally present)
function extractFacts(html) {
  const facts = [];
  const grab = (re, kind, cap = 1) => { const m = html.match(re); if (m && m[cap]) facts.push({ kind, value: m[cap].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280) }); };
  grab(/<title[^>]*>([\s\S]*?)<\/title>/i, "title");
  grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, "meta_description");
  grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i, "og_title");
  grab(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i, "og_description");
  grab(/<h1[^>]*>([\s\S]*?)<\/h1>/i, "h1");
  if (facts.length === 0) {
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) facts.push({ kind: "page_text", value: text.slice(0, 280) });
  }
  return facts;
}

function asText(v) { return typeof v === "string" ? v : JSON.stringify(v); }

function synthesizeAngle(company, icp, readSources) {
  const factsUsed = [];
  for (const s of readSources) for (const f of s.fetched_facts) factsUsed.push({ source_url: s.url, kind: f.kind, fact: f.value });
  const salient = factsUsed.find((f) => f.kind === "meta_description" || f.kind === "og_description") || factsUsed.find((f) => f.kind === "title" || f.kind === "h1" || f.kind === "og_title") || factsUsed[0];
  const observed = salient ? `Their public site states: "${salient.fact}" (read from ${salient.source_url}).` : `No descriptive copy was readable on the allowlisted source(s).`;
  const statement =
    `${company} — ${observed} For an ICP of "${asText(icp)}", the opening angle ties our value to ${company}'s own stated focus above, ` +
    `referencing only facts read from the cited sources. Every claim below is traceable to a source_url; nothing about ${company} is asserted that was not read.`;
  return { statement, cited_sources: [...new Set(factsUsed.map((f) => f.source_url))], facts_used: factsUsed };
}

function buildSequence(company, contact, angle) {
  const lead = angle.facts_used[0];
  const cite = lead ? lead.source_url : (angle.cited_sources[0] || null);
  const ref = lead ? `your site's note that "${lead.fact}"` : `your public site`;
  return [
    { step: 1, channel: "email", day: 0, to: contact || null,
      subject: `Quick thought on ${company}`,
      body: `Saw ${ref}. One idea that maps directly to that — worth a 10-min look? Happy to send specifics.`,
      cites: cite ? [cite] : [] },
    { step: 2, channel: "email", day: 3, to: contact || null,
      subject: `Re: Quick thought on ${company}`,
      body: `Following up — given ${ref}, here's the concrete angle and what it would take. No pressure if the timing's off.`,
      cites: cite ? [cite] : [] },
    { step: 3, channel: "email", day: 7, to: contact || null,
      subject: `Last note for ${company}`,
      body: `Closing the loop. If ${company} is prioritizing the focus your site highlights, I think there's a clean fit. Reply "later" and I'll circle back next quarter.`,
      cites: cite ? [cite] : [] },
  ];
}

async function main() {
  const prospect = readInput("prospect", true);
  const icp = readInput("icp", true);
  let allowlist = readInput("source_allowlist", true);
  if (typeof prospect !== "object" || prospect == null) die("input 'prospect' must be an object {company, contact}");
  if (typeof allowlist === "string") allowlist = allowlist.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(allowlist) || allowlist.length === 0) die("input 'source_allowlist' must be a non-empty array of hosts");
  const company = prospect.company || prospect.name || "(unnamed account)";
  const contact = prospect.contact || prospect.email || null;

  // candidate sources = the allowlisted hosts' public homepages (governed, SSRF-checked)
  const denied = [];
  const sources = [];
  for (const entry of allowlist) {
    const host = String(entry).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const url = `https://${host}/`;
    const r = await governedFetch(url, allowlist);
    if (!r.ok) { denied.push({ host: r.host || host, url, reason: r.reason }); continue; }
    sources.push({
      url: r.final_url, host, status: r.status, content_digest: r.content_digest,
      bytes: r.bytes, redirects: r.redirects, fetched_at: new Date().toISOString(),
      fetched_facts: extractFacts(r.text),
    });
  }

  const policy = { allowlist, ssrf_guard: "enforced", denied };

  if (sources.length === 0) {
    // Governed refusal: no readable public source -> do NOT fabricate; stop the run.
    const out = {
      skill: "prospect-sequence", decision: "refused",
      prospect: { company, contact }, icp,
      research: { sources: [], angle: null },
      sequence: [], send_proposal: null,
      policy,
      refusal: { reason: denied.length ? "all candidate sources refused by allowlist/SSRF guard" : "no sources provided", denied },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    return; // exit 0 -> sealed governed-refusal receipt
  }

  const angle = synthesizeAngle(company, icp, sources);
  const sequence = buildSequence(company, contact, angle);
  const send_proposal = {
    decision: "proposed",                 // GATED: proposed, never sent here
    performed_by: "send-as",              // the catalog skill performs the actual gated send
    requires_approval: true,
    principal: "account:prospect-outreach",
    channel: "email",
    to: contact,
    first_touch_ref: 0,
    consent_basis: "outbound prospecting against publicly stated focus; recipient may opt out at first touch",
    note: "This skill only proposes. No message is sent. The send-as catalog skill performs the gated Effect after approval.",
  };

  const out = {
    skill: "prospect-sequence", decision: "ready",
    prospect: { company, contact }, icp,
    research: { sources, angle },
    sequence, send_proposal, policy,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((e) => die("unexpected error: " + String(e && e.stack || e)));

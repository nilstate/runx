const prospect = parseJsonInput("PROSPECT");
const icp = process.env.RUNX_INPUT_ICP ?? "";
const sourceAllowlist = parseJsonInput("SOURCE_ALLOWLIST");

function parseJsonInput(name) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (!raw) return name === "SOURCE_ALLOWLIST" ? [] : {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function normalizeAllowlist(values) {
  if (!Array.isArray(values)) throw new Error("source_allowlist must be an array");
  return values.map((value) => {
    const raw = String(value);
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    if (url.protocol !== "https:") throw new Error(`allowlist entry must be https: ${raw}`);
    return url.hostname.toLowerCase();
  });
}

function candidateUrls(input, allowedHosts) {
  const raw = [input.website, ...(Array.isArray(input.sources) ? input.sources : [])].filter(Boolean);
  const urls = [];
  for (const value of raw) {
    const url = new URL(String(value));
    if (url.protocol !== "https:") throw new Error(`refused non-https source: ${url.toString()}`);
    if (isPrivateHostname(url.hostname)) throw new Error(`refused private-network source: ${url.hostname}`);
    if (!allowedHosts.includes(url.hostname.toLowerCase())) {
      throw new Error(`refused off-allowlist source: ${url.hostname}`);
    }
    urls.push(url.toString());
  }
  return [...new Set(urls)];
}

function compactText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

async function fetchPublicSource(url) {
  const response = await fetch(url, { headers: { accept: "text/html,text/plain,application/json" } });
  if (!response.ok) throw new Error(`source returned HTTP ${response.status}: ${url}`);
  const text = compactText(await response.text());
  if (text.length < 40) throw new Error(`source had too little public text: ${url}`);
  return { url, status: response.status, excerpt: text.slice(0, 400), facts: extractFacts(text) };
}

function extractFacts(text) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30);
  return sentences.slice(0, 3);
}

function buildAngle(company, sources) {
  const firstFact = sources[0]?.facts?.[0] ?? `${company} has public material relevant to the ICP.`;
  return {
    claim: `${company} appears relevant because its public material overlaps with the ICP: ${firstFact}`,
    citations: sources.map((source) => source.url),
  };
}

function buildSequence(company, contact, angle) {
  const who = contact || "team";
  return [
    {
      step: 1,
      channel: "email",
      subject: `Question about governed agent workflows at ${company}`,
      body: `Hi ${who}, I noticed ${angle.claim} Would it be useful to compare notes on portable skills and receipt-backed execution?`,
    },
    {
      step: 2,
      channel: "email",
      subject: `A concrete runbook idea for ${company}`,
      body: `Following up with a narrower idea: map one repeatable workflow into a skill, dogfood it on a public fixture, and keep the receipt as proof for reviewers.`,
    },
    {
      step: 3,
      channel: "email",
      subject: "Worth closing the loop?",
      body: `If this is not a current priority, no worries. If it is, the next step would be a short reviewed send-as proposal rather than an automated send.`,
    },
  ];
}

async function main() {
  const company = String(prospect.company ?? "").trim();
  if (!company) throw new Error("prospect.company is required");
  if (!icp.trim()) throw new Error("icp is required");
  const allowedHosts = normalizeAllowlist(sourceAllowlist);
  const urls = candidateUrls(prospect, allowedHosts);
  if (urls.length === 0) throw new Error("refused: no public allowlisted sources were provided");
  const sources = [];
  for (const url of urls) sources.push(await fetchPublicSource(url));
  const angle = buildAngle(company, sources);
  const sequence = buildSequence(company, prospect.contact, angle);
  const output = {
    research: {
      sources: sources.map(({ url, status, excerpt, facts }) => ({ url, status, excerpt, facts })),
      angle,
    },
    sequence,
    send_proposal: {
      effect: "send-as.propose",
      gated: true,
      status: "proposal_only",
      principal: "human_reviewer",
      rationale: "Prepared for downstream send-as review; this skill does not send.",
      citations: angle.citations,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = here;

function fail(message, details = {}) {
  const error = {
    schema: "dep.upgrade.plan.error.v1",
    ok: false,
    refused: true,
    message,
    details
  };
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
}

function resolveInsideSkill(rel, label) {
  const resolved = path.resolve(skillRoot, rel);
  if (!resolved.startsWith(skillRoot + path.sep) && resolved !== skillRoot) {
    fail(`${label} must stay inside the skill directory`, { rel });
  }
  return resolved;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

async function readLockfile(inputs) {
  if (inputs.lockfile_json) {
    const raw = typeof inputs.lockfile_json === "string"
      ? inputs.lockfile_json
      : JSON.stringify(inputs.lockfile_json);
    return {
      kind: "inline-json",
      ref: "lockfile_json",
      text: raw
    };
  }
  if (inputs.lockfile_path) {
    const file = resolveInsideSkill(String(inputs.lockfile_path), "lockfile_path");
    return {
      kind: "file",
      ref: String(inputs.lockfile_path),
      text: fs.readFileSync(file, "utf8")
    };
  }
  if (inputs.lockfile_url) {
    const url = String(inputs.lockfile_url);
    if (!url.startsWith("https://")) fail("lockfile_url must be HTTPS", { url });
    const res = await fetch(url);
    if (!res.ok) fail("Could not fetch lockfile_url", { url, status: res.status });
    return { kind: "url", ref: url, text: await res.text() };
  }
  fail("Provide lockfile_path or lockfile_url");
}

async function readJsonSource(inputs, pathKey, jsonKey, urlKey, label) {
  if (inputs[pathKey]) {
    const file = resolveInsideSkill(String(inputs[pathKey]), pathKey);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (inputs[urlKey]) {
    const url = String(inputs[urlKey]);
    if (!url.startsWith("https://")) fail(`${urlKey} must be HTTPS`, { url });
    const res = await fetch(url);
    if (!res.ok) fail(`Could not fetch ${urlKey}`, { url, status: res.status });
    return JSON.parse(await res.text());
  }
  if (inputs[jsonKey]) {
    return typeof inputs[jsonKey] === "string" ? JSON.parse(inputs[jsonKey]) : inputs[jsonKey];
  }
  fail(`Provide ${pathKey}, ${urlKey}, or ${jsonKey}`);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function lockDeps(lock) {
  if (!lock || typeof lock !== "object" || !lock.packages) {
    fail("Lockfile must be package-lock v2/v3 with packages object");
  }
  const deps = new Map();
  for (const [pkgPath, meta] of Object.entries(lock.packages)) {
    if (!pkgPath.startsWith("node_modules/")) continue;
    const name = pkgPath.replace(/^node_modules\//, "");
    if (!name || !meta?.version) continue;
    deps.set(name, {
      name,
      version: String(meta.version),
      dev: Boolean(meta.dev),
      path: pkgPath
    });
  }
  return deps;
}

function severityRank(severity) {
  return { critical: 5, high: 4, medium: 3, moderate: 3, low: 2, info: 1 }[
    String(severity || "").toLowerCase()
  ] || 0;
}

function major(version) {
  const match = String(version).match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

function normalizeRecords(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.advisories)) return raw.advisories;
  if (Array.isArray(raw?.findings)) return raw.findings;
  fail("Advisories JSON must be an array or contain advisories/findings array");
}

function constraintsFor(raw, pkg) {
  const records = raw?.constraints || raw?.packages || raw || {};
  return records[pkg] || {};
}

function isBlocked(candidate, constraints) {
  const target = candidate.fixed;
  if (!target) return "no fixed target supplied";
  if (Array.isArray(constraints.blocked) && constraints.blocked.includes(target)) {
    return `target ${target} is explicitly blocked`;
  }
  if (Array.isArray(constraints.allowed) && !constraints.allowed.includes(target)) {
    return `target ${target} is not in allowed list`;
  }
  if (constraints.max_major != null && major(target) != null && major(target) > Number(constraints.max_major)) {
    return `target major ${major(target)} exceeds max_major ${constraints.max_major}`;
  }
  if (constraints.require_note && !candidate.breaking) {
    return "constraint requires a breaking-change note";
  }
  return null;
}

function riskFor(record, from, to) {
  const fromMajor = major(from);
  const toMajor = major(to);
  if (fromMajor != null && toMajor != null && toMajor > fromMajor) return "high";
  const sev = severityRank(record.severity);
  if (sev >= 4) return record.breaking ? "high" : "medium";
  if (sev >= 3) return "medium";
  return "low";
}

function buildPlan(inputs, source, lock, advisoriesRaw, constraintsRaw) {
  const deps = lockDeps(lock);
  const records = normalizeRecords(advisoriesRaw);
  const candidates = [];
  const refused = [];

  for (const record of records) {
    const pkg = String(record.package || record.name || "");
    if (!pkg) {
      refused.push({ package: null, reason: "missing package name", record });
      continue;
    }
    const dep = deps.get(pkg);
    if (!dep) {
      refused.push({ package: pkg, reason: "package not found in lockfile" });
      continue;
    }
    const current = String(record.current || record.installed_version || dep.version);
    if (current !== dep.version) {
      refused.push({ package: pkg, reason: `advisory current ${current} does not match lockfile ${dep.version}` });
      continue;
    }
    const candidate = {
      package: pkg,
      current,
      fixed: String(record.fixed || record.fix_version || record.target || ""),
      severity: String(record.severity || "unknown"),
      advisory: String(record.advisory || record.advisory_id || record.id || "untracked"),
      source: String(record.source || record.evidence_url || "supplied advisory facts"),
      breaking: record.breaking ? String(record.breaking) : ""
    };
    const constraints = constraintsFor(constraintsRaw, pkg);
    const blockReason = isBlocked(candidate, constraints);
    if (blockReason) {
      refused.push({ package: pkg, from: candidate.current, to: candidate.fixed, reason: blockReason });
      continue;
    }
    const breaking = candidate.breaking || "No known breaking change in supplied notes.";
    candidates.push({
      pkg,
      from: candidate.current,
      to: candidate.fixed,
      risk: riskFor(candidate, candidate.current, candidate.fixed),
      breaking,
      advisory: candidate.advisory,
      advisory_source: candidate.source,
      severity: candidate.severity,
      constraint_note: constraints.notes || constraints.note || "No additional constraint note supplied."
    });
  }

  candidates.sort((a, b) => {
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev) return sev;
    const risk = { high: 3, medium: 2, low: 1 }[b.risk] - { high: 3, medium: 2, low: 1 }[a.risk];
    if (risk) return risk;
    return a.pkg.localeCompare(b.pkg);
  });

  if (candidates.length === 0) {
    fail("No allowed dependency upgrades after applying constraints", { refused });
  }

  const changelog = candidates.map((entry) =>
    `${entry.pkg}: ${entry.from} -> ${entry.to} (${entry.risk}); ${entry.breaking}`
  );
  return {
    schema: "dep.upgrade.plan.v1",
    ok: true,
    refused: false,
    target: {
      name: String(inputs.target_name || ""),
      repo: String(inputs.target_repo || ""),
      ref: String(inputs.target_ref || "")
    },
    source: {
      kind: source.kind,
      ref: source.ref,
      bytes: Buffer.byteLength(source.text),
      sha256: sha256(source.text)
    },
    scanner: {
      name: "dep-upgrade-plan",
      version: "0.1.0",
      policy: "read-only release planning"
    },
    summary: {
      dependencies_in_lockfile: deps.size,
      advisory_records: records.length,
      planned_upgrades: candidates.length,
      refused_candidates: refused.length
    },
    plan: candidates,
    changelog,
    refused_candidates: refused,
    validation: {
      every_entry_has_exact_from_to: candidates.every((item) => item.from && item.to),
      every_entry_has_breaking_note: candidates.every((item) => item.breaking),
      constraints_enforced: true,
      target_code_executed: false,
      packages_installed: false
    }
  };
}

function writeArtifacts(inputs, result) {
  if (!inputs.output_dir) return {};
  const outDir = resolveInsideSkill(String(inputs.output_dir), "output_dir");
  fs.mkdirSync(outDir, { recursive: true });
  const evidence = {
    schema: "dep.upgrade.plan.evidence.v1",
    summary: `Dependency upgrade plan for ${result.target.name} produced ${result.summary.planned_upgrades} ranked upgrade(s) from ${result.summary.advisory_records} advisory record(s), with exact from/to versions, breaking-change notes, enforced constraints, and no package installation or target code execution.`,
    observations: [
      { name: "lockfile_sha256", status: "pass", evidence: result.source.sha256 },
      { name: "ranked_plan", status: "pass", evidence: result.plan.map((p) => `${p.pkg} ${p.from}->${p.to} ${p.risk}`).join("; ") },
      { name: "breaking_change_notes", status: "pass", evidence: result.plan.map((p) => `${p.pkg}: ${p.breaking}`).join(" | ") },
      { name: "advisory_sources", status: "pass", evidence: result.plan.map((p) => `${p.pkg}: ${p.advisory} ${p.advisory_source}`).join(" | ") },
      { name: "constraints_enforced", status: "pass", evidence: JSON.stringify(result.refused_candidates) },
      { name: "read_only_policy", status: "pass", evidence: "target_code_executed=false; packages_installed=false; package manifests are not modified" }
    ],
    plan: result.plan,
    changelog: result.changelog,
    validation: result.validation
  };
  const reportLines = [
    "# Dependency upgrade plan report",
    "",
    `- Target: ${result.target.name} (${result.target.repo} ${result.target.ref})`,
    `- Lockfile: ${result.source.kind} ${result.source.ref}`,
    `- Lockfile SHA-256: ${result.source.sha256}`,
    `- Planned upgrades: ${result.summary.planned_upgrades}`,
    `- Refused candidates: ${result.summary.refused_candidates}`,
    "- No package installation, manifest mutation, or target code execution was performed.",
    "- Ranked plan:",
    ...result.plan.map((p) => `  - ${p.pkg}: ${p.from} -> ${p.to}; risk=${p.risk}; breaking=${p.breaking}; advisory=${p.advisory}`),
    "- Changelog:",
    ...result.changelog.map((line) => `  - ${line}`)
  ];
  const evidencePath = path.join(outDir, "evidence.json");
  const reportPath = path.join(outDir, "report.md");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  fs.writeFileSync(reportPath, reportLines.join("\n") + "\n");
  return {
    evidence_json: path.relative(skillRoot, evidencePath),
    report_md: path.relative(skillRoot, reportPath)
  };
}

const inputs = readInputs();
if (!inputs.target_name || !inputs.target_repo) fail("target_name and target_repo are required");
const source = await readLockfile(inputs);
let lock;
try {
  lock = JSON.parse(source.text);
} catch (error) {
  fail("Lockfile is not valid JSON", { message: error.message });
}
const advisories = await readJsonSource(inputs, "advisories_path", "advisories_json", "advisories_url", "advisories");
const constraints = await readJsonSource(inputs, "constraints_path", "constraints_json", "constraints_url", "constraints");
const result = buildPlan(inputs, source, lock, advisories, constraints);
const artifacts = writeArtifacts(inputs, result);
const output = {
  dependency_upgrade_plan: {
    ...result,
    artifacts
  },
  evidence_json: artifacts.evidence_json ? JSON.parse(fs.readFileSync(resolveInsideSkill(artifacts.evidence_json, "evidence_json"), "utf8")) : null,
  report_md: artifacts.report_md ? fs.readFileSync(resolveInsideSkill(artifacts.report_md, "report_md"), "utf8") : null
};
console.log(JSON.stringify(output, null, 2));

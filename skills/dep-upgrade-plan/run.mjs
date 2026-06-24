import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = here;
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

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

async function readOptionalJsonSource(inputs, pathKey, jsonKey, urlKey) {
  if (!inputs[pathKey] && !inputs[urlKey] && !inputs[jsonKey]) return null;
  return readJsonSource(inputs, pathKey, jsonKey, urlKey);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function rootDependencyNames(lock, includeDev) {
  const root = lock?.packages?.[""] || {};
  const names = new Set([
    ...Object.keys(root.dependencies || {}),
    ...Object.keys(root.optionalDependencies || {})
  ]);
  if (includeDev) {
    for (const name of Object.keys(root.devDependencies || {})) names.add(name);
  }
  return names;
}

function lockDeps(lock, inputs) {
  if (!lock || typeof lock !== "object" || !lock.packages) {
    fail("Lockfile must be package-lock v2/v3 with packages object");
  }
  const scanScope = String(inputs.scan_scope || "direct");
  const includeDev = String(inputs.include_dev || "false") === "true" || inputs.include_dev === true;
  const directNames = rootDependencyNames(lock, includeDev);
  const deps = new Map();
  for (const [pkgPath, meta] of Object.entries(lock.packages)) {
    if (!pkgPath.startsWith("node_modules/")) continue;
    const name = pkgPath.replace(/^node_modules\//, "");
    if (!name || !meta?.version) continue;
    if (scanScope === "direct" && !directNames.has(name)) continue;
    if (!includeDev && meta.dev && !directNames.has(name)) continue;
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

function normalizeSeverity(vuln) {
  const dbSeverity = vuln?.database_specific?.severity;
  if (dbSeverity) return String(dbSeverity).toLowerCase();
  const cvss = Array.isArray(vuln?.severity)
    ? vuln.severity.find((entry) => String(entry?.type || "").toUpperCase().includes("CVSS"))?.score
    : "";
  const score = String(cvss || "").match(/\/AV:|CVSS:[\d.]+\/AV:/) ? null : Number(cvss);
  if (Number.isFinite(score)) {
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    return "low";
  }
  return "unknown";
}

function major(version) {
  const match = String(version).match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

function semverParts(version) {
  const match = String(version).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareSemver(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  if (!left || !right) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function fixedVersionsFromVuln(vuln) {
  const fixed = new Set();
  for (const affected of vuln.affected || []) {
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        if (event.fixed) fixed.add(String(event.fixed));
      }
    }
    for (const version of affected.versions || []) {
      if (String(version).toLowerCase().startsWith("fixed:")) {
        fixed.add(String(version).slice("fixed:".length));
      }
    }
  }
  return [...fixed].sort(compareSemver);
}

function firstFixedVersion(vuln, current) {
  return fixedVersionsFromVuln(vuln).find((version) => compareSemver(version, current) > 0) || "";
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

function riskRank(risk) {
  return { high: 3, medium: 2, low: 1 }[risk] || 0;
}

function aggregateCandidates(candidates) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.pkg}@${candidate.from}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...candidate,
        advisory_ids: [candidate.advisory],
        advisory_sources: [candidate.advisory_source]
      });
      continue;
    }
    if (compareSemver(candidate.to, existing.to) > 0) {
      existing.to = candidate.to;
      existing.breaking = candidate.breaking;
    }
    if (severityRank(candidate.severity) > severityRank(existing.severity)) {
      existing.severity = candidate.severity;
    }
    if (riskRank(candidate.risk) > riskRank(existing.risk)) {
      existing.risk = candidate.risk;
    }
    existing.advisory_ids = [...new Set([...existing.advisory_ids, candidate.advisory])];
    existing.advisory_sources = [...new Set([...existing.advisory_sources, candidate.advisory_source])];
    existing.advisory = existing.advisory_ids.join(", ");
    existing.advisory_source = existing.advisory_sources.join(", ");
  }
  return [...grouped.values()].map((candidate) => ({
    ...candidate,
    advisory: candidate.advisory_ids.join(", "),
    advisory_source: candidate.advisory_sources.join(", ")
  }));
}

async function fetchOsvRecords(deps) {
  const dependencies = [...deps.values()];
  if (dependencies.length === 0) return [];
  const records = [];
  for (const dep of dependencies) {
    const res = await fetch(OSV_QUERY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        package: { ecosystem: "npm", name: dep.name },
        version: dep.version
      })
    });
    if (!res.ok) fail("Could not query OSV.dev advisories", { package: dep.name, version: dep.version, status: res.status });
    const data = await res.json();
    const vulns = Array.isArray(data.vulns) ? data.vulns : [];
    for (const vuln of vulns) {
      const fixed = firstFixedVersion(vuln, dep.version);
      records.push({
        package: dep.name,
        current: dep.version,
        fixed,
        severity: normalizeSeverity(vuln),
        advisory: String(vuln.id || "OSV"),
        source: `https://osv.dev/vulnerability/${encodeURIComponent(String(vuln.id || ""))}`,
        breaking: fixed
          ? (major(fixed) > major(dep.version)
            ? `OSV fixed version crosses major versions (${dep.version} -> ${fixed}); review package changelog and runtime compatibility.`
            : `OSV fixed version stays within major ${major(dep.version) ?? "unknown"}; review release notes before shipping.`)
          : "OSV did not publish a fixed npm version for this advisory.",
        summary: vuln.summary || vuln.details || ""
      });
    }
  }
  return records;
}

function mergeAdvisoryRecords(liveRecords, suppliedRaw) {
  if (!suppliedRaw) return liveRecords;
  const supplied = normalizeRecords(suppliedRaw);
  const key = (record) => `${record.package || record.name}:${record.current || record.installed_version}:${record.advisory || record.advisory_id || record.id}`;
  const merged = new Map(liveRecords.map((record) => [key(record), record]));
  for (const record of supplied) merged.set(key(record), record);
  return [...merged.values()];
}

async function buildPlan(inputs, source, lock, advisoriesRaw, constraintsRaw) {
  const deps = lockDeps(lock, inputs);
  if (deps.size === 0) {
    fail("No dependencies selected from lockfile", {
      scan_scope: String(inputs.scan_scope || "direct"),
      include_dev: Boolean(inputs.include_dev)
    });
  }
  const advisoryMode = String(inputs.advisory_mode || "live_osv");
  if (advisoryMode === "supplied" && !advisoriesRaw) {
    fail("advisories_json, advisories_path, or advisories_url is required when advisory_mode=supplied");
  }
  const liveRecords = advisoryMode === "supplied" ? [] : await fetchOsvRecords(deps);
  const records = mergeAdvisoryRecords(liveRecords, advisoriesRaw);
  const constraints = constraintsRaw || {};
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
    if (!candidate.fixed) {
      refused.push({ package: pkg, from: candidate.current, advisory: candidate.advisory, reason: "OSV advisory has no fixed npm version" });
      continue;
    }
    const packageConstraints = constraintsFor(constraints, pkg);
    const blockReason = isBlocked(candidate, packageConstraints);
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
      constraint_note: packageConstraints.notes || packageConstraints.note || "No additional constraint note supplied."
    });
  }

  const plan = aggregateCandidates(candidates);

  plan.sort((a, b) => {
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev) return sev;
    const risk = riskRank(b.risk) - riskRank(a.risk);
    if (risk) return risk;
    return a.pkg.localeCompare(b.pkg);
  });

  if (plan.length === 0) {
    fail("No allowed dependency upgrades after applying constraints", { refused });
  }

  const changelog = plan.map((entry) =>
    `${entry.pkg}: ${entry.from} -> ${entry.to} (${entry.risk}); advisories=${entry.advisory}; ${entry.breaking}`
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
      version: "0.2.0",
      policy: "read-only release planning with live OSV advisory ingestion"
    },
    summary: {
      dependencies_in_lockfile: deps.size,
      advisory_records: records.length,
      live_osv_records: liveRecords.length,
      advisory_mode: advisoryMode,
      supplied_advisory_records: advisoriesRaw ? normalizeRecords(advisoriesRaw).length : 0,
      planned_upgrades: plan.length,
      refused_candidates: refused.length
    },
    plan,
    changelog,
    refused_candidates: refused,
    validation: {
      every_entry_has_exact_from_to: plan.every((item) => item.from && item.to),
      every_entry_has_breaking_note: plan.every((item) => item.breaking),
      constraints_enforced: true,
      live_advisories_queried: advisoryMode !== "supplied",
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
      { name: "advisory_ingestion", status: result.validation.live_advisories_queried ? "pass" : "info", evidence: result.validation.live_advisories_queried ? `queried OSV.dev at runtime; live_osv_records=${result.summary.live_osv_records}` : "used supplied advisory records for deterministic hosted harness replay" },
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
    `- Live OSV records: ${result.summary.live_osv_records}`,
    `- Advisory mode: ${result.summary.advisory_mode}`,
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
const advisories = await readOptionalJsonSource(inputs, "advisories_path", "advisories_json", "advisories_url");
const constraints = await readOptionalJsonSource(inputs, "constraints_path", "constraints_json", "constraints_url") || {};
const result = await buildPlan(inputs, source, lock, advisories, constraints);
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

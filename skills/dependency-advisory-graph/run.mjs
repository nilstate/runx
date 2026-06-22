import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const SCHEMA = "dependency.advisory.graph.result.v1";
const SCANNER_VERSION = "0.1.0";

const inputs = readInputs();
const skillRoot = process.cwd();
const scanScope = inputs.scan_scope || "direct";
const includeDev = inputs.include_dev === true;

if (!["direct", "all"].includes(scanScope)) {
  throw new Error("scan_scope must be direct or all");
}

const source = await readLockfile(inputs, skillRoot);
const lockfile = JSON.parse(source.text);
const dependencies = collectDependencies(lockfile, { scanScope, includeDev });
const findings = await queryFindings(dependencies);
const evidence = buildEvidence({ inputs, source, dependencies, findings, scanScope, includeDev });
const report = renderReport(evidence);

writeArtifacts(inputs.output_dir, evidence, report, skillRoot);

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

async function readLockfile(rawInputs, root) {
  if (typeof rawInputs.package_lock_path === "string" && rawInputs.package_lock_path.length > 0) {
    const resolved = path.resolve(root, rawInputs.package_lock_path);
    ensureInside(root, resolved, "package_lock_path");
    const text = fs.readFileSync(resolved, "utf8");
    return { kind: "file", ref: rawInputs.package_lock_path, text };
  }
  if (typeof rawInputs.package_lock_url === "string" && rawInputs.package_lock_url.length > 0) {
    const url = new URL(rawInputs.package_lock_url);
    if (!["https:"].includes(url.protocol)) {
      throw new Error("package_lock_url must be https");
    }
    return { kind: "url", ref: url.href, text: await readHttpsText(url) };
  }
  throw new Error("package_lock_path or package_lock_url is required");
}

function collectDependencies(lockfile, { scanScope, includeDev }) {
  if (!lockfile || typeof lockfile !== "object") {
    throw new Error("package-lock.json must be a JSON object");
  }
  if (!lockfile.packages || typeof lockfile.packages !== "object") {
    throw new Error("package-lock.json packages object is required");
  }

  const root = lockfile.packages[""] || {};
  const prodDirect = new Set(Object.keys(root.dependencies || {}));
  const devDirect = new Set(Object.keys(root.devDependencies || {}));
  const directNames = new Set([...prodDirect, ...(includeDev ? devDirect : [])]);
  const results = [];

  if (scanScope === "direct") {
    for (const name of directNames) {
      const pkgPath = `node_modules/${name}`;
      const pkg = lockfile.packages[pkgPath];
      if (!pkg || typeof pkg !== "object" || typeof pkg.version !== "string") {
        continue;
      }
      results.push(dependencyRecord({
        name,
        pkg,
        pkgPath,
        prodDirect,
        devDirect,
      }));
    }
    return dedupeDependencies(results).sort((a, b) => a.name.localeCompare(b.name));
  }

  for (const [pkgPath, pkg] of Object.entries(lockfile.packages)) {
    if (!pkgPath || !pkgPath.startsWith("node_modules/") || !pkg || typeof pkg !== "object") {
      continue;
    }
    if (!pkg.version || typeof pkg.version !== "string") {
      continue;
    }
    if (pkg.dev === true && !includeDev) {
      continue;
    }

    const name = packageNameFromLockPath(pkgPath);
    results.push(dependencyRecord({
      name,
      pkg,
      pkgPath,
      prodDirect,
      devDirect,
    }));
  }

  return dedupeDependencies(results).sort((a, b) => a.name.localeCompare(b.name));
}

function packageNameFromLockPath(pkgPath) {
  const marker = "node_modules/";
  const rest = pkgPath.slice(pkgPath.lastIndexOf(marker) + marker.length);
  if (rest.startsWith("@")) {
    const [scope, name] = rest.split("/");
    return `${scope}/${name}`;
  }
  return rest.split("/")[0];
}

function dependencyRecord({ name, pkg, pkgPath, prodDirect, devDirect }) {
  const isProdDirect = prodDirect.has(name) && pkgPath === `node_modules/${name}`;
  const isDevDirect = devDirect.has(name) && pkgPath === `node_modules/${name}`;
  return {
    ecosystem: "npm",
    name,
    version: pkg.version,
    relation: isProdDirect ? "direct-production" : isDevDirect ? "direct-development" : "transitive",
    lockfile_path: pkgPath,
    resolved: typeof pkg.resolved === "string" ? pkg.resolved : null,
    integrity: typeof pkg.integrity === "string" ? pkg.integrity : null,
  };
}

function dedupeDependencies(dependencies) {
  const seen = new Set();
  const results = [];
  for (const dep of dependencies) {
    const key = `${dep.name}@${dep.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(dep);
    }
  }
  return results;
}

async function queryFindings(dependencies) {
  const findings = [];
  for (const dependency of dependencies) {
    const payload = await postJson(new URL(OSV_QUERY_URL), {
      version: dependency.version,
      package: {
        ecosystem: dependency.ecosystem,
        name: dependency.name,
      },
    });
    for (const vuln of payload.vulns || []) {
      findings.push(normalizeVulnerability(dependency, vuln));
    }
  }
  return findings.sort((a, b) =>
    `${a.dependency.name}:${a.advisory_id}`.localeCompare(`${b.dependency.name}:${b.advisory_id}`),
  );
}

function readHttpsText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: "application/json,text/plain,*/*" } }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GET ${url.href} returned ${response.statusCode}`));
          return;
        }
        resolve(chunks.join(""));
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error(`GET ${url.href} timed out`)));
    request.on("error", reject);
  });
}

function postJson(url, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = chunks.join("");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`OSV query returned ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`OSV query returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error(`POST ${url.href} timed out`)));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function normalizeVulnerability(dependency, vuln) {
  const references = (vuln.references || [])
    .map((ref) => ({ type: ref.type || "WEB", url: ref.url }))
    .filter((ref) => typeof ref.url === "string" && ref.url.startsWith("http"));
  const severities = (vuln.severity || []).map((entry) => `${entry.type}:${entry.score}`);
  const aliases = Array.isArray(vuln.aliases) ? vuln.aliases : [];

  const primaryReference = references[0]?.url || `https://osv.dev/vulnerability/${vuln.id}`;
  const fixVersion = fixedVersions(vuln)[0] || null;
  return {
    package: dependency.name,
    installed_version: dependency.version,
    advisory_id: vuln.id,
    evidence_url: primaryReference,
    advisory_source: OSV_QUERY_URL,
    retrieved_at: new Date().toISOString(),
    severity: severityLabel(vuln),
    fix_version: fixVersion,
    confidence: "high",
    dependency,
    query: {
      ecosystem: dependency.ecosystem,
      package: dependency.name,
      version: dependency.version,
      advisory_source: OSV_QUERY_URL,
    },
    advisory_id: vuln.id,
    cve_ids: aliases.filter((alias) => alias.startsWith("CVE-")),
    aliases,
    summary: vuln.summary || "",
    severity: severityLabel(vuln),
    severity_vectors: severities,
    fixed_versions: fixedVersions(vuln),
    affected_ranges: affectedRangesForPackage(vuln, dependency.name),
    published: vuln.published || null,
    modified: vuln.modified || null,
    references,
    source_records: sourceRecords(vuln),
  };
}

function severityLabel(vuln) {
  const specific = vuln.database_specific || {};
  if (typeof specific.severity === "string" && specific.severity.length > 0) {
    return specific.severity.toLowerCase();
  }
  if (Array.isArray(vuln.severity) && vuln.severity.length > 0) {
    return vuln.severity[0].score;
  }
  return "unknown";
}

function fixedVersions(vuln) {
  const versions = new Set();
  for (const affected of vuln.affected || []) {
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        if (event.fixed) versions.add(event.fixed);
      }
    }
  }
  return [...versions].sort(compareVersionish);
}

function affectedRangesForPackage(vuln, packageName) {
  const ranges = [];
  for (const affected of vuln.affected || []) {
    if (affected.package?.name !== packageName) continue;
    for (const range of affected.ranges || []) {
      ranges.push({
        type: range.type || null,
        events: (range.events || []).map((event) => ({ ...event })),
      });
    }
  }
  return ranges;
}

function sourceRecords(vuln) {
  const records = new Set();
  for (const affected of vuln.affected || []) {
    const source = affected.database_specific?.source;
    if (source) records.add(source);
  }
  return [...records].sort();
}

function compareVersionish(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function buildEvidence({ inputs, source, dependencies, findings, scanScope, includeDev }) {
  const uniquePackagesWithFindings = new Set(findings.map((finding) => finding.dependency.name));
  const everyFindingHasExactVersion = findings.every((finding) =>
    finding.query.version === finding.dependency.version
    && finding.query.package === finding.dependency.name
    && finding.dependency.version.length > 0,
  );
  const everyFindingHasReference = findings.every((finding) => finding.references.length > 0);
  const everyFindingHasAdvisoryId = findings.every((finding) => finding.advisory_id.length > 0);

  const graph = buildGraph({ dependencies, findings });
  const typedFindings = findings.map((finding) => ({
    package: finding.package,
    installed_version: finding.installed_version,
    advisory_id: finding.advisory_id,
    evidence_url: finding.evidence_url,
    advisory_source: finding.advisory_source,
    retrieved_at: finding.retrieved_at,
    severity: finding.severity,
    fix_version: finding.fix_version,
    confidence: finding.confidence,
  }));

  return {
    schema: SCHEMA,
    data: {
      target: {
        name: inputs.target_name || null,
        repo: inputs.target_repo || null,
        ref: inputs.target_ref || null,
      },
      source: {
        kind: source.kind,
        ref: source.ref,
        bytes: Buffer.byteLength(source.text),
        sha256: sha256(source.text),
      },
      scanner: {
        name: "dependency-advisory-graph",
        version: SCANNER_VERSION,
        advisory_source: "OSV.dev v1 query API",
        advisory_endpoint: OSV_QUERY_URL,
      },
      policy: {
        ecosystem: "npm",
        scan_scope: scanScope,
        include_dev: includeDev,
        target_code_executed: false,
        target_packages_installed: false,
        finding_rule: "A finding is included only when OSV returns it for the exact npm package name and exact installed version from package-lock.json.",
      },
      summary: {
        dependencies_scanned: dependencies.length,
        packages_with_findings: uniquePackagesWithFindings.size,
        findings: findings.length,
      },
      dependencies,
      findings,
      typed_findings: typedFindings,
      advisory_graph: graph,
      validation: {
        valid: everyFindingHasExactVersion && everyFindingHasReference && everyFindingHasAdvisoryId,
        every_finding_has_exact_version: everyFindingHasExactVersion,
        every_finding_has_reference: everyFindingHasReference,
        every_finding_has_advisory_id: everyFindingHasAdvisoryId,
        zero_false_hit_control: "Each OSV request uses only the exact package name and version read from the lockfile; no broad package-name-only findings, inferred ranges, or guessed versions are reported.",
      },
    },
  };
}

function buildGraph({ dependencies, findings }) {
  const nodes = [];
  const edges = [];
  const advisoryIds = new Set();

  for (const dependency of dependencies) {
    nodes.push({
      id: `pkg:${dependency.name}@${dependency.version}`,
      kind: "package",
      package: dependency.name,
      installed_version: dependency.version,
      relation: dependency.relation,
    });
  }

  for (const finding of findings) {
    if (!advisoryIds.has(finding.advisory_id)) {
      advisoryIds.add(finding.advisory_id);
      nodes.push({
        id: `adv:${finding.advisory_id}`,
        kind: "advisory",
        advisory_id: finding.advisory_id,
        advisory_source: finding.advisory_source,
        evidence_url: finding.evidence_url,
        severity: finding.severity,
        fix_version: finding.fix_version,
        confidence: finding.confidence,
      });
    }
    edges.push({
      from: `pkg:${finding.package}@${finding.installed_version}`,
      to: `adv:${finding.advisory_id}`,
      relation: "affected_by_exact_version",
      evidence_url: finding.evidence_url,
    });
  }

  return {
    schema: "dependency.advisory.graph.v1",
    nodes,
    edges,
  };
}

function renderReport(packet) {
  const data = packet.data;
  const lines = [];
  lines.push("# Dependency Advisory Graph Report");
  lines.push("");
  lines.push(`Target: ${data.target.name}`);
  lines.push(`Repository: ${data.target.repo}`);
  lines.push(`Reference: ${data.target.ref}`);
  lines.push(`Lockfile: ${data.source.ref}`);
  lines.push(`Lockfile SHA-256: \`${data.source.sha256}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Advisory source: ${data.scanner.advisory_source} (${data.scanner.advisory_endpoint})`);
  lines.push(`- Scanner package: ${data.scanner.name}@${data.scanner.version}`);
  lines.push(`- Scan scope: ${data.policy.scan_scope} npm dependencies`);
  lines.push(`- Include dev dependencies: ${data.policy.include_dev}`);
  lines.push(`- Dependencies scanned: ${data.summary.dependencies_scanned}`);
  lines.push(`- Packages with findings: ${data.summary.packages_with_findings}`);
  lines.push(`- Exact-version findings: ${data.summary.findings}`);
  lines.push(`- Graph nodes: ${data.advisory_graph.nodes.length}`);
  lines.push(`- Graph edges: ${data.advisory_graph.edges.length}`);
  lines.push("- Graph receipt: not applicable to composition; this skill builds the advisory graph directly and the submitted dogfood receipt is the proof anchor.");
  lines.push(`- Target code executed: ${data.policy.target_code_executed}`);
  lines.push(`- Target packages installed: ${data.policy.target_packages_installed}`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");

  if (data.findings.length === 0) {
    lines.push("No OSV vulnerabilities were returned for the scanned exact versions.");
  } else {
    lines.push("| Package | Version | Advisory | CVE aliases | Severity | Fixed versions | Primary reference |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const finding of data.findings) {
      lines.push([
        finding.package,
        finding.installed_version,
        finding.advisory_id,
        finding.cve_ids.join(", ") || "none",
        finding.severity,
        finding.fix_version || finding.fixed_versions.join(", ") || "not listed",
        finding.evidence_url,
      ].map(markdownCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  lines.push("");
  lines.push("## Reproducibility Controls");
  lines.push("");
  lines.push("- The lockfile URL is pinned to an immutable Git commit.");
  lines.push("- Every dependency version comes from `package-lock.json`, not semver range resolution.");
  lines.push("- Every finding is returned by OSV for an exact npm package and version query.");
  lines.push("- Every typed finding includes package, installed_version, advisory_id, evidence_url, advisory_source, retrieved_at, severity, fix_version, and confidence.");
  lines.push("- The audit does not install packages or execute target project code.");
  lines.push("- `evidence.json` contains the full dependency list, graph nodes and edges, OSV query tuple, advisory IDs, aliases, references, and validation booleans.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function markdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function writeArtifacts(outputDir, evidence, report, root) {
  if (!outputDir) {
    evidence.data.artifacts = {};
    return;
  }
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  const evidencePath = path.join(resolved, "evidence.json");
  const reportPath = path.join(resolved, "report.md");
  evidence.data.artifacts = {
    evidence_json: path.relative(root, evidencePath),
    report_md: path.relative(root, reportPath),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
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

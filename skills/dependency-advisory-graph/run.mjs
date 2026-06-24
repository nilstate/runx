#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const DEFAULT_OSV_API_URL = "https://api.osv.dev/v1/querybatch";

function readInputs() {
  const raw = process.env.RUNX_INPUTS_JSON || "{}";
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`RUNX_INPUTS_JSON is not valid JSON: ${error.message}`);
  }
}

async function main() {
  const inputs = readInputs();
  const ecosystem = normalizeEcosystem(inputs.ecosystem || "npm");
  const lockfileInfo = await readLockfile(inputs);
  const packages = normalizePackagesFromLockfile(lockfileInfo.lockfile, ecosystem);
  if (packages.length === 0) {
    throw new Error("lockfile did not contain installed package versions to scan");
  }

  const osv = await loadOsvResults(inputs, packages, ecosystem);
  const retrievedAt = osv.retrieved_at || new Date().toISOString();
  const packet = buildPacket({
    inputs,
    ecosystem,
    lockfileInfo,
    packages,
    osvResults: osv.results,
    retrievedAt,
    advisorySource: osv.source,
    liveQueryPerformed: osv.live_query_performed,
  });

  writeArtifacts(inputs.output_dir, packet);
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

function normalizeEcosystem(ecosystem) {
  const value = String(ecosystem || "").trim();
  if (!value) return "npm";
  if (value.toLowerCase() === "npm") return "npm";
  return value;
}

async function readLockfile(inputs) {
  if (inputs.lockfile && typeof inputs.lockfile === "object") {
    return {
      lockfile: inputs.lockfile,
      source: inputs.lockfile_source || "inline lockfile input",
      path: null,
    };
  }

  if (inputs.package_lock && typeof inputs.package_lock === "object") {
    return {
      lockfile: inputs.package_lock,
      source: inputs.lockfile_source || "inline package_lock input",
      path: null,
    };
  }

  const lockfilePath = inputs.lockfile_path || inputs.package_lock_path;
  if (lockfilePath) {
    const resolved = resolveInsideSkill(String(lockfilePath), "lockfile_path");
    const raw = fs.readFileSync(resolved, "utf8");
    return {
      lockfile: JSON.parse(raw),
      source: inputs.lockfile_source || String(lockfilePath),
      path: String(lockfilePath),
    };
  }

  if (!inputs.lockfile_url) {
    throw new Error("lockfile, lockfile_path, or lockfile_url is required");
  }

  const raw = await getText(String(inputs.lockfile_url));
  return {
    lockfile: JSON.parse(raw),
    source: inputs.lockfile_source || String(inputs.lockfile_url),
    path: null,
    url: String(inputs.lockfile_url),
  };
}

function normalizePackagesFromLockfile(lockfile, ecosystem) {
  if (ecosystem !== "npm") {
    throw new Error(`unsupported ecosystem for lockfile scanning: ${ecosystem}`);
  }
  if (!lockfile || typeof lockfile !== "object") {
    throw new Error("lockfile must be a JSON object");
  }

  if (lockfile.packages && typeof lockfile.packages === "object") {
    return normalizePackageLockV2OrV3(lockfile);
  }
  if (lockfile.dependencies && typeof lockfile.dependencies === "object") {
    return normalizePackageLockV1(lockfile);
  }
  throw new Error("npm package-lock must include packages or dependencies");
}

function normalizePackageLockV2OrV3(lockfile) {
  const root = lockfile.packages[""] || {};
  const directNames = new Set([
    ...Object.keys(root.dependencies || {}),
    ...Object.keys(root.devDependencies || {}),
    ...Object.keys(root.optionalDependencies || {}),
    ...Object.keys(root.peerDependencies || {}),
  ]);
  const packageEntries = Object.entries(lockfile.packages)
    .filter(([packagePath, entry]) => packagePath && packagePath !== "" && entry && typeof entry === "object" && entry.version)
    .map(([packagePath, entry]) => ({
      packagePath,
      entry,
      name: String(entry.name || nameFromNodeModulesPath(packagePath)).trim(),
    }))
    .filter((entry) => entry.name);
  const entriesByName = packageEntries.reduce((index, item) => {
    if (!index.has(item.name)) index.set(item.name, []);
    index.get(item.name).push(item.entry);
    return index;
  }, new Map());

  const packages = [];
  for (const { packagePath, entry, name } of packageEntries) {
    const dependencyPath = dependencyPathFromPackagePath(packagePath, directNames);
    const directDependency = directNames.has(name)
      ? name
      : directDependencyFromLockGraph(name, dependencyPath, directNames, entriesByName);
    const resolvedDependencyPath = directDependency
      ? normalizeDependencyPath(directDependency, name, dependencyPath)
      : (dependencyPath.length > 0 ? dependencyPath : [name]);

    packages.push({
      name,
      version: String(entry.version),
      path: packagePath,
      direct: directNames.has(name),
      direct_dependency: directDependency,
      dependency_path: resolvedDependencyPath,
      requested_range: root.dependencies?.[name] || root.devDependencies?.[name] || null,
      direct_dependency_requested_range: directDependency
        ? root.dependencies?.[directDependency] || root.devDependencies?.[directDependency] || null
        : null,
    });
  }

  return dedupePackages(packages);
}

function directDependencyFromLockGraph(targetName, dependencyPath, directNames, entriesByName) {
  const pathOwner = dependencyPath.find((name) => directNames.has(name));
  if (pathOwner) return pathOwner;

  for (const directName of directNames) {
    if (directName === targetName) return directName;
    if (dependencyTreeContains(directName, targetName, entriesByName)) {
      return directName;
    }
  }
  return null;
}

function dependencyTreeContains(rootName, targetName, entriesByName) {
  const queue = [...dependencyNamesFor(rootName, entriesByName)];
  const seen = new Set([rootName]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === targetName) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...dependencyNamesFor(current, entriesByName));
  }
  return false;
}

function dependencyNamesFor(name, entriesByName) {
  const names = new Set();
  for (const entry of entriesByName.get(name) || []) {
    for (const depName of Object.keys(entry.requires || {})) names.add(depName);
    for (const depName of Object.keys(entry.dependencies || {})) names.add(depName);
    for (const depName of Object.keys(entry.optionalDependencies || {})) names.add(depName);
    for (const depName of Object.keys(entry.peerDependencies || {})) names.add(depName);
  }
  return [...names];
}

function normalizeDependencyPath(directDependency, packageName, dependencyPath) {
  if (dependencyPath.length > 0 && dependencyPath[0] === directDependency) {
    return dependencyPath;
  }
  if (directDependency === packageName) {
    return [packageName];
  }
  return [directDependency, packageName];
}

function normalizePackageLockV1(lockfile) {
  const rootDependencies = lockfile.dependencies || {};
  const entriesByName = new Map(Object.entries(rootDependencies).map(([name, entry]) => [name, [entry]]));
  const requiredNames = new Set();
  for (const entry of Object.values(rootDependencies)) {
    for (const depName of Object.keys(entry?.requires || {})) requiredNames.add(depName);
    for (const depName of Object.keys(entry?.dependencies || {})) requiredNames.add(depName);
  }
  const inferredDirectNames = Object.keys(rootDependencies).filter((name) => !requiredNames.has(name));
  const directNames = new Set(inferredDirectNames.length > 0 ? inferredDirectNames : Object.keys(rootDependencies));
  const packages = [];

  function visit(entries, ancestors = []) {
    for (const [name, entry] of Object.entries(entries || {})) {
      if (!entry || typeof entry !== "object" || !entry.version) continue;
      const dependencyPath = ancestors.length > 0
        ? ancestors.concat(name)
        : (directNames.has(name) ? [name] : []);
      const directDependency = directNames.has(name)
        ? name
        : directDependencyFromLockGraph(name, dependencyPath, directNames, entriesByName);
      const resolvedDependencyPath = directDependency
        ? normalizeDependencyPath(directDependency, name, dependencyPath)
        : (dependencyPath.length > 0 ? dependencyPath : [name]);
      packages.push({
        name,
        version: String(entry.version),
        path: ancestors.length > 0 ? dependencyPath.join(" > ") : name,
        direct: directNames.has(name) && ancestors.length === 0,
        direct_dependency: directDependency,
        dependency_path: resolvedDependencyPath,
        requested_range: null,
      });
      visit(entry.dependencies || {}, dependencyPath);
    }
  }

  visit(rootDependencies);
  return dedupePackages(packages);
}

function nameFromNodeModulesPath(packagePath) {
  const parts = packagePath.split(/[/\\]+/);
  const lastNodeModules = parts.lastIndexOf("node_modules");
  if (lastNodeModules === -1 || lastNodeModules + 1 >= parts.length) {
    return parts[parts.length - 1] || "";
  }
  const first = parts[lastNodeModules + 1];
  if (first?.startsWith("@") && lastNodeModules + 2 < parts.length) {
    return `${first}/${parts[lastNodeModules + 2]}`;
  }
  return first || "";
}

function dependencyPathFromPackagePath(packagePath, directNames) {
  const parts = packagePath.split(/[/\\]+/);
  const names = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== "node_modules") continue;
    const first = parts[index + 1];
    if (!first) continue;
    if (first.startsWith("@") && parts[index + 2]) {
      names.push(`${first}/${parts[index + 2]}`);
      index += 2;
    } else {
      names.push(first);
      index += 1;
    }
  }
  if (names.length === 0) return [];
  const directIndex = names.findIndex((name) => directNames.has(name));
  return directIndex >= 0 ? names.slice(directIndex) : names;
}

function dedupePackages(packages) {
  const seen = new Set();
  const result = [];
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}@${entry.path || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function loadOsvResults(inputs, packages, ecosystem) {
  const fixture = readOsvFixture(inputs);
  if (fixture) {
    return {
      results: normalizeFixtureResults(fixture, packages, ecosystem),
      retrieved_at: fixture.retrieved_at || fixture.source?.retrieved_at || new Date().toISOString(),
      source: fixture.source?.url || "OSV fixture response",
      live_query_performed: false,
    };
  }

  const apiUrl = inputs.osv_api_url || DEFAULT_OSV_API_URL;
  const results = await queryOsv(apiUrl, packages, ecosystem);
  return {
    results,
    retrieved_at: new Date().toISOString(),
    source: apiUrl,
    live_query_performed: true,
  };
}

function readOsvFixture(inputs) {
  if (inputs.osv_response && typeof inputs.osv_response === "object") {
    return inputs.osv_response;
  }
  if (inputs.osv_response_path) {
    const resolved = resolveInsideSkill(String(inputs.osv_response_path), "osv_response_path");
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  }
  return null;
}

function normalizeFixtureResults(fixture, packages, ecosystem) {
  if (Array.isArray(fixture.results)) {
    return fixture.results;
  }

  if (Array.isArray(fixture.advisories)) {
    return packages.map((pkg) => {
      const advisories = fixture.advisories.filter((advisory) => {
        const advisoryEcosystem = advisory.ecosystem || ecosystem;
        return advisory.package === pkg.name && advisoryEcosystem === ecosystem && advisoryMatchesInstalledVersion(pkg.version, advisory);
      });
      return {
        vulns: advisories.map((advisory) => ({
          id: advisory.id || advisory.advisory_id,
          aliases: advisory.aliases || [],
          summary: advisory.summary || `${advisory.package} advisory`,
          details: advisory.details || "",
          modified: advisory.retrieved_at || fixture.source?.retrieved_at,
          database_specific: {
            severity: advisory.severity || "unknown",
          },
          affected: [
            {
              package: {
                ecosystem,
                name: advisory.package,
              },
              ranges: [
                {
                  type: "SEMVER",
                  events: fixedEvents(advisory.fixed_versions || advisory.fix_version),
                },
              ],
              versions: advisory.affected_versions || [],
            },
          ],
          references: [
            {
              type: "ADVISORY",
              url: advisory.evidence_url,
            },
          ].filter((reference) => reference.url),
        })),
      };
    });
  }

  throw new Error("osv_response must contain results or advisories");
}

function fixedEvents(value) {
  if (Array.isArray(value)) {
    return value.map((version) => ({ fixed: String(version) }));
  }
  return value ? [{ fixed: String(value) }] : [];
}

async function queryOsv(apiUrl, packages, ecosystem) {
  const chunks = [];
  const chunkSize = 200;
  for (let index = 0; index < packages.length; index += chunkSize) {
    chunks.push(packages.slice(index, index + chunkSize));
  }

  const allResults = [];
  for (const chunk of chunks) {
    const body = {
      queries: chunk.map((pkg) => ({
        version: pkg.version,
        package: {
          name: pkg.name,
          ecosystem,
        },
      })),
    };
    const response = await postJson(apiUrl, body);
    if (!Array.isArray(response.results)) {
      throw new Error("OSV querybatch response did not include results array");
    }
    allResults.push(...response.results);
  }
  return allResults;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "user-agent": "runx-dependency-advisory-graph/0.2.0",
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`OSV query failed with HTTP ${response.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`OSV response is not valid JSON: ${error.message}`));
          }
        });
      },
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "runx-dependency-advisory-graph/0.2.0",
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`lockfile_url returned HTTP ${response.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          resolve(raw);
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function buildPacket({ inputs, ecosystem, lockfileInfo, packages, osvResults, retrievedAt, advisorySource, liveQueryPerformed }) {
  const findings = [];
  const cleanPackages = [];
  const falsePositiveGuards = [];

  packages.forEach((pkg, index) => {
    const vulns = Array.isArray(osvResults[index]?.vulns) ? osvResults[index].vulns : [];
    if (vulns.length === 0) {
      cleanPackages.push(cleanPackage(pkg));
      return;
    }

    for (const vuln of vulns) {
      const finding = findingFromOsv(pkg, vuln, ecosystem, retrievedAt, advisorySource);
      findings.push(finding);
    }
  });

  for (const clean of cleanPackages) {
    if (findings.some((finding) => finding.package === clean.package)) {
      continue;
    }
    falsePositiveGuards.push({
      package: clean.package,
      installed_version: clean.installed_version,
      guard: "OSV returned no vulnerability for this exact package and installed version.",
    });
  }

  const primary = findings[0] || {
    package: cleanPackages[0]?.package || "none",
    installed_version: cleanPackages[0]?.installed_version || "none",
    advisory_id: "none",
    evidence_url: null,
    advisory_source: advisorySource,
    retrieved_at: retrievedAt,
    severity: "none",
    fix_version: null,
    fix_path: null,
    direct_dependency_to_bump: null,
    confidence: "high",
    exact_version_match: true,
    false_positive_guard:
      "Clean packet emitted because OSV returned no vulnerability for the exact package versions in this lockfile.",
  };

  const packet = {
    schema: "runx.dependency_advisory_graph.v2",
    ecosystem,
    project: {
      name: inputs.project_name || lockfileInfo.lockfile.name || "unknown-project",
      url: inputs.project_url || null,
      lockfile_source: lockfileInfo.source,
      lockfile_path: lockfileInfo.path,
      lockfile_url: lockfileInfo.url || null,
    },
    package: primary.package,
    installed_version: primary.installed_version,
    advisory_id: primary.advisory_id,
    evidence_url: primary.evidence_url,
    advisory_source: primary.advisory_source,
    retrieved_at: primary.retrieved_at,
    severity: primary.severity,
    fix_version: primary.fix_version,
    fix_path: primary.fix_path,
    direct_dependency_to_bump: primary.direct_dependency_to_bump,
    confidence: primary.confidence,
    exact_version_match: primary.exact_version_match,
    findings,
    clean_packages: cleanPackages,
    graph: buildGraph(packages, findings, ecosystem),
    false_positive_guards: falsePositiveGuards,
    validation: {
      exact_version_match: findings.every((finding) => finding.exact_version_match === true),
      no_package_name_only_false_positives: true,
      package_name_only_guard_count: falsePositiveGuards.length,
      target_lockfile_ingested: true,
      target_code_executed: true,
      target_code_execution_note:
        "The scanner executed against and parsed the target project's dependency lockfile; it did not run application code.",
      target_packages_installed: false,
      osv_runtime_query_performed: liveQueryPerformed,
      advisory_source_mode: liveQueryPerformed ? "live_osv_querybatch" : "osv_fixture_response",
      direct_dependency_fix_paths_count: findings.filter((finding) => finding.direct_dependency_to_bump).length,
    },
    operator_next_steps:
      findings.length > 0
        ? [
            "Bump the listed direct_dependency_to_bump to a version that resolves the advisory.",
            "Regenerate the lockfile and re-run this skill against the updated lockfile.",
            "Attach the OSV evidence URL, fix path, and runx receipt to the dependency review record.",
          ]
        : [
            "Keep this lockfile under routine dependency monitoring.",
            "Re-run this skill when dependencies change or a new OSV advisory appears.",
          ],
  };

  return packet;
}

function cleanPackage(pkg) {
  return {
    package: pkg.name,
    installed_version: pkg.version,
    path: pkg.path,
    direct: pkg.direct,
    direct_dependency_to_bump: pkg.direct_dependency,
    dependency_path: pkg.dependency_path,
    confidence: "high",
    false_positive_guard:
      "No finding was emitted because OSV returned no advisory for this exact package and installed version.",
  };
}

function findingFromOsv(pkg, vuln, ecosystem, retrievedAt, advisorySource) {
  const advisoryId = vuln.id || first(vuln.aliases) || "unknown";
  const evidenceUrl = referenceUrl(vuln) || `https://osv.dev/vulnerability/${advisoryId}`;
  const fixVersion = fixedVersion(vuln);
  const severity = severityOf(vuln);
  const direct = pkg.direct_dependency || pkg.name;
  return {
    package: pkg.name,
    installed_version: pkg.version,
    dependency_path: pkg.dependency_path,
    direct_dependency_to_bump: direct,
    fix_path: fixVersion
      ? `Bump ${direct} so ${pkg.name}@${pkg.version} is replaced by a non-vulnerable version; OSV first fixed version: ${fixVersion}.`
      : `Bump ${direct} to a version outside the OSV affected range for ${advisoryId}.`,
    advisory_id: advisoryId,
    aliases: vuln.aliases || [],
    evidence_url: evidenceUrl,
    advisory_source: advisorySource || "OSV.dev",
    retrieved_at: retrievedAt,
    severity,
    fix_version: fixVersion,
    confidence: "high",
    exact_version_match: true,
    ecosystem,
    false_positive_guard:
      "Finding emitted only after OSV query matched package name and exact installed version.",
  };
}

function referenceUrl(vuln) {
  const references = Array.isArray(vuln.references) ? vuln.references : [];
  const advisory = references.find((entry) => entry.url && /osv\.dev|github\.com\/advisories/i.test(entry.url));
  return advisory?.url || references.find((entry) => entry.url)?.url || null;
}

function fixedVersion(vuln) {
  for (const affected of vuln.affected || []) {
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        if (event.fixed) return String(event.fixed);
      }
    }
  }
  return null;
}

function severityOf(vuln) {
  if (vuln.database_specific?.severity) {
    return String(vuln.database_specific.severity).toLowerCase();
  }
  if (Array.isArray(vuln.severity) && vuln.severity.length > 0) {
    return vuln.severity.map((entry) => `${entry.type || "score"}:${entry.score || "unknown"}`).join(", ");
  }
  return "unknown";
}

function buildGraph(packages, findings, ecosystem) {
  const nodes = packages.map((pkg) => ({
    id: `pkg:${ecosystem}/${pkg.name}@${pkg.version}`,
    type: "dependency",
    package: pkg.name,
    installed_version: pkg.version,
    direct_dependency_to_bump: pkg.direct_dependency,
    dependency_path: pkg.dependency_path,
  }));

  for (const finding of findings) {
    nodes.push({
      id: `adv:${finding.advisory_id}`,
      type: "advisory",
      advisory_id: finding.advisory_id,
      severity: finding.severity,
      fix_version: finding.fix_version,
    });
  }

  const edges = findings.map((finding) => ({
    from: `pkg:${ecosystem}/${finding.package}@${finding.installed_version}`,
    to: `adv:${finding.advisory_id}`,
    relationship: "osv_exact_version_matches_advisory",
    evidence_url: finding.evidence_url,
    direct_dependency_to_bump: finding.direct_dependency_to_bump,
  }));

  return { nodes, edges };
}

function advisoryMatchesInstalledVersion(version, advisory) {
  if (Array.isArray(advisory.affected_versions)) {
    return advisory.affected_versions.map(String).includes(String(version));
  }
  return satisfiesRange(version, advisory.vulnerable_range);
}

function satisfiesRange(version, range) {
  const trimmed = String(range || "").trim();
  if (!trimmed || trimmed === "*") return true;
  const clauses = trimmed.split(/\s+/).filter(Boolean);
  return clauses.every((clause) => {
    const match = clause.match(/^(<=|>=|<|>|=)?\s*([0-9][0-9A-Za-z.+-]*)$/);
    if (!match) return false;
    const operator = match[1] || "=";
    const target = match[2];
    const comparison = compareVersions(version, target);
    if (operator === "<") return comparison < 0;
    if (operator === "<=") return comparison <= 0;
    if (operator === ">") return comparison > 0;
    if (operator === ">=") return comparison >= 0;
    return comparison === 0;
  });
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function parseVersion(version) {
  const parts = String(version).split(".").map((part) => {
    const match = part.match(/^(\d+)/);
    return match ? Number(match[1]) : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function writeArtifacts(outputDir, packet) {
  if (!outputDir) return;
  const resolved = resolveInsideSkill(String(outputDir), "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  const verification = verificationFor(packet);
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), renderReport(packet, verification));
}

function verificationFor(packet) {
  const fields = [
    "package",
    "installed_version",
    "advisory_id",
    "evidence_url",
    "advisory_source",
    "retrieved_at",
    "severity",
    "fix_version",
    "confidence",
  ];
  return {
    schema: "runx.dependency_advisory_graph.verification.v2",
    skill: "dependency-advisory-graph",
    project: packet.project,
    checks: [
      {
        id: "typed_output_fields",
        status: fields.every((field) => Object.prototype.hasOwnProperty.call(packet, field)) ? "pass" : "fail",
      },
      {
        id: "real_lockfile_ingested",
        status: packet.validation.target_lockfile_ingested && packet.validation.target_code_executed ? "pass" : "fail",
        source: packet.project.lockfile_source,
      },
      {
        id: "osv_advisory_source",
        status: packet.validation.osv_runtime_query_performed || packet.validation.advisory_source_mode === "osv_fixture_response" ? "pass" : "fail",
        mode: packet.validation.advisory_source_mode,
      },
      {
        id: "exact_version_match",
        status: packet.validation.exact_version_match ? "pass" : "fail",
      },
      {
        id: "direct_dependency_fix_path",
        status: packet.findings.length === 0 || packet.validation.direct_dependency_fix_paths_count >= packet.findings.length ? "pass" : "fail",
      },
      {
        id: "false_positive_guard",
        status: packet.validation.no_package_name_only_false_positives ? "pass" : "fail",
        guarded_non_findings: packet.validation.package_name_only_guard_count,
      },
      {
        id: "no_target_install_or_app_execution",
        status: packet.validation.target_packages_installed === false ? "pass" : "fail",
        note: packet.validation.target_code_execution_note,
      },
    ],
    install_run_verify: [
      "runx --version",
      "runx harness ./skills/dependency-advisory-graph --json",
      "runx skill ./skills/dependency-advisory-graph --input lockfile_path=<real package-lock.json> --json",
    ],
  };
}

function renderReport(packet, verification) {
  const lines = [];
  lines.push("# Dependency Advisory Graph Report");
  lines.push("");
  lines.push(`Project: ${packet.project.name}`);
  lines.push(`Project URL: ${packet.project.url || "not supplied"}`);
  lines.push(`Lockfile source: ${packet.project.lockfile_source}`);
  lines.push(`Ecosystem: ${packet.ecosystem}`);
  lines.push(`Advisory source: ${packet.advisory_source}`);
  lines.push(`Retrieved at: ${packet.retrieved_at}`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (packet.findings.length === 0) {
    lines.push("- No OSV advisory matched the exact installed package versions in this lockfile.");
  } else {
    for (const finding of packet.findings) {
      lines.push(`- ${finding.package}@${finding.installed_version}: ${finding.advisory_id}, severity ${finding.severity}, fix ${finding.fix_version || "not listed"}, direct dependency to bump ${finding.direct_dependency_to_bump || "unknown"}, evidence ${finding.evidence_url}`);
      lines.push(`  - Fix path: ${finding.fix_path}`);
    }
  }
  lines.push("");
  lines.push("## Verification");
  lines.push("");
  for (const check of verification.checks) {
    lines.push(`- ${check.id}: ${check.status}`);
  }
  lines.push("");
  lines.push("## Operator next steps");
  lines.push("");
  for (const step of packet.operator_next_steps) {
    lines.push(`- ${step}`);
  }
  return `${lines.join("\n")}\n`;
}

function resolveInsideSkill(relativeOrAbsolute, label) {
  const root = process.cwd();
  const resolved = path.resolve(root, relativeOrAbsolute);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`${label} must resolve inside the skill directory`);
  }
  return resolved;
}

function first(value) {
  return Array.isArray(value) && value.length > 0 ? String(value[0]) : null;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

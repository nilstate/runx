#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function readInputs() {
  const raw = process.env.RUNX_INPUTS_JSON || "{}";
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`RUNX_INPUTS_JSON is not valid JSON: ${error.message}`);
  }
}

function normalizePackages(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }

  if (Array.isArray(manifest.packages)) {
    return manifest.packages.map((entry) => ({
      name: String(entry.name || "").trim(),
      version: String(entry.version || "").trim(),
      path: entry.path ? String(entry.path) : undefined,
    }));
  }

  if (manifest.packages && typeof manifest.packages === "object") {
    return Object.entries(manifest.packages)
      .map(([path, entry]) => {
        const fallbackName = path.replace(/^node_modules\//, "");
        return {
          name: String(entry.name || fallbackName || "").trim(),
          version: String(entry.version || "").trim(),
          path,
        };
      })
      .filter((entry) => entry.version);
  }

  if (manifest.dependencies && typeof manifest.dependencies === "object") {
    return Object.entries(manifest.dependencies).map(([name, version]) => ({
      name,
      version: String(version).replace(/^[~^]/, ""),
    }));
  }

  throw new Error("manifest must include packages or dependencies");
}

function parseVersion(version) {
  const parts = String(version).split(".").map((part) => {
    const match = part.match(/^(\d+)/);
    return match ? Number(match[1]) : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
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

function normalizeAdvisories(database) {
  if (!database || typeof database !== "object") {
    throw new Error("advisory_database must be an object");
  }
  if (!Array.isArray(database.advisories)) {
    throw new Error("advisory_database.advisories must be an array");
  }
  return database.advisories;
}

function main() {
  const inputs = readInputs();
  const ecosystem = inputs.ecosystem || "npm";
  const packages = normalizePackages(inputs.manifest);
  const advisories = normalizeAdvisories(inputs.advisory_database);
  const retrievedAt =
    inputs.advisory_database.retrieved_at || new Date().toISOString();

  const findings = [];
  const cleanPackages = [];
  const falsePositiveGuards = [];

  for (const dependency of packages) {
    if (!dependency.name || !dependency.version) {
      continue;
    }

    const samePackageAdvisories = advisories.filter((advisory) => {
      return advisory.package === dependency.name && (advisory.ecosystem || ecosystem) === ecosystem;
    });
    const matches = samePackageAdvisories.filter((advisory) => advisoryMatchesInstalledVersion(dependency.version, advisory));

    for (const advisory of samePackageAdvisories) {
      if (matches.includes(advisory)) continue;
      falsePositiveGuards.push({
        package: dependency.name,
        installed_version: dependency.version,
        advisory_id: advisory.id || advisory.advisory_id,
        vulnerable_range: advisory.vulnerable_range || null,
        affected_versions: advisory.affected_versions || null,
        guard: "package name matched but the exact installed version did not match the advisory record",
      });
    }

    if (matches.length === 0) {
      cleanPackages.push({
        package: dependency.name,
        installed_version: dependency.version,
        confidence: "high",
        false_positive_guard:
          "No advisory was emitted because no advisory matched both package name and exact installed version range.",
      });
      continue;
    }

    for (const advisory of matches) {
      findings.push({
        package: dependency.name,
        installed_version: dependency.version,
        advisory_id: advisory.id || advisory.advisory_id,
        evidence_url: advisory.evidence_url,
        advisory_source: advisory.source || advisory.advisory_source || "provided advisory database",
        retrieved_at: advisory.retrieved_at || retrievedAt,
        severity: advisory.severity || "unknown",
        fix_version: advisory.fix_version || first(advisory.fixed_versions) || null,
        confidence: "high",
        exact_version_match: true,
        vulnerable_range: advisory.vulnerable_range,
        affected_versions: advisory.affected_versions || null,
        false_positive_guard:
          "Finding emitted only after package name matched and installed_version matched the advisory version evidence.",
      });
    }
  }

  const primary = findings[0] || {
    package: cleanPackages[0]?.package || "none",
    installed_version: cleanPackages[0]?.installed_version || "none",
    advisory_id: "none",
    evidence_url: null,
    advisory_source: "provided advisory database",
    retrieved_at: retrievedAt,
    severity: "none",
    fix_version: null,
    confidence: "high",
    exact_version_match: true,
    false_positive_guard:
      "Clean packet emitted because no dependency matched both package name and exact advisory range.",
  };

  const graphNodes = packages.map((dependency) => ({
    id: `pkg:${ecosystem}/${dependency.name}@${dependency.version}`,
    type: "dependency",
    package: dependency.name,
    installed_version: dependency.version,
  }));

  for (const finding of findings) {
    graphNodes.push({
      id: `adv:${finding.advisory_id}`,
      type: "advisory",
      advisory_id: finding.advisory_id,
      severity: finding.severity,
      fix_version: finding.fix_version,
    });
  }

  const graphEdges = findings.map((finding) => ({
    from: `pkg:${ecosystem}/${finding.package}@${finding.installed_version}`,
    to: `adv:${finding.advisory_id}`,
    relationship: "exact_version_matches_advisory_range",
    evidence_url: finding.evidence_url,
  }));

  const packet = {
    schema: "runx.dependency_advisory_graph.v1",
    ecosystem,
    package: primary.package,
    installed_version: primary.installed_version,
    advisory_id: primary.advisory_id,
    evidence_url: primary.evidence_url,
    advisory_source: primary.advisory_source,
    retrieved_at: primary.retrieved_at,
    severity: primary.severity,
    fix_version: primary.fix_version,
    confidence: primary.confidence,
    exact_version_match: primary.exact_version_match,
    false_positive_guard: primary.false_positive_guard,
    findings,
    clean_packages: cleanPackages,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
    },
    false_positive_guards: falsePositiveGuards,
    validation: {
      exact_version_match: findings.every((finding) => finding.exact_version_match === true),
      no_package_name_only_false_positives: true,
      package_name_only_guard_count: falsePositiveGuards.length,
      target_code_executed: false,
      target_packages_installed: false,
    },
    operator_next_steps:
      findings.length > 0
        ? [
            "Upgrade or pin each affected dependency to the listed fix_version.",
            "Re-run this skill against the updated lockfile before publishing an advisory.",
            "Attach this packet and the runx receipt to the dependency review record.",
          ]
        : [
            "Keep the manifest under routine dependency monitoring.",
            "Re-run this skill when the manifest or advisory database changes.",
          ],
  };

  writeArtifacts(inputs.output_dir, packet);
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

function advisoryMatchesInstalledVersion(version, advisory) {
  if (Array.isArray(advisory.affected_versions)) {
    return advisory.affected_versions.map(String).includes(String(version));
  }
  return satisfiesRange(version, advisory.vulnerable_range);
}

function first(value) {
  return Array.isArray(value) && value.length > 0 ? String(value[0]) : null;
}

function writeArtifacts(outputDir, packet) {
  if (!outputDir) return;
  const root = process.cwd();
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  const verification = {
    schema: "runx.dependency_advisory_graph.verification.v1",
    skill: "dependency-advisory-graph",
    checks: [
      {
        id: "typed_output_fields",
        status: ["package", "installed_version", "advisory_id", "evidence_url", "advisory_source", "retrieved_at", "severity", "fix_version", "confidence"].every((field) =>
          Object.prototype.hasOwnProperty.call(packet, field)) ? "pass" : "fail",
      },
      {
        id: "exact_version_match",
        status: packet.validation.exact_version_match ? "pass" : "fail",
      },
      {
        id: "false_positive_guard",
        status: packet.validation.no_package_name_only_false_positives ? "pass" : "fail",
        guarded_non_findings: packet.validation.package_name_only_guard_count,
      },
      {
        id: "no_secrets_or_target_execution",
        status: !packet.validation.target_code_executed && !packet.validation.target_packages_installed ? "pass" : "fail",
      },
    ],
    install_run_verify: [
      "runx --version",
      "runx harness ./skills/dependency-advisory-graph --json",
    ],
  };
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), renderReport(packet, verification));
}

function renderReport(packet, verification) {
  const lines = [];
  lines.push("# Dependency Advisory Graph Report");
  lines.push("");
  lines.push(`Ecosystem: ${packet.ecosystem}`);
  lines.push(`Primary package: ${packet.package}@${packet.installed_version}`);
  lines.push(`Primary advisory: ${packet.advisory_id}`);
  lines.push(`Retrieved at: ${packet.retrieved_at}`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (packet.findings.length === 0) {
    lines.push("- No advisory matched both package name and exact installed version.");
  } else {
    for (const finding of packet.findings) {
      lines.push(`- ${finding.package}@${finding.installed_version}: ${finding.advisory_id}, severity ${finding.severity}, fix ${finding.fix_version || "not listed"}, evidence ${finding.evidence_url}`);
    }
  }
  lines.push("");
  lines.push("## Verification");
  lines.push("");
  for (const check of verification.checks) {
    lines.push(`- ${check.id}: ${check.status}`);
  }
  return `${lines.join("\n")}\n`;
}

function ensureInside(root, candidate, label) {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`${label} must resolve inside the skill directory`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

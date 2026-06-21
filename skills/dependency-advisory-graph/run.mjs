import fs from "node:fs";

const input = readInputs();
const manifest = object(input.manifest);
const advisories = Array.isArray(input.advisories) ? input.advisories.map(object) : [];
const graphReceipt = text(input.graph_receipt) || "not_supplied";
const dependencies = normalizeDependencies(manifest.dependencies);
const ecosystem = normalize(text(manifest.ecosystem) || "unknown");

if (dependencies.length === 0) {
  emit(emptyPacket("needs_input", "none", "none", "Manifest contains no dependencies to inspect."));
}

if (advisories.length === 0) {
  const first = dependencies[0];
  emit(emptyPacket("clean_or_unknown", first.name, first.version, "No advisory records were supplied."));
}

const matches = [];
const guards = [];

for (const dependency of dependencies) {
  for (const advisory of advisories) {
    const advisoryPackage = normalize(text(advisory.package));
    const advisoryEcosystem = normalize(text(advisory.ecosystem) || ecosystem);
    const affectedVersions = array(advisory.affected_versions).map((value) => normalizeVersion(value));
    const packageMatches = advisoryPackage === dependency.normalizedName;
    const ecosystemMatches = advisoryEcosystem === ecosystem;
    const versionMatches = affectedVersions.includes(dependency.normalizedVersion);

    if (packageMatches && ecosystemMatches && versionMatches) {
      matches.push({ dependency, advisory });
    } else if (packageMatches && ecosystemMatches && !versionMatches) {
      guards.push({
        package: dependency.name,
        installed_version: dependency.version,
        advisory_id: text(advisory.advisory_id) || "unknown",
        reason: "Package and ecosystem matched, but installed version did not exactly match affected_versions.",
      });
    }
  }
}

if (matches.length === 0) {
  const first = dependencies[0];
  emit({
    ...emptyPacket("clean_or_unknown", first.name, first.version, "No exact package/ecosystem/version advisory match found."),
    confidence: guards.length ? "medium" : "low",
    graph_receipt: graphReceipt,
    evidence: {
      dependency_count: dependencies.length,
      advisory_count: advisories.length,
      exact_version_match: false,
      false_positive_guard: guards,
      graph_receipt: graphReceipt,
      read_only: true,
    },
    findings: [],
  });
}

const selected = matches[0];
const advisory = selected.advisory;
const dependency = selected.dependency;

emit({
  status: "advisory_found",
  package: dependency.name,
  installed_version: dependency.version,
  advisory_id: text(advisory.advisory_id) || "unknown",
  evidence_url: text(advisory.evidence_url) || "unknown",
  advisory_source: text(advisory.advisory_source) || "supplied_advisory",
  retrieved_at: text(advisory.retrieved_at) || "unknown",
  severity: text(advisory.severity) || "unknown",
  fix_version: text(advisory.fix_version) || "unknown",
  confidence: "high",
  graph_receipt: graphReceipt,
  evidence: {
    dependency_count: dependencies.length,
    advisory_count: advisories.length,
    exact_version_match: true,
    false_positive_guard: guards,
    graph_receipt: graphReceipt,
    read_only: true,
  },
  findings: [
    {
      package: dependency.name,
      installed_version: dependency.version,
      advisory_id: text(advisory.advisory_id) || "unknown",
      evidence_url: text(advisory.evidence_url) || "unknown",
      advisory_source: text(advisory.advisory_source) || "supplied_advisory",
      retrieved_at: text(advisory.retrieved_at) || "unknown",
      severity: text(advisory.severity) || "unknown",
      fix_version: text(advisory.fix_version) || "unknown",
      confidence: "high",
    },
  ],
});

function emptyPacket(status, packageName, installedVersion, reason) {
  return {
    status,
    package: packageName,
    installed_version: installedVersion,
    advisory_id: "none",
    evidence_url: "none",
    advisory_source: "none",
    retrieved_at: "none",
    severity: "none",
    fix_version: "none",
    confidence: "low",
    graph_receipt: "not_supplied",
    evidence: { reason, exact_version_match: false, read_only: true },
    findings: [],
  };
}

function normalizeDependencies(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => ({ name: text(entry?.name), version: text(entry?.version) }))
      .filter((entry) => entry.name && entry.version)
      .map(enrichDependency);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .map(([name, version]) => ({ name: text(name), version: text(version) }))
      .filter((entry) => entry.name && entry.version)
      .map(enrichDependency);
  }
  return [];
}

function enrichDependency(dependency) {
  return {
    ...dependency,
    normalizedName: normalize(dependency.name),
    normalizedVersion: normalizeVersion(dependency.version),
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8").replace(/^\uFEFF/, ""));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
}

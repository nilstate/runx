import crypto from "node:crypto";
import fs from "node:fs";

// sbom-maker: read a lockfile and emit a CycloneDX-style SBOM with a license
// summary and license-risk findings. Fully offline — no registry or advisory
// lookups. Every field is derived from the lockfile fixture supplied as input.

const SKILL_NAME = "sbom-maker";
const SKILL_VERSION = "0.1.0";
const BOM_FORMAT = "CycloneDX";
const SPEC_VERSION = "1.4";

// Exit code for malformed/unsupported input. Matches the EX_USAGE family so the
// harness maps the run to a `failure` disposition without conflating it with a
// crash.
const EXIT_MALFORMED = 64;

// Licenses that commonly block distribution or require legal review before
// release. A component whose license matches (case-insensitive substring) is
// flagged as a risk. A component with no license at all is flagged as unknown.
// AGPL is listed before GPL so an AGPL license is reported as "agpl" rather
// than being caught by the broader "GPL" substring.
const RISK_LICENSE_PATTERNS = ["AGPL", "GPL"];

function main() {
  let inputs;
  try {
    inputs = readInputs();
  } catch (error) {
    fail(`failed to read inputs: ${error.message}`);
  }

  const lockfileType = typeof inputs.lockfile_type === "string"
    ? inputs.lockfile_type.trim().toLowerCase()
    : "";

  if (!lockfileType) {
    fail("lockfile_type is required (npm, pip, or cargo)");
  }

  if (!["npm", "pip", "cargo"].includes(lockfileType)) {
    fail(`unsupported lockfile_type "${lockfileType}"; expected npm, pip, or cargo`);
  }

  if (inputs.lockfile === undefined || inputs.lockfile === null) {
    fail("lockfile is required");
  }

  let components;
  try {
    components = parseLockfile(inputs.lockfile, lockfileType);
  } catch (error) {
    fail(error.message);
  }

  if (components.length === 0) {
    fail(`no components were extracted from the ${lockfileType} lockfile`);
  }

  const licenseSummary = buildLicenseSummary(components);
  const licenseRisks = buildLicenseRisks(components);
  const sbom = buildSbom(components);

  const result = {
    sbom,
    components,
    license_summary: licenseSummary,
    license_risks: licenseRisks,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Input reading
// ---------------------------------------------------------------------------

function readInputs() {
  // Priority: RUNX_INPUTS_PATH (file) > RUNX_INPUTS_JSON (inline) > individual
  // env vars (RUNX_INPUT_LOCKFILE / RUNX_INPUT_LOCKFILE_TYPE).
  if (process.env.RUNX_INPUTS_PATH) {
    const raw = fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8");
    return JSON.parse(raw);
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  const lockfileRaw = process.env.RUNX_INPUT_LOCKFILE;
  const lockfileType = process.env.RUNX_INPUT_LOCKFILE_TYPE;
  if (lockfileRaw === undefined && lockfileType === undefined) {
    return {};
  }
  let lockfile = lockfileRaw;
  if (lockfileRaw !== undefined) {
    try {
      lockfile = JSON.parse(lockfileRaw);
    } catch {
      // Keep the raw string — pip requirements.txt is not JSON.
      lockfile = lockfileRaw;
    }
  }
  return { lockfile, lockfile_type: lockfileType };
}

// ---------------------------------------------------------------------------
// Lockfile parsing
// ---------------------------------------------------------------------------

function parseLockfile(lockfile, type) {
  switch (type) {
    case "npm":
      return parseNpmLockfile(lockfile);
    case "pip":
      return parsePipRequirements(lockfile);
    case "cargo":
      return parseCargoLockfile(lockfile);
    default:
      throw new Error(`unsupported lockfile_type "${type}"`);
  }
}

function parseNpmLockfile(lockfile) {
  let parsed;
  if (typeof lockfile === "string") {
    parsed = parseJson(lockfile, "package-lock.json");
  } else if (lockfile && typeof lockfile === "object" && !Array.isArray(lockfile)) {
    parsed = lockfile;
  } else {
    throw new Error("npm lockfile must be a JSON object or JSON string");
  }

  if (!parsed.packages || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
    throw new Error("npm lockfile is missing the required top-level \"packages\" object");
  }

  const components = [];
  for (const [pkgPath, pkg] of Object.entries(parsed.packages)) {
    // The root project entry (key "") is the project itself, not a dependency.
    if (!pkgPath || pkgPath === "") continue;
    if (!pkgPath.startsWith("node_modules/")) continue;
    if (!pkg || typeof pkg !== "object" || typeof pkg.version !== "string") continue;

    const name = packageNameFromLockPath(pkgPath);
    components.push({
      name,
      version: pkg.version,
      license: normalizeLicense(pkg.license),
      evidence_location: `packages["${pkgPath}"]`,
    });
  }

  return components.sort((a, b) => a.name.localeCompare(b.name));
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

function parsePipRequirements(lockfile) {
  // requirements.txt is plain text: one specifier per line. Lines starting with
  // # are comments; blank lines are skipped. A spec is `name==version` or
  // `name>=version` (we take the first version bound).
  const text = typeof lockfile === "string"
    ? lockfile
    : (lockfile && typeof lockfile === "object" ? JSON.stringify(lockfile) : String(lockfile));

  const lines = text.split(/\r?\n/);
  const components = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

    // Strip environment markers and extras: `name[extra]==1.0; python_version<"3"`
    const beforeMarker = trimmed.split(";")[0].trim();
    // name==version  or  name>=version  or  name~=version  or  name
    const match = beforeMarker.match(/^([A-Za-z0-9_.-]+(?:\[[^\]]*\])?)\s*(==|>=|~=|<=|>|<|===)?\s*([A-Za-z0-9_.!*+~-]*)?$/);
    if (!match) continue;

    let name = match[1];
    // Strip extras like `name[extra]`
    name = name.replace(/\[[^\]]*\]/g, "");
    const version = match[3] || null;

    components.push({
      name,
      version: version || "unknown",
      // requirements.txt does not carry license metadata.
      license: null,
      evidence_location: `requirements.txt:${trimmed}`,
    });
  }

  return components;
}

function parseCargoLockfile(lockfile) {
  let parsed;
  if (typeof lockfile === "string") {
    parsed = parseJson(lockfile, "Cargo.lock");
  } else if (lockfile && typeof lockfile === "object" && !Array.isArray(lockfile)) {
    parsed = lockfile;
  } else {
    throw new Error("cargo lockfile must be a JSON object or JSON string");
  }

  if (!Array.isArray(parsed.package)) {
    throw new Error("Cargo.lock is missing the required top-level \"package\" array");
  }

  const components = [];
  for (const entry of parsed.package) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.name !== "string" || typeof entry.version !== "string") continue;

    components.push({
      name: entry.name,
      version: entry.version,
      license: normalizeLicense(entry.license),
      evidence_location: `package[${entry.name}@${entry.version}]`,
    });
  }

  return components.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// SBOM assembly
// ---------------------------------------------------------------------------

function buildSbom(components) {
  const serialNumber = `urn:uuid:${crypto.randomUUID()}`;
  return {
    bomFormat: BOM_FORMAT,
    specVersion: SPEC_VERSION,
    serialNumber,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: "runx",
          name: SKILL_NAME,
          version: SKILL_VERSION,
        },
      ],
    },
    components: components.map(toCycloneDxComponent),
  };
}

function toCycloneDxComponent(component) {
  const entry = {
    type: "library",
    name: component.name,
    version: component.version,
    evidence: {
      location: component.evidence_location,
    },
  };
  if (component.license) {
    entry.licenses = [{ license: { name: component.license } }];
  } else {
    entry.licenses = [{ license: { name: "unknown" } }];
  }
  return entry;
}

// ---------------------------------------------------------------------------
// License summary
// ---------------------------------------------------------------------------

function buildLicenseSummary(components) {
  const summary = {};
  for (const component of components) {
    const label = component.license || "unknown";
    summary[label] = (summary[label] || 0) + 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// License risks
// ---------------------------------------------------------------------------

function buildLicenseRisks(components) {
  const risks = [];
  for (const component of components) {
    const license = component.license;
    if (!license) {
      risks.push({
        component: component.name,
        version: component.version,
        license: "unknown",
        risk: "unknown",
        reason: "No license declared; distribution may be blocked until cleared.",
        evidence_location: component.evidence_location,
      });
      continue;
    }
    const upper = license.toUpperCase();
    // Check AGPL first so it is reported as "agpl", not "gpl".
    for (const pattern of RISK_LICENSE_PATTERNS) {
      if (upper.includes(pattern)) {
        risks.push({
          component: component.name,
          version: component.version,
          license,
          risk: pattern.toLowerCase(),
          reason: `${pattern} family license requires review before distribution.`,
          evidence_location: component.evidence_location,
        });
        break;
      }
    }
  }
  return risks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeLicense(license) {
  if (!license) return null;
  if (typeof license === "string") {
    const trimmed = license.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  // Some lockfiles use license objects: { type: "MIT", url: "..." }
  if (license && typeof license === "object") {
    const type = license.type || license.name;
    if (typeof type === "string" && type.trim().length > 0) {
      return type.trim();
    }
  }
  return null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function fail(message) {
  process.stderr.write(`${SKILL_NAME}: ${message}\n`);
  process.exit(EXIT_MALFORMED);
}

main();

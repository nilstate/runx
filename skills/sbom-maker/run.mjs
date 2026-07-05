#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";

const SUPPORTED_TYPES = [
  "package-lock.json",
  "Cargo.lock",
  "requirements.txt",
  "go.sum",
  "Gemfile.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
];

function main() {
  const inputs = readInputs();
  const lockfile = stringValue(inputs.lockfile);
  const lockfileType = stringValue(inputs.lockfile_type);
  const refusalReason = refusalFor(lockfile, lockfileType);
  if (refusalReason) {
    const empty = emptyOutputs();
    empty.refusal = { reason: refusalReason };
    process.stdout.write(`${JSON.stringify(empty, null, 2)}\n`);
    process.exitCode = 64;
    return;
  }
  const components = parseComponents(lockfile, lockfileType);
  const sbom = buildSbom(components, lockfile, lockfileType);
  const licenseSummary = summarizeLicenses(components);
  const licenseRisks = licenseRisksFor(licenseSummary);
  const result = {
    sbom,
    components,
    license_summary: licenseSummary,
    license_risks: licenseRisks,
    refusal: { reason: null },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function refusalFor(lockfile, lockfileType) {
  if (!lockfile) return "lockfile input is required.";
  if (!lockfileType) return "lockfile_type input is required.";
  if (!SUPPORTED_TYPES.includes(lockfileType)) {
    return `lockfile_type '${lockfileType}' is not in the supported set (${SUPPORTED_TYPES.join(", ")}).`;
  }
  // sanity check: text must not be empty / whitespace-only
  if (!lockfile.trim()) return `lockfile text is empty for type '${lockfileType}'.`;
  // format-specific structural sanity check
  const structural = structuralSanity(lockfile, lockfileType);
  if (structural) return structural;
  return null;
}

function structuralSanity(lockfile, lockfileType) {
  if (lockfileType === "package-lock.json") {
    try {
      const data = JSON.parse(lockfile);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return "package-lock.json must parse to a JSON object.";
      }
      const hasPackages = data.packages && typeof data.packages === "object";
      const hasDependencies = data.dependencies && typeof data.dependencies === "object";
      if (!hasPackages && !hasDependencies) {
        return "package-lock.json must contain a top-level 'packages' or 'dependencies' object.";
      }
      return null;
    } catch (e) {
      return `package-lock.json is not valid JSON: ${e.message}`;
    }
  }
  if (lockfileType === "Cargo.lock") {
    if (!/\[package\]|^name\s*=/m.test(lockfile)) {
      return "Cargo.lock must contain at least one [package] section with a 'name' entry.";
    }
    return null;
  }
  if (lockfileType === "requirements.txt") {
    if (!/^\s*[A-Za-z0-9_.\-[\]]+/m.test(lockfile)) {
      return "requirements.txt must contain at least one package specifier.";
    }
    return null;
  }
  if (lockfileType === "go.sum") {
    // Each line: module version[/go.mod] h1:hash
    if (!/^\S+\s+\S+\s+h1:/m.test(lockfile)) {
      return "go.sum must contain at least one h1: hash line.";
    }
    return null;
  }
  if (lockfileType === "Gemfile.lock") {
    if (!/^GEM$/m.test(lockfile) || !/^\s*remote:/m.test(lockfile) || !/^\s*specs:/m.test(lockfile)) {
      return "Gemfile.lock must contain GEM / remote: / specs: sections.";
    }
    return null;
  }
  if (lockfileType === "pnpm-lock.yaml") {
    if (!/^lockfileVersion:/m.test(lockfile) || !/^importers:/m.test(lockfile)) {
      return "pnpm-lock.yaml must contain lockfileVersion: and importers: sections.";
    }
    return null;
  }
  if (lockfileType === "yarn.lock") {
    if (!/^[^\s#].*:\s*$/m.test(lockfile) || !/^    version\s/m.test(lockfile)) {
      return "yarn.lock must contain at least one spec block with a '    version' line.";
    }
    return null;
  }
  if (lockfileType === "composer.lock") {
    try {
      const data = JSON.parse(lockfile);
      if (!data || !Array.isArray(data.packages)) {
        return "composer.lock must be valid JSON with a top-level 'packages' array.";
      }
      return null;
    } catch (e) {
      return `composer.lock is not valid JSON: ${e.message}`;
    }
  }
  return null;
}

function emptyOutputs() {
  return {
    sbom: null,
    components: [],
    license_summary: { declared_count: 0, detected_count: 0, unknown_count: 0, declared: [], detected: [] },
    license_risks: [],
    refusal: { reason: null },
  };
}

function parseComponents(lockfile, lockfileType) {
  const parser = parsers[lockfileType];
  return parser(lockfile);
}

const parsers = {
  "package-lock.json": parseNpm,
  "Cargo.lock": parseCargo,
  "requirements.txt": parseRequirements,
  "go.sum": parseGoSum,
  "Gemfile.lock": parseGemfile,
  "pnpm-lock.yaml": parsePnpm,
  "yarn.lock": parseYarn,
  "composer.lock": parseComposer,
};

function parseNpm(text) {
  const data = JSON.parse(text);
  const components = [];
  const seen = new Set();
  const rootLicense = (data.packages && data.packages[""] && data.packages[""].license) || null;
  if (data.packages) {
    for (const [path, info] of Object.entries(data.packages)) {
      if (!path) continue;
      if (!info || typeof info !== "object") continue;
      if (!info.version) continue;
      const name = path.replace(/^node_modules\//, "");
      const key = `${name}@${info.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      components.push({
        type: "library",
        name,
        version: info.version,
        purl: `pkg:npm/${name}@${info.version}`,
        evidence: { identity: [{ field: `lockfile.packages.${path}.version`, confidence: 1.0 }] },
      });
    }
  } else if (data.dependencies) {
    for (const [name, info] of Object.entries(data.dependencies)) {
      if (!info) continue;
      const version = typeof info === "string" ? info : info.version;
      if (!version) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      components.push({
        type: "library",
        name,
        version,
        purl: `pkg:npm/${name}@${version}`,
        evidence: { identity: [{ field: `lockfile.dependencies.${name}.version`, confidence: 1.0 }] },
      });
    }
  }
  if (rootLicense) {
    components.unshift({
      type: "application",
      name: data.name || "root",
      version: data.version || "0.0.0",
      purl: `pkg:npm/${data.name || "root"}@${data.version || "0.0.0"}`,
      evidence: { identity: [{ field: "lockfile.packages[''].license", confidence: 1.0 }] },
      licenses: [{ license: { id: rootLicense } }],
    });
  }
  return components;
}

function parseCargo(text) {
  const components = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "[[package]]") {
      if (current && current.name && current.version) {
        components.push(currentToComponent(current, "pkg:cargo"));
      }
      current = {};
      continue;
    }
    if (!current) continue;
    const m = line.match(/^(\w+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.replace(/^"|"$/g, "").replace(/\\"/g, '"');
    if (key === "name") current.name = value;
    if (key === "version") current.version = value;
    if (key === "license") {
      current.licenses = value.split("/").map((id) => ({ license: { id: id.trim() } })).filter((l) => l.license.id);
    }
  }
  if (current && current.name && current.version) {
    components.push(currentToComponent(current, "pkg:cargo"));
  }
  return dedupeByPurl(components);
}

function parseRequirements(text) {
  const components = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Skip include directives / options
    if (trimmed.startsWith("-") || trimmed.startsWith("--")) continue;
    const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*(?:\[.*?\])?\s*([=<>!~]=?)\s*([A-Za-z0-9_.+\-]+)/);
    if (!m) continue;
    const [, name, , version] = m;
    components.push({
      type: "library",
      name,
      version,
      purl: `pkg:pypi/${name}@${version}`,
      evidence: { identity: [{ field: "lockfile line", confidence: 1.0 }] },
    });
  }
  return dedupeByPurl(components);
}

function parseGoSum(text) {
  const components = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [mod, version] = parts;
    if (!mod || !version) continue;
    const key = `${mod}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push({
      type: "library",
      name: mod,
      version,
      purl: `pkg:golang/${mod}@${version}`,
      evidence: { identity: [{ field: "lockfile line", confidence: 1.0 }] },
    });
  }
  return dedupeByPurl(components);
}

function parseGemfile(text) {
  const components = [];
  let inSpecs = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "specs:") { inSpecs = true; continue; }
    if (line.match(/^[A-Z][A-Z ]*$/)) { inSpecs = false; continue; }
    if (!inSpecs) continue;
    const m = line.match(/^\s{4}([A-Za-z0-9_.\-]+)\s+\(([0-9][^)]*)\)/);
    if (!m) continue;
    const [, name, version] = m;
    components.push({
      type: "library",
      name,
      version,
      purl: `pkg:gem/${name}@${version}`,
      evidence: { identity: [{ field: "lockfile Gemfile.lock specs block", confidence: 1.0 }] },
    });
  }
  return dedupeByPurl(components);
}

function parsePnpm(text) {
  const components = [];
  // Extract package paths from /<name>@<version> patterns in the import graph
  const re = /^\s*(\/[^:]*?@([0-9][^:\s]*)):\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const path = m[1];
    const version = m[2];
    const name = path.replace(/^\//, "").replace(/@[^@]+$/, "");
    if (!name) continue;
    components.push({
      type: "library",
      name,
      version,
      purl: `pkg:npm/${name}@${version}`,
      evidence: { identity: [{ field: "lockfile pnpm-lock.yaml importers", confidence: 1.0 }] },
    });
  }
  return dedupeByPurl(components);
}

function parseYarn(text) {
  const components = [];
  const blocks = text.split(/\n\n(?=[^\s#])/);
  for (const block of blocks) {
    const firstLine = block.split("\n")[0];
    const m = firstLine.match(/^"?(@?[^@"\s]+(?:\/[^@"\s]+)?)"?(@[^:]+)?\s*:\s*$/);
    if (!m) continue;
    const name = m[1];
    const v = block.match(/^\s{4}version\s+"([^"]+)"/m);
    if (!v) continue;
    const version = v[1];
    components.push({
      type: "library",
      name,
      version,
      purl: name.startsWith("@") ? `pkg:npm/${name}@${version}` : `pkg:npm/${name}@${version}`,
      evidence: { identity: [{ field: "lockfile yarn.lock block", confidence: 1.0 }] },
    });
  }
  return dedupeByPurl(components);
}

function parseComposer(text) {
  const data = JSON.parse(text);
  const components = [];
  for (const entry of data.packages || []) {
    if (!entry.name || !entry.version) continue;
    components.push({
      type: "library",
      name: entry.name,
      version: entry.version,
      purl: `pkg:composer/${entry.name}@${entry.version}`,
      evidence: { identity: [{ field: "lockfile composer.lock packages[]", confidence: 1.0 }] },
      licenses: entry.license ? [{ license: { id: Array.isArray(entry.license) ? entry.license[0] : entry.license } }] : [],
    });
  }
  return dedupeByPurl(components);
}

function currentToComponent(current, purlPrefix) {
  return {
    type: "library",
    name: current.name,
    version: current.version,
    purl: `${purlPrefix}/${current.name}@${current.version}`,
    evidence: { identity: [{ field: "lockfile Cargo.lock [[package]]", confidence: 1.0 }] },
    licenses: current.licenses || [],
  };
}

function dedupeByPurl(components) {
  const seen = new Map();
  for (const c of components) {
    if (!seen.has(c.purl)) seen.set(c.purl, c);
  }
  return [...seen.values()];
}

function buildSbom(components, lockfile, lockfileType) {
  const lockfileSha = crypto.createHash("sha256").update(lockfile).digest("hex");
  const componentsSerial = components.map((c) => c.purl).sort().join("\n");
  const serialUuid = crypto.createHash("sha256").update(`${lockfileSha}\n${componentsSerial}`).digest("hex").slice(0, 12);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:sbom-maker-${serialUuid}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "runx", name: "sbom-maker", version: "0.1.0" }],
      component: rootComponentFor(lockfileType),
      properties: [
        { name: "runx:skill:lockfile_type", value: lockfileType },
        { name: "runx:skill:lockfile_sha256", value: lockfileSha },
      ],
    },
    components: components.filter((c) => c.type === "library"),
  };
}

function rootComponentFor(lockfileType) {
  return { type: "application", name: `sbom-maker-input-${lockfileType}`, version: "0.0.0" };
}

function summarizeLicenses(components) {
  const declared = [];
  const detected = [];
  let unknown = 0;
  for (const c of components) {
    const list = c.licenses || [];
    if (list.length === 0) {
      unknown += 1;
      continue;
    }
    for (const entry of list) {
      const id = entry && entry.license && entry.license.id;
      if (!id) {
        unknown += 1;
        continue;
      }
      const norm = id.toLowerCase();
      // SPDX-listed vs common variants: we report detected vs declared based on uppercase
      if (id === id.toUpperCase()) {
        declared.push({ license_id: id, component_purl: c.purl });
      } else {
        detected.push({ license_id: id, component_purl: c.purl });
      }
      void norm;
    }
  }
  return {
    declared_count: declared.length,
    detected_count: detected.length,
    unknown_count: unknown,
    declared,
    detected,
  };
}

function licenseRisksFor(summary) {
  const risks = [];
  const UNKNOWN_LICENSES = new Set(["gpl-3.0", "gpl-2.0", "agpl-3.0", "sspl", "busl-1.1"]);
  const RISKY_LICENSES = new Set(["gpl-3.0", "gpl-2.0", "agpl-3.0", "sspl", "busl-1.1"]);
  for (const d of summary.declared) {
    if (UNKNOWN_LICENSES.has(d.license_id.toLowerCase())) {
      risks.push({
        level: "review",
        license_id: d.license_id,
        component_purl: d.component_purl,
        reason: "License requires manual review for downstream use.",
      });
    }
  }
  for (const d of summary.detected) {
    if (RISKY_LICENSES.has(d.license_id.toLowerCase())) {
      risks.push({
        level: "review",
        license_id: d.license_id,
        component_purl: d.component_purl,
        reason: "License requires manual review for downstream use.",
      });
    }
  }
  return risks;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    lockfile: process.env.RUNX_INPUT_LOCKFILE,
    lockfile_type: process.env.RUNX_INPUT_LOCKFILE_TYPE,
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

main();
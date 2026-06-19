#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
function defaultRepoRoot() {
  for (const candidate of [path.resolve(scriptRoot, ".."), path.resolve(scriptRoot, "..", "..")]) {
    if (fs.existsSync(path.join(candidate, "docs/license-boundary.manifest.json"))) {
      return candidate;
    }
  }
  return path.resolve(scriptRoot, "..");
}

const root = process.env.RUNX_LICENSE_BOUNDARY_ROOT
  ? path.resolve(process.env.RUNX_LICENSE_BOUNDARY_ROOT)
  : defaultRepoRoot();
const manifestPath = process.env.RUNX_LICENSE_BOUNDARY_MANIFEST
  ? path.resolve(root, process.env.RUNX_LICENSE_BOUNDARY_MANIFEST)
  : path.join(root, "docs/license-boundary.manifest.json");
const docPath = path.join(root, "docs/licensing-boundary.md");
const legacyPrivateProviderGatewayIdentifiers = [
  `Nan${"go"}`,
  `${"nan"}${"go"}`,
  `Nan${"go"}Connection`,
  `${"nan"}${"go"}_connection`,
  `Nan${"go"}Hosted`,
];

function fail(message) {
  console.error(`license-boundary: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function readPackageName(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}

function workspaceCrateNames() {
  const cratesDir = path.join(root, "crates");
  return fs
    .readdirSync(cratesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(cratesDir, entry.name, "Cargo.toml"))
    .filter((file) => fs.existsSync(file))
    .map(readPackageName)
    .filter(Boolean)
    .sort();
}

function assertArray(name, value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} must be a non-empty array`);
  }
}

function assertExistingPath(label, file) {
  if (!fs.existsSync(path.join(root, file))) {
    fail(`${label} references missing path: ${file}`);
  }
}

function packageDirsByName() {
  const cratesDir = path.join(root, "crates");
  const result = new Map();
  for (const entry of fs.readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cargoToml = path.join(cratesDir, entry.name, "Cargo.toml");
    if (!fs.existsSync(cargoToml)) continue;
    const packageName = readPackageName(cargoToml);
    if (packageName) result.set(packageName, path.join("crates", entry.name));
  }
  return result;
}

function walkFiles(startPath, files = []) {
  if (!fs.existsSync(startPath)) return files;
  const stat = fs.statSync(startPath);
  if (stat.isFile()) {
    if (startPath.endsWith(".rs")) files.push(startPath);
    return files;
  }
  for (const entry of fs.readdirSync(startPath, { withFileTypes: true })) {
    walkFiles(path.join(startPath, entry.name), files);
  }
  return files;
}

function relativePath(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isExcluded(relative, excludeGlobs) {
  return excludeGlobs.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return relative.startsWith(pattern.slice(0, -3));
    }
    if (pattern.includes("**/*.")) {
      const [prefix, suffix] = pattern.split("**/*.");
      return relative.startsWith(prefix) && relative.endsWith(`.${suffix}`);
    }
    return relative === pattern;
  });
}

function isAllowlisted(allowlist, relative, identifier) {
  return allowlist.some(
    (item) =>
      item.identifier === identifier &&
      (item.path === relative ||
        (item.path.endsWith("/**") && relative.startsWith(item.path.slice(0, -3))))
  );
}

function checkManifestComplete() {
  if (!fs.existsSync(docPath)) {
    fail("docs/licensing-boundary.md is missing");
  }
  const manifest = readJson(manifestPath);
  if (manifest.schema !== "runx.license_boundary_manifest.v1") {
    fail("manifest schema must be runx.license_boundary_manifest.v1");
  }
  if (!manifest.inventory_command?.includes("rg -n")) {
    fail("manifest must record the inventory command");
  }
  const crateClasses = manifest.crate_classes ?? {};
  for (const crateName of workspaceCrateNames()) {
    const entry = crateClasses[crateName];
    if (!entry) {
      fail(`crate ${crateName} is missing from crate_classes`);
    }
    if (!["mit-oss", "private"].includes(entry.class)) {
      fail(`crate ${crateName} has invalid class ${entry.class}`);
    }
    if (!entry.decision || !entry.phase1_state) {
      fail(`crate ${crateName} must include decision and phase1_state`);
    }
  }
  assertArray("banned_identifiers", manifest.banned_identifiers);
  for (const required of [
    "RUNX_CONNECT_ACCESS_TOKEN",
    "ConnectClient",
    "connection_id",
  ]) {
    if (!manifest.banned_identifiers.includes(required)) {
      fail(`banned_identifiers is missing ${required}`);
    }
  }
  assertArray("allowlist", manifest.allowlist);
  for (const item of manifest.allowlist) {
    if (!item.path || !item.identifier || !item.rationale) {
      fail("each allowlist item must include path, identifier, and rationale");
    }
    assertExistingPath("allowlist", item.path);
  }
  assertArray("exclude_globs", manifest.exclude_globs);
  if (!manifest.exclude_globs.includes("crates/runx-runtime/tests/fixtures/license_boundary/**")) {
    fail("exclude_globs must include the license boundary negative fixture path");
  }
  assertArray("private_move_or_abstract", manifest.private_move_or_abstract);
  for (const item of manifest.private_move_or_abstract) {
    if (!item.path || !item.decision || !item.rationale) {
      fail("each private_move_or_abstract item must include path, decision, and rationale");
    }
    if (!item.removed) {
      assertExistingPath("private_move_or_abstract", item.path);
    }
  }
  if (manifest.private_home?.path !== "../cloud/packages/auth") {
    fail("private_home.path must be ../cloud/packages/auth");
  }
  console.log(
    JSON.stringify({
      ok: true,
      check: "manifest-complete",
      crates: Object.keys(crateClasses).length,
      banned_identifiers: bannedIdentifiersForGuard(manifest).length,
      allowlist: manifest.allowlist.length,
      private_move_or_abstract: manifest.private_move_or_abstract.length,
    })
  );
}

function loadManifestForGuard() {
  const manifest = readJson(manifestPath);
  assertArray("banned_identifiers", manifest.banned_identifiers);
  assertArray("exclude_globs", manifest.exclude_globs);
  return manifest;
}

function bannedIdentifiersForGuard(manifest) {
  return Array.from(new Set([...manifest.banned_identifiers, ...legacyPrivateProviderGatewayIdentifiers]));
}

function scanRoots(manifest) {
  const override = process.env.RUNX_LICENSE_BOUNDARY_SCAN_ROOTS;
  if (override) {
    return override.split(":").filter(Boolean).map((item) => path.resolve(root, item));
  }
  const dirs = packageDirsByName();
  return Object.entries(manifest.crate_classes ?? {})
    .filter(([, entry]) => entry.class === "mit-oss")
    .map(([crateName]) => dirs.get(crateName))
    .filter(Boolean)
    .flatMap((crateDir) => [path.join(crateDir, "src"), path.join(crateDir, "tests")])
    .map((relative) => path.join(root, relative));
}

function checkIdentifiers() {
  const manifest = loadManifestForGuard();
  const violations = [];
  for (const scanRoot of scanRoots(manifest)) {
    for (const file of walkFiles(scanRoot)) {
      const relative = relativePath(file);
      if (isExcluded(relative, manifest.exclude_globs)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const identifier of bannedIdentifiersForGuard(manifest)) {
        if (text.includes(identifier) && !isAllowlisted(manifest.allowlist ?? [], relative, identifier)) {
          violations.push(`${relative}: ${identifier}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    fail(`identifier violations:\n${violations.join("\n")}`);
  }
  console.log(JSON.stringify({ ok: true, check: "identifiers" }));
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function checkEdges() {
  const manifest = loadManifestForGuard();
  const privateCrates = new Set(manifest.private_crate_names ?? []);
  if (privateCrates.size === 0) {
    console.log(JSON.stringify({ ok: true, check: "edges", private_crates: 0 }));
    return;
  }
  const metadata = JSON.parse(readStdin());
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const classByName = new Map(
    Object.entries(manifest.crate_classes ?? {}).map(([name, entry]) => [name, entry.class])
  );
  const violations = [];
  for (const node of metadata.resolve?.nodes ?? []) {
    const pkg = packagesById.get(node.id);
    if (!pkg || classByName.get(pkg.name) !== "mit-oss") continue;
    for (const dependency of node.deps ?? []) {
      const depPkg = packagesById.get(dependency.pkg);
      if (depPkg && privateCrates.has(depPkg.name)) {
        violations.push(`${pkg.name} -> ${depPkg.name}`);
      }
    }
  }
  if (violations.length > 0) {
    fail(`private dependency edge violations:\n${violations.join("\n")}`);
  }
  console.log(JSON.stringify({ ok: true, check: "edges", private_crates: privateCrates.size }));
}

const checkIndex = process.argv.indexOf("--check");
const check = checkIndex === -1 ? "default" : process.argv[checkIndex + 1];

if (check === "default") {
  checkManifestComplete();
  checkIdentifiers();
} else if (check === "manifest-complete") {
  checkManifestComplete();
} else if (check === "identifiers" || check === "edges") {
  if (check === "identifiers") {
    checkIdentifiers();
  } else {
    checkEdges();
  }
} else {
  fail("usage: check-license-edges.mjs --check manifest-complete|identifiers|edges");
}

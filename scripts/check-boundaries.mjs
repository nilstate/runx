import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirectoryNames = new Set(["node_modules", "dist", ".build", "coverage"]);
const removedCoreRuntimeSubpaths = [
  "@runxhq/core/runner-local",
  "@runxhq/core/harness",
  "@runxhq/core/sdk",
  "@runxhq/core/mcp",
  "@runxhq/core/tool-catalogs",
];
const forbiddenCoreRuntimeDirs = ["runner-local", "harness", "sdk", "mcp", "tool-catalogs"];
const forbiddenPureNodeImports = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
  "dns",
  "node:dns",
  "worker_threads",
  "node:worker_threads",
]);
const forbiddenPackageImports = {
  core: {
    prefixes: [
      "@runxhq/runtime-local",
      "@runxhq/adapters",
      "@runxhq/cli",
      "@runxhq/host-adapters",
      "@runxhq/langchain",
    ],
    reason: "@runxhq/core must not depend on runtime, adapters, CLI, or host packages.",
  },
  "runtime-local": {
    prefixes: [
      "@runxhq/adapters",
      "@runxhq/cli",
      "@runxhq/host-adapters",
      "@runxhq/langchain",
    ],
    reason: "@runxhq/runtime-local must not depend on downstream adapters, CLI, or host packages.",
  },
  adapters: {
    prefixes: [
      "@runxhq/cli",
      "@runxhq/host-adapters",
      "@runxhq/langchain",
    ],
    reason: "@runxhq/adapters must stay below host, CLI, and framework packages.",
  },
  "host-adapters": {
    prefixes: [
      "@runxhq/adapters",
      "@runxhq/cli",
      "@runxhq/langchain",
    ],
    reason: "@runxhq/host-adapters must not depend on adapters, CLI, or framework packages.",
  },
  langchain: {
    prefixes: [
      "@runxhq/adapters",
      "@runxhq/cli",
      "@runxhq/host-adapters",
    ],
    reason: "@runxhq/langchain must not depend on adapters, CLI, or host packages.",
  },
};
const pureCoreDomains = ["policy", "state-machine"];
const relativeRuntimeDomainPattern = /(^|\/)(runner-local|harness|sdk|mcp)(\/|$)/;
const staticSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const receiptStorageImportPattern =
  /\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s+from\s+["']([^"']*receipts[^"']*)["']/g;
const forbiddenExecutorReceiptImports = new Set([
  "writeLocalReceipt",
  "writeLocalGraphReceipt",
  "buildLocalReceipt",
  "buildLocalGraphReceipt",
]);

const findings = [];
const packageManifestCache = new Map();
const workspacePackageNames = await readWorkspacePackageNames();

await checkPackageExports();
await checkForbiddenCoreRuntimeDirectories();
for (const filePath of await findSourceFiles(workspaceRoot)) {
  await checkSourceFile(filePath);
}

if (findings.length > 0) {
  console.error("Boundary check failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Boundary check passed.");

async function checkPackageExports() {
  const coreManifestPath = path.join(workspaceRoot, "packages", "core", "package.json");
  const runtimeLocalManifestPath = path.join(workspaceRoot, "packages", "runtime-local", "package.json");
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
  const runtimeLocalManifest = JSON.parse(await readFile(runtimeLocalManifestPath, "utf8"));

  for (const removedSubpath of ["./runner-local", "./harness", "./sdk", "./mcp", "./tool-catalogs"]) {
    if (Object.hasOwn(coreManifest.exports ?? {}, removedSubpath)) {
      findings.push(`packages/core/package.json still exports ${removedSubpath}; use @runxhq/runtime-local instead.`);
    }
  }

  for (const requiredSubpath of [".", "./harness", "./runner-local", "./sdk", "./mcp", "./tool-catalogs"]) {
    if (!Object.hasOwn(runtimeLocalManifest.exports ?? {}, requiredSubpath)) {
      findings.push(`packages/runtime-local/package.json is missing export ${requiredSubpath}.`);
    }
  }
}

async function checkForbiddenCoreRuntimeDirectories() {
  for (const directoryName of forbiddenCoreRuntimeDirs) {
    const directoryPath = path.join(workspaceRoot, "packages", "core", "src", directoryName);
    const entry = await statIfExists(directoryPath);
    if (entry?.isDirectory()) {
      findings.push(`packages/core/src/${directoryName} still exists; runtime-local owns this boundary.`);
    }
  }
}

async function checkSourceFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const specifiers = extractSpecifiers(source);
  const rel = toPosix(path.relative(workspaceRoot, filePath));
  const packageSource = getPackageSource(rel);

  for (const specifier of specifiers) {
    if (removedCoreRuntimeSubpaths.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
      findings.push(`${rel} imports removed ${specifier}; use @runxhq/runtime-local public paths.`);
    }

    if (packageSource) {
      checkForbiddenPackageImport(rel, packageSource.packageName, specifier);
      await checkDeclaredWorkspaceImport(rel, packageSource.packageName, specifier);
    }

    if (packageSource?.packageName === "core") {
      checkCoreImport(rel, packageSource.domain, specifier);
    }

    if (rel.startsWith("packages/") && isCloudSpecifier(specifier)) {
      findings.push(`${rel} imports cloud code; oss must not depend on cloud.`);
    }
  }

  if (packageSource?.packageName === "core" && packageSource.domain === "executor") {
    checkExecutorReceiptOwnership(rel, source);
  }
}

function checkCoreImport(rel, domain, specifier) {
  if (specifier.startsWith(".") && relativeRuntimeDomainPattern.test(toPosix(path.normalize(path.join(path.dirname(rel), specifier))))) {
    findings.push(`${rel} imports ${specifier}; core cannot reach removed runtime-local domains by relative path.`);
  }

  if (pureCoreDomains.includes(domain)) {
    if (forbiddenPureNodeImports.has(specifier)) {
      findings.push(`${rel} imports ${specifier}; ${domain} must remain pure and deterministic.`);
    }
    if (specifierTargetsDomain(rel, specifier, "executor") || specifierTargetsDomain(rel, specifier, "tool-catalogs")) {
      findings.push(`${rel} imports ${specifier}; ${domain} cannot depend on execution or catalog boundaries.`);
    }
  }

  if (domain === "executor") {
    if (specifierTargetsDomain(rel, specifier, "adapters")) {
      findings.push(`${rel} imports ${specifier}; executor must stay protocol-agnostic and avoid concrete adapters.`);
    }
  }

  if (domain === "parser" && specifierTargetsDomain(rel, specifier, "adapters")) {
    findings.push(`${rel} imports ${specifier}; parser cannot depend on concrete adapters.`);
  }
}

function checkExecutorReceiptOwnership(rel, source) {
  let match;
  while ((match = receiptStorageImportPattern.exec(source)) !== null) {
    const specifier = match[4];
    if (!specifierTargetsDomain(rel, specifier, "receipts")) {
      continue;
    }
    if (match[2] || match[3]) {
      findings.push(`${rel} imports ${specifier}; executor must not default- or namespace-import receipt storage helpers.`);
      continue;
    }
    const importedNames = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/u)[0]?.trim())
      .filter(Boolean);
    for (const importedName of importedNames) {
      if (forbiddenExecutorReceiptImports.has(importedName)) {
        findings.push(`${rel} imports ${importedName} from ${specifier}; executor returns observations but must not write or own receipts.`);
      }
    }
  }
}

function checkForbiddenPackageImport(rel, packageName, specifier) {
  const rule = forbiddenPackageImports[packageName];
  if (!rule) {
    return;
  }
  if (rule.prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
    findings.push(`${rel} imports ${specifier}; ${rule.reason}`);
  }
}

async function checkDeclaredWorkspaceImport(rel, packageName, specifier) {
  const dependencyName = workspaceDependencyName(specifier);
  if (!dependencyName || !workspacePackageNames.has(dependencyName)) {
    return;
  }

  const manifest = await readPackageManifest(packageName);
  if (!manifest || manifest.name === dependencyName) {
    return;
  }

  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  if (!Object.hasOwn(declared, dependencyName)) {
    findings.push(`${rel} imports ${specifier}; ${manifest.name} must declare ${dependencyName} in package.json.`);
  }
}

function extractSpecifiers(source) {
  const specifiers = [];
  let match;
  while ((match = staticSpecifierPattern.exec(source)) !== null) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

function getPackageSource(rel) {
  const parts = rel.split("/");
  if (parts[0] !== "packages" || parts[2] !== "src") {
    return undefined;
  }
  return {
    packageName: parts[1],
    domain: parts[3] ?? "",
  };
}

function workspaceDependencyName(specifier) {
  const match = /^(@runxhq\/[^/]+)/.exec(specifier);
  return match?.[1];
}

async function readWorkspacePackageNames() {
  const packagesDir = path.join(workspaceRoot, "packages");
  const names = new Set();
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = await readPackageManifest(entry.name);
    if (manifest?.name) {
      names.add(manifest.name);
    }
  }
  return names;
}

async function readPackageManifest(packageName) {
  if (packageManifestCache.has(packageName)) {
    return packageManifestCache.get(packageName);
  }
  const manifestPath = path.join(workspaceRoot, "packages", packageName, "package.json");
  const manifest = await readJsonIfExists(manifestPath);
  packageManifestCache.set(packageName, manifest);
  return manifest;
}

function specifierTargetsDomain(rel, specifier, domain) {
  if (specifier === `@runxhq/core/${domain}` || specifier.startsWith(`@runxhq/core/${domain}/`)) {
    return true;
  }
  if (specifier === `@runxhq/${domain}` || specifier.startsWith(`@runxhq/${domain}/`)) {
    return true;
  }
  if (!specifier.startsWith(".")) {
    return false;
  }
  const target = toPosix(path.normalize(path.join(path.dirname(rel), specifier)));
  return target.split("/").includes(domain);
}

function isCloudSpecifier(specifier) {
  return specifier === "cloud" || specifier.startsWith("cloud/") || specifier.includes("/cloud/");
}

async function findSourceFiles(root) {
  const files = [];
  await walk(root, files);
  return files;
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) {
        await walk(path.join(directory, entry.name), files);
      }
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name)) || isTestFile(entry.name)) {
      continue;
    }
    files.push(path.join(directory, entry.name));
  }
}

async function statIfExists(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readJsonIfExists(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(contents);
}

function isNotFound(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isTestFile(fileName) {
  return /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(fileName);
}

function toPosix(input) {
  return input.split(path.sep).join("/");
}

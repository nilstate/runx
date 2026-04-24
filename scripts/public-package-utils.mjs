import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tar = process.platform === "win32" ? "tar.exe" : "tar";

export function resolveWorkspacePackageDir(input) {
  if (input.startsWith(".") || input.startsWith("/") || input.includes(path.sep)) {
    return path.resolve(workspaceRoot, input);
  }
  return path.join(workspaceRoot, "packages", input);
}

export async function readWorkspacePackageVersions() {
  const versions = new Map();
  for (const dir of await readdir(path.join(workspaceRoot, "packages"), { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(workspaceRoot, "packages", dir.name, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        versions.set(manifest.name, manifest.version);
      }
    } catch {
      // ignore directories that are not publishable packages
    }
  }
  return versions;
}

export async function readPackageManifest(packageDir) {
  return JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
}

export function rewriteManifestForPublish(manifest, versions) {
  const next = structuredClone(manifest);
  for (const sectionName of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
    const section = next[sectionName];
    if (!isRecord(section)) {
      continue;
    }
    const rewritten = {};
    for (const [dependencyName, spec] of Object.entries(section)) {
      rewritten[dependencyName] = typeof spec === "string"
        ? rewriteWorkspaceProtocol(dependencyName, spec, versions)
        : spec;
    }
    next[sectionName] = rewritten;
  }
  return next;
}

export async function preparePublicPackageForPublish(packageDir) {
  const versions = await readWorkspacePackageVersions();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runx-public-package-"));
  const pack = await execFileAsync(npm, ["pack", "--json"], {
    cwd: packageDir,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const [report] = JSON.parse(pack.stdout);
  if (!report?.filename) {
    throw new Error(`npm pack did not report a tarball for ${packageDir}`);
  }
  const tarballPath = path.join(packageDir, report.filename);
  await execFileAsync(tar, ["-xzf", tarballPath], {
    cwd: tempRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const publishDir = path.join(tempRoot, "package");
  const manifest = rewriteManifestForPublish(await readPackageManifest(publishDir), versions);
  await writeFile(path.join(publishDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { tempRoot, publishDir, tarballPath, manifest };
}

export async function cleanupPreparedPublicPackage(prepared) {
  await rm(prepared.tarballPath, { force: true });
  await rm(prepared.tempRoot, { recursive: true, force: true });
}

function rewriteWorkspaceProtocol(dependencyName, spec, versions) {
  if (!spec.startsWith("workspace:")) {
    return spec;
  }
  const version = versions.get(dependencyName);
  if (!version) {
    throw new Error(`Unable to resolve workspace version for ${dependencyName}.`);
  }
  const requested = spec.slice("workspace:".length).trim();
  if (requested === "" || requested === "*" || requested === version) {
    return version;
  }
  if (requested === "^" || requested === "~") {
    return `${requested}${version}`;
  }
  if (requested.startsWith("^")) {
    return `^${version}`;
  }
  if (requested.startsWith("~")) {
    return `~${version}`;
  }
  return requested;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

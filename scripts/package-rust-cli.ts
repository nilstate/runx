import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

interface Options {
  readonly check: boolean;
  readonly binary: string;
  readonly outDir: string;
  readonly platform: string | null;
  readonly signatureManifest: string | null;
}

interface PlatformSpec {
  readonly key: string;
  readonly os: "darwin" | "linux" | "win32";
  readonly cpu: "arm64" | "x64";
  readonly binaryName: "runx" | "runx.exe";
}

const supportedPlatforms: readonly PlatformSpec[] = [
  { key: "darwin-arm64", os: "darwin", cpu: "arm64", binaryName: "runx" },
  { key: "darwin-x64", os: "darwin", cpu: "x64", binaryName: "runx" },
  { key: "linux-arm64", os: "linux", cpu: "arm64", binaryName: "runx" },
  { key: "linux-x64", os: "linux", cpu: "x64", binaryName: "runx" },
  { key: "win32-x64", os: "win32", cpu: "x64", binaryName: "runx.exe" },
];

const options = parseArgs(process.argv.slice(2));
const packageRoot = path.join(workspaceRoot, "packages", "cli");
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly bugs?: unknown;
  readonly repository?: unknown;
  readonly publishConfig?: unknown;
};

const platform = platformSpec(options.platform ?? platformKey(process.platform, process.arch));
const nativePackage = nativePackageName(manifest.name, platform.key);
const binaryPath = resolveCandidatePath(options.binary);
const outDir = path.resolve(workspaceRoot, options.outDir);
const stagingRoot = options.check
  ? path.join(os.tmpdir(), `runx-rust-cli-package-${process.pid}`)
  : outDir;
const selectorRoot = path.join(stagingRoot, "selector");
const nativeRoot = path.join(stagingRoot, platform.key);

if (options.check) {
  rmSync(stagingRoot, { recursive: true, force: true });
} else {
  rmSync(selectorRoot, { recursive: true, force: true });
  rmSync(nativeRoot, { recursive: true, force: true });
}
mkdirSync(path.join(selectorRoot, "bin"), { recursive: true });
mkdirSync(path.join(selectorRoot, "native"), { recursive: true });
mkdirSync(path.join(nativeRoot, "bin"), { recursive: true });
mkdirSync(path.join(nativeRoot, "native"), { recursive: true });

assertExecutable(binaryPath);
const stagedBinaryName = platform.binaryName;
const stagedBinary = path.join(nativeRoot, "bin", stagedBinaryName);
copyFileSync(binaryPath, stagedBinary);
if (platform.os !== "win32") {
  chmodSync(stagedBinary, 0o755);
}
copyFileSync(path.join(packageRoot, "LICENSE"), path.join(selectorRoot, "LICENSE"));
copyFileSync(path.join(packageRoot, "LICENSE"), path.join(nativeRoot, "LICENSE"));
copyFileSync(path.join(packageRoot, "bin", "runx"), path.join(selectorRoot, "bin", "runx"));
chmodSync(path.join(selectorRoot, "bin", "runx"), 0o755);
copyFileSync(
  path.join(packageRoot, "native", "supported-platforms.json"),
  path.join(selectorRoot, "native", "supported-platforms.json"),
);

const binaryDigest = sha256(readFileSync(stagedBinary));
const signatureManifest = options.signatureManifest
  ? readSignatureManifest(path.resolve(workspaceRoot, options.signatureManifest), {
    packageName: nativePackage,
    version: manifest.version,
    platform: platform.key,
    binary: `bin/${stagedBinaryName}`,
    sha256: binaryDigest,
  })
  : null;
writeFileSync(
  path.join(nativeRoot, "native", "checksums.json"),
  `${JSON.stringify({
    schema: "runx.rust_cli_artifact_checksums.v1",
    package: nativePackage,
    version: manifest.version,
    platform: platform.key,
    binary: `bin/${stagedBinaryName}`,
    sha256: binaryDigest,
  }, null, 2)}\n`,
);
if (signatureManifest) {
  writeFileSync(
    path.join(nativeRoot, "native", "signatures.json"),
    `${JSON.stringify(signatureManifest, null, 2)}\n`,
  );
}

writeFileSync(
  path.join(selectorRoot, "package.json"),
  `${JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    private: false,
    license: manifest.license,
    type: "module",
    engines: { node: ">=18" },
    homepage: manifest.homepage,
    bugs: manifest.bugs,
    repository: manifest.repository,
    publishConfig: manifest.publishConfig,
    bin: {
      runx: "./bin/runx",
    },
    runx: selectorTopology(manifest.name),
    optionalDependencies: Object.fromEntries(
      supportedPlatforms.map((entry) => [nativePackageName(manifest.name, entry.key), manifest.version]),
    ),
    files: [
      "LICENSE",
      "bin/runx",
      "native/supported-platforms.json",
    ],
  }, null, 2)}\n`,
);

writeFileSync(
  path.join(nativeRoot, "package.json"),
  `${JSON.stringify({
    name: nativePackage,
    version: manifest.version,
    description: `${manifest.description ?? "Runx CLI native binary"} (${platform.key})`,
    private: false,
    license: manifest.license,
    engines: { node: ">=18" },
    homepage: manifest.homepage,
    bugs: manifest.bugs,
    repository: manifest.repository,
    publishConfig: manifest.publishConfig,
    os: [platform.os],
    cpu: [platform.cpu],
    runx: {
      nativePackage: {
        schema: "runx.rust_cli_native_package.v1",
        selectorPackage: manifest.name,
        platform: platform.key,
        binary: `bin/${stagedBinaryName}`,
      },
    },
    files: [
      "LICENSE",
      "bin",
      "native/checksums.json",
      ...(signatureManifest ? ["native/signatures.json"] : []),
    ],
  }, null, 2)}\n`,
);

const selectorFiles = packFiles(selectorRoot);
for (const required of ["bin/runx", "native/supported-platforms.json", "package.json", "LICENSE"]) {
  if (!selectorFiles.has(required)) {
    throw new Error(`selector CLI package is missing ${required}`);
  }
}
for (const forbidden of ["bin/runx.js", "dist/index.js", "src/index.ts", "tools/sourcey/build/run.mjs"]) {
  if (selectorFiles.has(forbidden)) {
    throw new Error(`selector CLI package unexpectedly includes ${forbidden}`);
  }
}

const nativeFiles = packFiles(nativeRoot);
for (const required of [`bin/${stagedBinaryName}`, "native/checksums.json", ...(signatureManifest ? ["native/signatures.json"] : []), "package.json", "LICENSE"]) {
  if (!nativeFiles.has(required)) {
    throw new Error(`native CLI package is missing ${required}`);
  }
}
for (const forbidden of ["bin/runx.js", "dist/index.js", "src/index.ts", "tools/sourcey/build/run.mjs"]) {
  if (nativeFiles.has(forbidden)) {
    throw new Error(`native CLI package unexpectedly includes ${forbidden}`);
  }
}

if (options.check) {
  rmSync(stagingRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "passed",
  mode: options.check ? "check" : "write",
  selector_package: manifest.name,
  native_package: nativePackage,
  version: manifest.version,
  platform: platform.key,
  binary: path.relative(workspaceRoot, binaryPath),
  sha256: binaryDigest,
  signature_manifest: signatureManifest ? "native/signatures.json" : null,
  selector_artifact_dir: options.check ? null : path.relative(workspaceRoot, selectorRoot),
  native_artifact_dir: options.check ? null : path.relative(workspaceRoot, nativeRoot),
}, null, 2));

function parseArgs(argv: readonly string[]): Options {
  let check = false;
  let binary = "target/debug/runx";
  let outDir = ".runx/rust-cli-artifacts";
  let platform: string | null = null;
  let signatureManifest: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--binary") {
      binary = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      outDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--platform") {
      platform = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--signature-manifest") {
      signatureManifest = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!binary) {
    throw new Error("--binary requires a path");
  }
  if (!outDir) {
    throw new Error("--out-dir requires a path");
  }
  if (signatureManifest === "") {
    throw new Error("--signature-manifest requires a path");
  }
  if (platform === "") {
    throw new Error("--platform requires a value");
  }

  return { check, binary, outDir, platform, signatureManifest };
}

function assertExecutable(filePath: string): void {
  const entry = statSync(filePath);
  if (!entry.isFile()) {
    throw new Error(`candidate binary is not a file: ${filePath}`);
  }
  if (process.platform !== "win32" && (entry.mode & 0o111) === 0) {
    throw new Error(`candidate binary is not executable: ${filePath}`);
  }
}

function resolveCandidatePath(input: string): string {
  const requested = path.resolve(workspaceRoot, input);
  if (existsPath(requested)) {
    return requested;
  }
  const normalized = input.split(path.sep).join("/");
  if (normalized === "target/debug/runx" || normalized === "target/debug/runx.exe") {
    const cargoWorkspaceCandidate = path.join(workspaceRoot, "crates", normalized);
    if (existsPath(cargoWorkspaceCandidate)) {
      return cargoWorkspaceCandidate;
    }
  }
  return requested;
}

function existsPath(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function platformKey(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  throw new Error(`unsupported Rust CLI package platform: ${platform}/${arch}`);
}

function platformSpec(key: string): PlatformSpec {
  const spec = supportedPlatforms.find((entry) => entry.key === key);
  if (!spec) {
    throw new Error(`unsupported Rust CLI package platform: ${key}`);
  }
  return spec;
}

function nativePackageName(selectorPackage: string, platform: string): string {
  return `${selectorPackage}-${platform}`;
}

function selectorTopology(selectorPackage: string): unknown {
  return {
    nativeSelector: {
      schema: "runx.rust_cli_selector_topology.v1",
      supportedPlatforms: supportedPlatforms.map((entry) => entry.key),
      nativePackagePattern: `${selectorPackage}-\${platform}`,
    },
  };
}

function packFiles(packageDir: string): Set<string> {
  // Node.js on Windows refuses to execFileSync a `.cmd` shim directly
  // (EINVAL) unless shell: true is set. The arguments are hardcoded literals
  // so escaping is not a concern.
  const pack = execFileSync(npm, ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: process.platform === "win32",
  });
  const [packReport] = JSON.parse(pack) as [{ readonly files?: readonly { readonly path: string }[] }];
  return new Set((packReport.files ?? []).map((entry) => entry.path));
}

function readSignatureManifest(
  filePath: string,
  expected: {
    readonly packageName: string;
    readonly version: string;
    readonly platform: string;
    readonly binary: string;
    readonly sha256: string;
  },
): unknown {
  const manifest = JSON.parse(readFileSync(filePath, "utf8")) as {
    readonly schema?: string;
    readonly package?: string;
    readonly version?: string;
    readonly platform?: string;
    readonly binary?: string;
    readonly sha256?: string;
    readonly signatures?: readonly unknown[];
  };
  if (manifest.schema !== "runx.rust_cli_artifact_signatures.v1") {
    throw new Error("signature manifest schema must be runx.rust_cli_artifact_signatures.v1");
  }
  if (manifest.package !== expected.packageName) {
    throw new Error(`signature manifest package ${manifest.package ?? "<missing>"} does not match ${expected.packageName}`);
  }
  if (manifest.version !== expected.version) {
    throw new Error(`signature manifest version ${manifest.version ?? "<missing>"} does not match ${expected.version}`);
  }
  if (manifest.platform !== expected.platform) {
    throw new Error(`signature manifest platform ${manifest.platform ?? "<missing>"} does not match ${expected.platform}`);
  }
  if (manifest.binary !== expected.binary) {
    throw new Error(`signature manifest binary ${manifest.binary ?? "<missing>"} does not match ${expected.binary}`);
  }
  if (manifest.sha256 !== expected.sha256) {
    throw new Error("signature manifest sha256 does not match the staged binary");
  }
  if (!Array.isArray(manifest.signatures) || manifest.signatures.length === 0) {
    throw new Error("signature manifest must include at least one signature entry");
  }
  for (const [index, entry] of manifest.signatures.entries()) {
    if (!isSignatureEntry(entry)) {
      throw new Error(`signature manifest entry ${index} must include non-empty kind and value strings`);
    }
  }
  return manifest;
}

function isSignatureEntry(value: unknown): value is { readonly kind: string; readonly value: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { readonly kind?: unknown; readonly value?: unknown };
  return typeof entry.kind === "string" && entry.kind.trim() !== ""
    && typeof entry.value === "string" && entry.value.trim() !== "";
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function printUsage(): void {
  console.log("Usage: pnpm exec tsx scripts/package-rust-cli.ts [--check] [--binary target/debug/runx] [--out-dir .runx/rust-cli-artifacts] [--platform darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64] [--signature-manifest native/signatures.json]");
}

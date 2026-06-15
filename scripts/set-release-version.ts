import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the runx CLI release version across every channel.
// The git tag (cli-vX.Y.Z) is canonical; this tool stamps that version into all
// version-bearing manifests (write mode) or asserts they already match it
// (check mode, used in CI as a tag/manifest drift guard). The native binary
// reports CARGO_PKG_VERSION, so the crate and npm versions must equal the tag
// for `runx --version` to be truthful regardless of install channel.

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

interface Options {
  readonly version: string;
  readonly check: boolean;
}

interface Finding {
  readonly file: string;
  readonly message: string;
}

const options = parseArgs(process.argv.slice(2));
const findings: Finding[] = [];

const packageJsonPath = path.join(workspaceRoot, "packages", "cli", "package.json");
const cargoTomlPath = path.join(workspaceRoot, "crates", "runx-cli", "Cargo.toml");
const cargoLockPath = path.join(workspaceRoot, "crates", "Cargo.lock");

stampPackageJson(packageJsonPath, options, findings);
stampCargoToml(cargoTomlPath, options, findings);
stampCargoLock(cargoLockPath, options, findings);

if (findings.length > 0) {
  emit({ status: options.check ? "drift" : "failed", version: options.version, findings });
  process.exit(1);
}
emit({
  status: options.check ? "matched" : "stamped",
  version: options.version,
  files: [relative(packageJsonPath), relative(cargoTomlPath), relative(cargoLockPath)],
});

function stampPackageJson(filePath: string, opts: Options, output: Finding[]): void {
  const raw = readFileSync(filePath, "utf8");
  const manifest = JSON.parse(raw) as {
    version?: string;
    optionalDependencies?: Record<string, string>;
  };
  if (opts.check) {
    if (manifest.version !== opts.version) {
      output.push({ file: relative(filePath), message: `version is ${manifest.version}, expected ${opts.version}` });
    }
    for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) {
      if (spec !== opts.version) {
        output.push({ file: relative(filePath), message: `optionalDependencies.${name} is ${spec}, expected ${opts.version}` });
      }
    }
    return;
  }
  manifest.version = opts.version;
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    manifest.optionalDependencies![name] = opts.version;
  }
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function stampCargoToml(filePath: string, opts: Options, output: Finding[]): void {
  const raw = readFileSync(filePath, "utf8");
  // Match the first `version = "..."` in the [package] section.
  const match = raw.match(/^version = "([^"]*)"/mu);
  if (!match) {
    output.push({ file: relative(filePath), message: "could not find a package version line" });
    return;
  }
  if (opts.check) {
    if (match[1] !== opts.version) {
      output.push({ file: relative(filePath), message: `version is ${match[1]}, expected ${opts.version}` });
    }
    return;
  }
  writeFileSync(filePath, raw.replace(/^version = "[^"]*"/mu, `version = "${opts.version}"`));
}

function stampCargoLock(filePath: string, opts: Options, output: Finding[]): void {
  const raw = readFileSync(filePath, "utf8");
  // Update the version inside the [[package]] block whose name is runx-cli.
  const block = /(name = "runx-cli"\r?\nversion = ")([^"]*)(")/u;
  const match = raw.match(block);
  if (!match) {
    output.push({ file: relative(filePath), message: "could not find the runx-cli lock entry" });
    return;
  }
  if (opts.check) {
    if (match[2] !== opts.version) {
      output.push({ file: relative(filePath), message: `runx-cli lock version is ${match[2]}, expected ${opts.version}` });
    }
    return;
  }
  writeFileSync(filePath, raw.replace(block, `$1${opts.version}$3`));
}

function parseArgs(argv: readonly string[]): Options {
  let version = "";
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--version") {
      version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx scripts/release-version.ts --version X.Y.Z [--check]");
      process.exit(0);
    }
    if (!version && !arg.startsWith("--")) {
      // Allow a bare positional version for convenience (e.g. from a tag).
      version = arg;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  // Tolerate a leading cli-v / v prefix so the raw tag can be passed through.
  version = version.replace(/^(?:cli-)?v/u, "");
  if (!SEMVER.test(version)) {
    throw new Error(`--version must be semver (got "${version}")`);
  }
  return { version, check };
}

function relative(filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

function emit(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

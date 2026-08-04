import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly message: string;
}

interface Options {
  readonly candidate: string;
  readonly noLegacyShapes: boolean;
  readonly noJsFallback: boolean;
}

const forbiddenJsFallbackTokens = [
  "RUNX_JS_BIN",
  "RUNX_NPM_PACKAGE",
  "RUNX_RUST_CLI",
  "RUNX_RUST_HARNESS",
  "npm exec",
  "DEFAULT_NPM_PACKAGE",
  "packages/cli/bin/runx.js",
] as const;

const forbiddenLegacyShapeTokens = [
  retiredExecutionShape("skill"),
  retiredExecutionShape("graph"),
  "pre_spine",
  "legacy_receipt",
  "compat_receipt",
] as const;

const findings: Finding[] = [];
const options = parseArgs(process.argv.slice(2));
const candidate = resolveCandidatePath(options.candidate);

inspectCandidateFile(candidate, findings);

if (options.noJsFallback) {
  inspectBinaryTokens(candidate, forbiddenJsFallbackTokens, "js_fallback_token", findings);
  assertShimFlagsGone(candidate, findings);
}

if (options.noLegacyShapes) {
  inspectBinaryTokens(candidate, forbiddenLegacyShapeTokens, "legacy_shape_token", findings);
}

emit({
  status: findings.length === 0 ? "passed" : "blocked",
  candidate: displayPath(candidate),
  checks: {
    no_legacy_shapes: options.noLegacyShapes,
    no_js_fallback: options.noJsFallback,
  },
  findings,
});

process.exit(findings.length === 0 ? 0 : 1);

function retiredExecutionShape(prefix: string): string {
  return `${prefix}_${"execution"}`;
}

function parseArgs(argv: readonly string[]): Options {
  let candidate = "";
  let noLegacyShapes = false;
  let noJsFallback = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate") {
      candidate = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--no-legacy-shapes") {
      noLegacyShapes = true;
      continue;
    }
    if (arg === "--no-js-fallback") {
      noJsFallback = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!candidate) {
    throw new Error("missing --candidate <path>");
  }

  return { candidate, noLegacyShapes, noJsFallback };
}

function inspectCandidateFile(candidatePath: string, output: Finding[]): void {
  try {
    const entry = statSync(candidatePath);
    if (!entry.isFile()) {
      output.push(finding("candidate_not_file", candidatePath, "candidate must be a native executable file"));
      return;
    }
    if (process.platform !== "win32" && (entry.mode & 0o111) === 0) {
      output.push(finding("candidate_not_executable", candidatePath, "candidate is not executable"));
    }
  } catch (error) {
    output.push(finding("candidate_missing", candidatePath, errorMessage(error)));
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

function inspectBinaryTokens(
  candidatePath: string,
  tokens: readonly string[],
  rule: string,
  output: Finding[],
): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(candidatePath);
  } catch (error) {
    output.push(finding("candidate_unreadable", candidatePath, errorMessage(error)));
    return;
  }

  for (const token of tokens) {
    if (bytes.includes(Buffer.from(token))) {
      output.push(finding(rule, candidatePath, `candidate binary contains forbidden token ${token}`));
    }
  }
}

function assertShimFlagsGone(candidatePath: string, output: Finding[]): void {
  const runxHome = mkdtempSync(path.join(os.tmpdir(), "runx-cutover-check-"));
  try {
    for (const flag of ["--shim-help", "--shim-version"]) {
      const result = spawnSync(candidatePath, [flag], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 5_000,
        env: cutoverEnv(runxHome),
        maxBuffer: 1024 * 1024,
      });
      if (result.error) {
        output.push(finding("candidate_execution_error", candidatePath, `${flag}: ${result.error.message}`));
        continue;
      }
      if (result.status === 0) {
        output.push(finding("launcher_shim_flag", candidatePath, `${flag} is still accepted in the release candidate`));
      }
    }
  } finally {
    rmSync(runxHome, { recursive: true, force: true });
  }
}

function cutoverEnv(runxHome: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.RUNX_JS_BIN;
  delete env.RUNX_NPM_PACKAGE;
  delete env.RUNX_RUST_CLI;
  delete env.RUNX_RUST_HARNESS;
  env.RUNX_HOME = runxHome;
  return env;
}

function finding(rule: string, filePath: string, message: string): Finding {
  return {
    rule,
    file: displayPath(filePath),
    message,
  };
}

function displayPath(filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : filePath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printUsage(): void {
  console.log("Usage: pnpm exec tsx scripts/check-rust-cli-cutover.ts --candidate <path> [--no-legacy-shapes] [--no-js-fallback]");
}

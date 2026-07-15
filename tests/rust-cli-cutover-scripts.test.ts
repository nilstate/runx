import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
// Spawn the tsx binary directly: routing through `pnpm exec` adds ~0.5-1s of
// launcher overhead to every invocation.
const tsx = path.join(
  workspaceRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

describe("Rust CLI cutover scripts", () => {
  it("keeps the published native selector on unconditional digest verification", async () => {
    const selector = await readFile(path.join(workspaceRoot, "packages", "cli", "bin", "runx"), "utf8");

    expect(selector).not.toContain("RUNX_SKIP_NATIVE_VERIFY");
    expect(selector).not.toContain("native-verify-");
    expect(selector).toContain("createHash(\"sha256\").update(readFileSync(binaryPath)).digest(\"hex\")");
  });

  it("accepts clean cutover candidates and blocks launcher shim flags", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cutover-script-candidate-"));

    try {
      const clean = path.join(tempDir, executableName());
      const shim = path.join(tempDir, executableName("shim"));
      await writeExecutable(clean, exitScript(64));
      await writeExecutable(shim, shimAcceptingScript());

      const cleanResult = runTsx("scripts/check-rust-cli-cutover.ts", [
        "--candidate",
        clean,
        "--no-legacy-shapes",
        "--no-v2",
        "--no-aliases",
        "--no-js-fallback",
      ]);
      expect(cleanResult.status).toBe(0);
      expect(JSON.parse(cleanResult.stdout)).toMatchObject({
        status: "passed",
        findings: [],
      });

      const shimResult = runTsx("scripts/check-rust-cli-cutover.ts", [
        "--candidate",
        shim,
        "--no-js-fallback",
      ]);
      expect(shimResult.status).toBe(1);
      const payload = JSON.parse(shimResult.stdout) as { readonly findings: readonly { readonly rule: string }[] };
      expect(payload.findings.map((finding) => finding.rule)).toContain("launcher_shim_flag");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("packages native CLI artifacts with checksum and signature metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-rust-cli-package-test-"));

    try {
      const binary = path.join(tempDir, executableName());
      const outDir = path.join(tempDir, "artifacts");
      const signatureManifest = path.join(tempDir, "signatures.json");
      await writeExecutable(binary, exitScript(64));
      await writeFile(signatureManifest, `${JSON.stringify(await fixtureSignatureManifest(binary), null, 2)}\n`, "utf8");

      const packageResult = runTsx("scripts/package-rust-cli.ts", [
        "--binary",
        binary,
        "--out-dir",
        outDir,
        "--signature-manifest",
        signatureManifest,
      ]);
      expect(packageResult.status).toBe(0);
      expect(JSON.parse(packageResult.stdout)).toMatchObject({
        status: "passed",
        mode: "write",
        selector_package: "@runxhq/cli",
        native_package: nativePackageName(platformKey(process.platform, process.arch)),
        signature_manifest: "native/signatures.json",
      });

      const packageDir = path.join(outDir, platformKey(process.platform, process.arch));
      const selectorDir = path.join(outDir, "selector");
      const checkResult = runTsx("scripts/check-rust-cli-release-artifacts.ts", [
        "--artifact-dir",
        outDir,
        "--no-js-delegation",
        "--verify-signatures",
      ]);
      expect(checkResult.status).toBe(0);
      expect(JSON.parse(checkResult.stdout)).toMatchObject({
        status: "passed",
        findings: [],
      });
      await expect(readFile(path.join(packageDir, "native", "signatures.json"), "utf8")).resolves.toContain(
        "runx.rust_cli_artifact_signatures.v1",
      );
      await expect(readFile(path.join(packageDir, "package.json"), "utf8")).resolves.toContain(
        `"name": "${nativePackageName(platformKey(process.platform, process.arch))}"`,
      );
      const nativeManifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as {
        readonly bin?: unknown;
      };
      expect(nativeManifest).not.toHaveProperty("bin");
      const selectorManifest = JSON.parse(await readFile(path.join(selectorDir, "package.json"), "utf8")) as {
        readonly version: string;
        readonly optionalDependencies?: Record<string, string>;
      };
      expect(selectorManifest.optionalDependencies?.["@runxhq/cli-linux-x64"]).toBe(selectorManifest.version);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts multi-platform selector artifacts through release dry-run publish", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-rust-cli-release-multi-"));

    try {
      const currentPlatform = platformKey(process.platform, process.arch);
      const otherPlatform = alternatePlatform(currentPlatform);
      const currentBinary = path.join(tempDir, executableName("runx-current"));
      const otherBinary = path.join(tempDir, executableName("runx-other"));
      const currentSignature = path.join(tempDir, "current-signatures.json");
      const otherSignature = path.join(tempDir, "other-signatures.json");
      const outDir = path.join(tempDir, "artifacts");

      await writeExecutable(currentBinary, exitScript(64));
      await writeExecutable(otherBinary, exitScript(64));
      await writeFile(
        currentSignature,
        `${JSON.stringify(await fixtureSignatureManifest(currentBinary, currentPlatform), null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        otherSignature,
        `${JSON.stringify(await fixtureSignatureManifest(otherBinary, otherPlatform), null, 2)}\n`,
        "utf8",
      );

      const otherPackage = runTsx("scripts/package-rust-cli.ts", [
        "--binary",
        otherBinary,
        "--out-dir",
        outDir,
        "--platform",
        otherPlatform,
        "--signature-manifest",
        otherSignature,
      ]);
      expect(otherPackage.status).toBe(0);

      const result = runTsx("scripts/release-rust-cli.ts", [
        "--binary",
        currentBinary,
        "--artifact-dir",
        outDir,
        "--platform",
        currentPlatform,
        "--signature-manifest",
        currentSignature,
        "--publish",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"status": "dry_run_published"');

      const checkResult = runTsx("scripts/check-rust-cli-release-artifacts.ts", [
        "--artifact-dir",
        outDir,
        "--no-js-delegation",
        "--verify-signatures",
      ]);
      expect(checkResult.status).toBe(0);
      const targets = await Promise.all([
        readFile(path.join(outDir, "selector", "package.json"), "utf8"),
        readFile(path.join(outDir, currentPlatform, "package.json"), "utf8"),
        readFile(path.join(outDir, otherPlatform, "package.json"), "utf8"),
      ]);
      expect(targets.join("\n")).toContain(`"name": "${nativePackageName(currentPlatform)}"`);
      expect(targets.join("\n")).toContain(`"name": "${nativePackageName(otherPlatform)}"`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails closed for empty and malformed release artifact directories", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-rust-cli-artifact-check-"));

    try {
      const emptyDir = path.join(tempDir, "empty");
      const malformedDir = path.join(tempDir, "malformed");
      await mkdir(emptyDir);
      await mkdir(malformedDir);
      await writeFile(path.join(malformedDir, "package.json"), "{bad json", "utf8");

      const emptyResult = runTsx("scripts/check-rust-cli-release-artifacts.ts", ["--artifact-dir", emptyDir]);
      expect(emptyResult.status).toBe(1);
      expect(ruleIds(JSON.parse(emptyResult.stdout))).toEqual(["artifact_package_missing"]);

      const malformedResult = runTsx("scripts/check-rust-cli-release-artifacts.ts", ["--artifact-dir", malformedDir]);
      expect(malformedResult.status).toBe(1);
      expect(ruleIds(JSON.parse(malformedResult.stdout))).toEqual(["package_manifest_malformed"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires signatures before release preparation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-rust-cli-release-test-"));

    try {
      const binary = path.join(tempDir, executableName());
      await writeExecutable(binary, exitScript(64));

      const result = runTsx("scripts/release-rust-cli.ts", [
        "--binary",
        binary,
        "--artifact-dir",
        path.join(tempDir, "artifacts"),
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--signature-manifest is required");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prepares signed release artifacts without publishing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-rust-cli-release-prep-"));

    try {
      const binary = path.join(tempDir, executableName());
      const signatureManifest = path.join(tempDir, "signatures.json");
      await writeExecutable(binary, exitScript(64));
      await writeFile(signatureManifest, `${JSON.stringify(await fixtureSignatureManifest(binary), null, 2)}\n`, "utf8");

      const result = runTsx("scripts/release-rust-cli.ts", [
        "--binary",
        binary,
        "--artifact-dir",
        path.join(tempDir, "artifacts"),
        "--signature-manifest",
        signatureManifest,
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"status": "prepared"');
      expect(result.stdout).toContain('"publish": false');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function runTsx(script: string, args: readonly string[]) {
  return spawnSync(tsx, [script, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function ruleIds(payload: { readonly findings: readonly { readonly rule: string }[] }): readonly string[] {
  return payload.findings.map((finding) => finding.rule);
}

async function fixtureSignatureManifest(binaryPath: string, platform = platformKey(process.platform, process.arch)): Promise<unknown> {
  const manifest = JSON.parse(await readFile(path.join(workspaceRoot, "packages", "cli", "package.json"), "utf8")) as {
    readonly name: string;
    readonly version: string;
  };
  return {
    schema: "runx.rust_cli_artifact_signatures.v1",
    package: `${manifest.name}-${platform}`,
    version: manifest.version,
    platform,
    binary: platform.startsWith("win32-") ? "bin/runx.exe" : "bin/runx",
    sha256: sha256(await readFile(binaryPath)),
    signatures: [
      {
        kind: "fixture",
        value: "fixture-signature",
      },
    ],
  };
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
}

function executableName(prefix = "runx"): string {
  return process.platform === "win32" ? `${prefix}.cmd` : prefix;
}

function exitScript(code: number): string {
  if (process.platform === "win32") {
    return `@echo off\r\nexit /b ${code}\r\n`;
  }
  return `#!/bin/sh\nexit ${code}\n`;
}

function shimAcceptingScript(): string {
  if (process.platform === "win32") {
    return '@echo off\r\nif "%1"=="--shim-help" exit /b 0\r\nexit /b 64\r\n';
  }
  return '#!/bin/sh\nif [ "$1" = "--shim-help" ]; then exit 0; fi\nexit 64\n';
}

function platformKey(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  throw new Error(`unsupported Rust CLI package platform: ${platform}/${arch}`);
}

function alternatePlatform(platform: string): string {
  return platform === "linux-x64" ? "darwin-arm64" : "linux-x64";
}

function nativePackageName(platform: string): string {
  return `@runxhq/cli-${platform}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

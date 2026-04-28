import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "@runxhq/core/util";

export const cliPackageName = "@runxhq/cli";

interface CliPackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface CliPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly packageRoot: string;
}

export function readCliPackageMetadata(): CliPackageMetadata {
  const packageRoot = resolveCliPackageRoot();
  const raw = readCliPackageManifest(packageRoot);
  const name = normalizePackageName(raw.name);
  const version = normalizePackageVersion(raw.version);
  return {
    name,
    version,
    packageRoot,
  };
}

export function resolveCliPackageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return findCliPackageRoot(moduleDir);
}

export function readCliDependencyVersion(packageName: string): string {
  const packageRoot = resolveCliPackageRoot();
  const raw = readCliPackageManifest(packageRoot);
  const declaredVersion = raw.dependencies?.[packageName]
    ?? raw.devDependencies?.[packageName]
    ?? raw.optionalDependencies?.[packageName]
    ?? raw.peerDependencies?.[packageName];
  return normalizeDependencyVersion(packageName, declaredVersion);
}

function findCliPackageRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      const raw = parseManifest(manifestPath);
      if (raw && raw.name === cliPackageName) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve ${cliPackageName} package root from ${startDir}.`);
    }
    current = parent;
  }
}

function readCliPackageManifest(packageRoot: string): CliPackageManifest {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const manifest = parseManifest(packageJsonPath);
  if (!manifest) {
    throw new Error(`${packageJsonPath} must contain a JSON object.`);
  }
  return manifest;
}

function parseManifest(packageJsonPath: string): CliPackageManifest | undefined {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return isRecord(parsed) ? (parsed as CliPackageManifest) : undefined;
}

function normalizePackageName(value: string | undefined): string {
  if (value !== cliPackageName) {
    throw new Error(`Expected ${cliPackageName} package name, received ${value ?? "undefined"}.`);
  }
  return value;
}

function normalizePackageVersion(value: string | undefined): string {
  if (!value || value === "0.0.0") {
    throw new Error(`Expected ${cliPackageName} to have a publishable version, received ${value ?? "undefined"}.`);
  }
  return value;
}

function normalizeDependencyVersion(packageName: string, value: string | undefined): string {
  const match = value?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  if (!match) {
    throw new Error(`Expected ${cliPackageName} dependency ${packageName} to declare a publishable version, received ${value ?? "undefined"}.`);
  }
  return match[0];
}

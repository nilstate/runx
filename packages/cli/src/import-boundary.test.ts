import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const packagesRoot = path.join(workspaceRoot, "packages");
const FORBIDDEN_PACKAGE_NAMES = [
  "@runxhq/core",
  "@runxhq/adapters",
  "@runxhq/runtime-local",
] as const;

const ALLOWED_FORBIDDEN_IMPORTERS = new Map<string, readonly string[]>();

describe("published package import boundary", () => {
  it("keeps deleted legacy packages out of published package sources", async () => {
    const importers = await collectForbiddenPackageImporters();

    expect(importers).toEqual(ALLOWED_FORBIDDEN_IMPORTERS);
  });
});

async function collectForbiddenPackageImporters(): Promise<Map<string, readonly string[]>> {
  const importers = new Map<string, readonly string[]>();
  for (const sourceRoot of await listPublishedPackageSourceRoots()) {
    for (const filePath of await listTypeScriptFiles(sourceRoot)) {
      const contents = await readFile(filePath, "utf8");
      const imports = extractForbiddenPackageImportSpecifiers(contents);
      if (imports.length === 0) {
        continue;
      }
      importers.set(toProjectPath(filePath), imports);
    }
  }
  return new Map([...importers].sort(([left], [right]) => left.localeCompare(right)));
}

async function listPublishedPackageSourceRoots(): Promise<readonly string[]> {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const sourceRoots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageJson = await readPackageJson(path.join(packageRoot, "package.json"));
    if (!packageJson || packageJson.private === true) {
      continue;
    }
    const sourceRoot = path.join(packageRoot, "src");
    if (await isDirectory(sourceRoot)) {
      sourceRoots.push(sourceRoot);
    }
  }
  return sourceRoots.sort((left, right) => left.localeCompare(right));
}

async function listTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function extractForbiddenPackageImportSpecifiers(contents: string): readonly string[] {
  const imports = new Set<string>();
  for (const pattern of [
    /\bfrom\s+["']([^"'`]+)["']/gm,
    /^\s*import\s+(?:type\s+)?["']([^"'`]+)["'];?/gm,
    /\bimport\s*\(\s*["']([^"'`]+)["']\s*\)/gm,
    /\brequire\s*\(\s*["']([^"'`]+)["']\s*\)/gm,
  ]) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (FORBIDDEN_PACKAGE_NAMES.some((packageName) =>
        specifier === packageName || specifier.startsWith(`${packageName}/`)
      )) {
        imports.add(specifier);
      }
    }
  }
  return [...imports].sort((left, right) => left.localeCompare(right));
}

function toProjectPath(filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

async function readPackageJson(filePath: string): Promise<{ readonly private?: boolean } | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as { readonly private?: boolean };
  } catch {
    return undefined;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    await readdir(directory);
    return true;
  } catch {
    return false;
  }
}

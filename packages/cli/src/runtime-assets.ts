import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pathExists } from "@runxhq/core/util";

const CLI_PACKAGE_NAME = "@runxhq/cli";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

let bundledVoiceProfilePathPromise: Promise<string | undefined> | undefined;
let bundledToolRootsPromise: Promise<readonly string[]> | undefined;

export async function resolveBundledCliVoiceProfilePath(): Promise<string | undefined> {
  bundledVoiceProfilePathPromise ??= findBundledCliVoiceProfilePath();
  return await bundledVoiceProfilePathPromise;
}

export async function resolveBundledCliToolRoots(): Promise<readonly string[]> {
  bundledToolRootsPromise ??= findBundledCliToolRoots();
  return await bundledToolRootsPromise;
}

async function findBundledCliVoiceProfilePath(): Promise<string | undefined> {
  const packageRoot = await findPackageRoot(moduleDirectory);
  if (!packageRoot) {
    return undefined;
  }
  const candidates = [
    path.join(packageRoot, "skills", "VOICE.md"),
    path.resolve(packageRoot, "../../skills/VOICE.md"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function findBundledCliToolRoots(): Promise<readonly string[]> {
  const packageRoot = await findPackageRoot(moduleDirectory);
  if (!packageRoot) {
    return [];
  }
  const candidates = [
    path.join(packageRoot, "tools"),
    path.join(packageRoot, "dist", "tools"),
  ];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved) && await pathExists(resolved)) {
      roots.push(resolved);
      seen.add(resolved);
    }
  }
  return roots;
}

async function findPackageRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (await pathExists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { readonly name?: string };
        if (packageJson.name === CLI_PACKAGE_NAME) {
          return current;
        }
      } catch {
        // Ignore invalid package.json files while walking upward.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

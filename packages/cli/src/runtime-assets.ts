import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_NAME = "@runxhq/cli";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

let bundledVoiceProfilePathPromise: Promise<string | undefined> | undefined;

export async function resolveBundledCliVoiceProfilePath(): Promise<string | undefined> {
  bundledVoiceProfilePathPromise ??= findBundledCliVoiceProfilePath();
  return await bundledVoiceProfilePathPromise;
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

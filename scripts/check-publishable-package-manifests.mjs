import path from "node:path";

import { readPackageManifest, readWorkspacePackageVersions, resolveWorkspacePackageDir, rewriteManifestForPublish } from "./public-package-utils.mjs";

const packageNames = [
  "adapters",
  "authoring",
  "cli",
  "contracts",
  "core",
  "create-skill",
  "runtime-local",
];
const dependencySections = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const versions = await readWorkspacePackageVersions();

for (const packageName of packageNames) {
  const packageDir = resolveWorkspacePackageDir(packageName);
  const manifest = rewriteManifestForPublish(await readPackageManifest(packageDir), versions);
  if (manifest.private === true) {
    continue;
  }
  for (const sectionName of dependencySections) {
    const section = manifest[sectionName];
    if (!section || typeof section !== "object") {
      continue;
    }
    for (const [dependencyName, spec] of Object.entries(section)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        throw new Error(`${path.basename(packageDir)} ${sectionName}.${dependencyName} still rewrites to ${spec}.`);
      }
    }
  }
}

import { spawn } from "node:child_process";

import { cleanupPreparedPublicPackage, npm, preparePublicPackageForPublish, resolveWorkspacePackageDir } from "./public-package-utils.mjs";

const args = process.argv.slice(2);
const target = args[0];

if (!target) {
  throw new Error("Usage: node scripts/publish-public-package.mjs <package-dir|package-name> [npm publish args...]");
}

const packageDir = resolveWorkspacePackageDir(target);
const publishArgs = args.slice(1);
const prepared = await preparePublicPackageForPublish(packageDir);

try {
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ["publish", ...publishArgs], {
      cwd: prepared.publishDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`npm publish exited with ${code}`));
      }
    });
  });
} finally {
  await cleanupPreparedPublicPackage(prepared);
}

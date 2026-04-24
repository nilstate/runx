import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const commands = [
  ["pnpm", ["typecheck"]],
  ["node", ["scripts/check-publishable-package-manifests.mjs"]],
  ["node", ["scripts/check-authoring-package-contract.mjs"]],
  ["node", ["scripts/check-create-skill-package-contract.mjs"]],
  ["pnpm", ["exec", "tsx", "packages/cli/src/index.ts", "doctor", "--json"]],
  ["pnpm", ["test:fast"]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

import { execFileSync } from "node:child_process";
import { mkdir, lstat, readlink, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPackageDir = path.join(workspaceRoot, "packages", "cli");
const globalPrefix = execFileSync("npm", ["prefix", "-g"], {
  cwd: workspaceRoot,
  encoding: "utf8",
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_") && !key.startsWith("npm_package_")),
  ),
}).trim();

if (!path.isAbsolute(globalPrefix)) {
  throw new Error(`npm prefix -g returned a non-absolute path: ${globalPrefix}`);
}

if (globalPrefix === workspaceRoot || globalPrefix.startsWith(`${workspaceRoot}${path.sep}`)) {
  throw new Error(
    `refusing to link into workspace-local prefix ${globalPrefix}; check your global npm prefix configuration`,
  );
}

const globalBinDir = path.join(globalPrefix, "bin");
const globalNodeModulesDir = path.join(globalPrefix, "lib", "node_modules");
const globalScopeDir = path.join(globalNodeModulesDir, "@runxhq");
const globalPackageLink = path.join(globalScopeDir, "cli");
const globalBinLink = path.join(globalBinDir, "runx");
const binLinkTarget = "../lib/node_modules/@runxhq/cli/bin/runx.js";

const mode = process.argv.includes("--unlink")
  ? "unlink"
  : process.argv.includes("--check")
    ? "check"
    : "link";

if (mode === "unlink") {
  await unlinkGlobal();
  process.exit(0);
}

if (mode === "check") {
  await checkGlobal();
  process.exit(0);
}

await linkGlobal();

async function linkGlobal() {
  await mkdir(globalBinDir, { recursive: true });
  await mkdir(globalScopeDir, { recursive: true });

  await replacePath(globalPackageLink, cliPackageDir, "dir");
  await replacePath(globalBinLink, binLinkTarget, "file");

  const resolvedPackage = await realpath(globalPackageLink);
  const resolvedBin = await realpath(globalBinLink);

  process.stdout.write(
    [
      "runx global link updated",
      `prefix   ${globalPrefix}`,
      `package  ${globalPackageLink} -> ${resolvedPackage}`,
      `binary   ${globalBinLink} -> ${resolvedBin}`,
      "",
      "This is a live workspace link. Rebuild with `pnpm --dir oss build` and the same global `runx` will pick up the current dist.",
    ].join("\n") + "\n",
  );
}

async function unlinkGlobal() {
  await rm(globalBinLink, { force: true });
  await rm(globalPackageLink, { recursive: true, force: true });
  process.stdout.write(
    [
      "runx global link removed",
      `binary   ${globalBinLink}`,
      `package  ${globalPackageLink}`,
    ].join("\n") + "\n",
  );
}

async function checkGlobal() {
  const packageState = await describeLink(globalPackageLink);
  const binState = await describeLink(globalBinLink);

  process.stdout.write(
    [
      "runx global link status",
      `prefix   ${globalPrefix}`,
      `package  ${packageState}`,
      `binary   ${binState}`,
    ].join("\n") + "\n",
  );
}

async function describeLink(filePath) {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(filePath);
      const resolved = await realpath(filePath);
      return `${filePath} -> ${target} (${resolved})`;
    }
    return `${filePath} exists but is not a symlink`;
  } catch {
    return `${filePath} missing`;
  }
}

async function replacePath(filePath, target, symlinkType) {
  await rm(filePath, { recursive: true, force: true });
  await symlink(target, filePath, symlinkType);
}

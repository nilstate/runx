import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPackageRoot = path.join(workspaceRoot, "packages", "cli");
const cliDistEntry = path.join(cliPackageRoot, "dist", "index.js");
const cliBinEntry = path.join(cliPackageRoot, "bin", "runx.js");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const entry = await stat(cliDistEntry);
if (!entry.isFile() || (entry.mode & 0o111) === 0) {
  throw new Error(`CLI dist entry is missing or not executable: ${cliDistEntry}`);
}
const entrySource = await readFile(cliDistEntry, "utf8");
if (entrySource.includes(".build/runtime")) {
  throw new Error("CLI dist entry still points at .build/runtime instead of the packaged dist tree.");
}

const bin = await stat(cliBinEntry);
if (!bin.isFile() || (bin.mode & 0o111) === 0) {
  throw new Error(`CLI bin entry is missing or not executable: ${cliBinEntry}`);
}

const configList = await execFileAsync(process.execPath, [cliBinEntry, "config", "list", "--json"], {
  cwd: workspaceRoot,
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
});
const configListReport = JSON.parse(configList.stdout);
if (configListReport?.status !== "success" || configListReport?.config?.action !== "list") {
  throw new Error("CLI bin entry did not execute a structural JSON command successfully.");
}

const pack = await execFileAsync(npm, ["pack", "--dry-run", "--json"], {
  cwd: cliPackageRoot,
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
});
const [report] = JSON.parse(pack.stdout);
const files = new Set(report.files.map((file) => file.path));
for (const required of [
  "bin/runx.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/packages/cli/src/index.js",
  "dist/packages/cli/src/official-skills.lock.json",
  "dist/packages/runner-local/src/index.js",
  "skills/scafld/run.mjs",
  "tools/sourcey/build/tool.yaml",
  "tools/sourcey/build/run.mjs",
  "tools/sourcey/verify/tool.yaml",
]) {
  if (!files.has(required)) {
    throw new Error(`CLI package is missing ${required}`);
  }
}
for (const forbidden of [
  "skills/evolve/SKILL.md",
  "bindings/runx/evolve/X.yaml",
  "skills/sourcey/SKILL.md",
  "bindings/runx/sourcey/X.yaml",
]) {
  if (files.has(forbidden)) {
    throw new Error(`CLI package unexpectedly ships ${forbidden}`);
  }
}

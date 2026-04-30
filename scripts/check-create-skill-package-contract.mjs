import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = path.join(workspaceRoot, "packages", "create-skill");
const distEntry = path.join(packageRoot, "dist", "index.js");
const binEntry = path.join(packageRoot, "bin", "create-skill.js");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const dist = await stat(distEntry);
if (!dist.isFile()) {
  throw new Error(`create-skill dist entry is missing: ${distEntry}`);
}
const distSource = await readFile(distEntry, "utf8");
if (distSource.includes(".build/runtime")) {
  throw new Error("create-skill dist entry still points at .build/runtime instead of the packaged dist tree.");
}

const bin = await stat(binEntry);
if (!bin.isFile() || (bin.mode & 0o111) === 0) {
  throw new Error(`create-skill bin entry is missing or not executable: ${binEntry}`);
}

const pack = await execFileAsync(npm, ["pack", "--dry-run", "--json"], {
  cwd: packageRoot,
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
});
const [report] = JSON.parse(pack.stdout);
const files = new Set(report.files.map((file) => file.path));
for (const required of [
  "README.md",
  "bin/create-skill.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/src/index.js",
  "dist/src/index.d.ts",
]) {
  if (!files.has(required)) {
    throw new Error(`create-skill package is missing ${required}`);
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runx-create-skill-"));
try {
  const targetDir = path.join(tempRoot, "demo-skill");
  await execFileAsync(process.execPath, [binEntry, "demo-skill", "--directory", targetDir], {
    cwd: workspaceRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      RUNX_CWD: tempRoot,
    },
  });
  for (const required of [
    "SKILL.md",
    "X.yaml",
    ".github/workflows/publish.yml",
    "tools/docs/echo/src/index.ts",
  ]) {
    const requiredPath = path.join(targetDir, required);
    const entry = await statIfExists(requiredPath);
    if (!entry?.isFile()) {
      throw new Error(`create-skill smoke run did not produce ${required}`);
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function statIfExists(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

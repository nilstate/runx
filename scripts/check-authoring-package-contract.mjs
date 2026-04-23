import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const authoringPackageRoot = path.join(workspaceRoot, "packages", "authoring");
const distEntry = path.join(authoringPackageRoot, "dist", "index.js");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const entry = await stat(distEntry);
if (!entry.isFile()) {
  throw new Error(`Authoring dist entry is missing: ${distEntry}`);
}
const entrySource = await readFile(distEntry, "utf8");
if (entrySource.includes(".build/runtime")) {
  throw new Error("Authoring dist entry still points at .build/runtime instead of the packaged dist tree.");
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runx-authoring-pack-"));
let tarballPath;

try {
  const pack = await execFileAsync(npm, ["pack", "--json"], {
    cwd: authoringPackageRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const [report] = JSON.parse(pack.stdout);
  if (!report?.filename) {
    throw new Error("npm pack did not report a tarball filename.");
  }

  const files = new Set(report.files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "package.json",
  ]) {
    if (!files.has(required)) {
      throw new Error(`Authoring package is missing ${required}`);
    }
  }

  tarballPath = path.join(authoringPackageRoot, report.filename);

  await execFileAsync(npm, ["init", "-y"], {
    cwd: tempRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  await execFileAsync(npm, ["install", tarballPath], {
    cwd: tempRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const smoke = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { defineTool, stringInput } from "@runxhq/authoring";'
        + 'const tool = defineTool({ name: "demo.echo", inputs: { value: stringInput() }, run: ({ inputs }) => ({ value: inputs.value }) });'
        + 'const output = await tool.runWith({ value: "ok" });'
        + 'process.stdout.write(JSON.stringify(output));',
    ],
    {
      cwd: tempRoot,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (smoke.stdout.trim() !== '{"value":"ok"}') {
    throw new Error(`Authoring tarball smoke test returned unexpected output: ${smoke.stdout.trim()}`);
  }
} finally {
  if (tarballPath) {
    await rm(tarballPath, { force: true });
  }
  await rm(tempRoot, { recursive: true, force: true });
}

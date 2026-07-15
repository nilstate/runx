import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = path.join(workspaceRoot, "packages");
const packageSearchRoots = [packageRoot, path.join(workspaceRoot, "plugins")];
const runtimeOutDir = path.join(workspaceRoot, ".build", "runtime");
const tscPath = require.resolve("typescript/bin/tsc");

const mode = process.argv.includes("--pack") ? "pack" : "dev";

await runTscBuild(["-b", "tsconfig.runtime.json"]);

const packageDirs = (await Promise.all(packageSearchRoots.map(findPackageDirs))).flat();
let forcedRuntimeRebuild = false;
for (const directory of packageDirs) {
  await finalizePackage(directory);
}

async function findPackageDirs(root) {
  const directories = [];
  if (!(await exists(root))) {
    return directories;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = path.join(root, entry.name);
    if (await exists(path.join(candidate, "package.json"))) {
      directories.push(candidate);
      continue;
    }

    for (const nested of await readdir(candidate, { withFileTypes: true })) {
      if (!nested.isDirectory()) {
        continue;
      }
      const nestedCandidate = path.join(candidate, nested.name);
      if (await exists(path.join(nestedCandidate, "package.json"))) {
        directories.push(nestedCandidate);
      }
    }
  }
  return directories.sort();
}

async function finalizePackage(directory) {
  const entry = path.join(directory, "src", "index.ts");
  if (!(await exists(entry))) {
    return;
  }

  const packageJson = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const workspaceRelativePath = toPosix(path.relative(workspaceRoot, directory));
  const runtimeEntry = path.join(runtimeOutDir, workspaceRelativePath, "src", "index.js");
  const runtimePackageRoot = path.join(runtimeOutDir, workspaceRelativePath);

  if (!(await exists(runtimeEntry))) {
    if (!forcedRuntimeRebuild) {
      forcedRuntimeRebuild = true;
      await runTscBuild(["-b", "--force", "tsconfig.runtime.json"]);
    }
  }

  if (!(await exists(runtimeEntry))) {
    throw new Error(`No compiled runtime entry found for ${directory}`);
  }

  const dist = path.join(directory, "dist");
  const isExecutable = Boolean(packageJson.bin?.runx);

  if (mode === "pack") {
    await writePackDist({
      directory,
      dist,
      compiledPackageRoot: runtimePackageRoot,
      compiledEntry: path.join(dist, "src", "index.js"),
      executable: isExecutable,
    });
    return;
  }

  // Dev mode must also refresh dist/src because workspace consumers import
  // package subpath exports (for example @runxhq/cli/metadata) directly from
  // dist/src. Leaving those stale causes cross-workspace drift.
  await writeDevDist({
    directory,
    dist,
    compiledPackageRoot: runtimePackageRoot,
    compiledEntry: path.join(dist, "src", "index.js"),
    executable: isExecutable,
  });
}

async function writeDevDist({ directory, dist, compiledPackageRoot, compiledEntry, executable }) {
  await buildDistAtomically({
    dist,
    populate: async (staging) => {
      const stagingEntry = path.join(staging, path.relative(dist, compiledEntry));
      await copyIntoDist(compiledPackageRoot, staging);
      await stripSourceMaps(staging);
      await writeEntryWrapper({
        dist: staging,
        compiledEntry: stagingEntry,
        executable,
      });
      if (executable) {
        await chmod(path.join(staging, "index.js"), 0o755);
      }
    },
  });
}

async function writePackDist({ directory, dist, compiledPackageRoot, compiledEntry, executable }) {
  // Publish mode: produce package-local dist trees that can be packed
  // without .build/runtime and without bundling sibling packages.
  await buildDistAtomically({
    dist,
    populate: async (staging) => {
      const stagingEntry = path.join(staging, path.relative(dist, compiledEntry));
      await copyIntoDist(compiledPackageRoot, staging);
      await stripSourceMaps(staging);
      await writeEntryWrapper({
        dist: staging,
        compiledEntry: stagingEntry,
        executable,
      });
      if (executable) {
        await chmod(path.join(staging, "index.js"), 0o755);
      }
    },
  });
}

/**
 * Populate `dist` via a staging directory then atomic-rename it into place,
 * so concurrent readers (e.g. test workers spawning child processes that
 * import compiled files) never observe a half-built dist tree.
 */
async function buildDistAtomically({ dist, populate }) {
  await replaceTreeAtomically(dist, async (staging) => {
    await mkdir(staging, { recursive: true });
    await populate(staging);
  });
}

async function writeEntryWrapper({ dist, compiledEntry, executable }) {
  const specifier = `./${toPosix(path.relative(dist, compiledEntry))}`;
  const js = executable
    ? `#!/usr/bin/env node
export * from ${JSON.stringify(specifier)};
import { realpathSync } from "node:fs";
import { stderr, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { runCli } from ${JSON.stringify(specifier)};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const exitCode = await runCli(process.argv.slice(2), { stdin, stdout, stderr });
  process.exitCode = exitCode;
}
`
    : `export * from ${JSON.stringify(specifier)};
`;
  await writeFile(path.join(dist, "index.js"), js, { mode: executable ? 0o755 : 0o644 });
  await writeFile(path.join(dist, "index.d.ts"), `export * from ${JSON.stringify(specifier)};\n`);
}

async function runTscBuild(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscPath, ...args], {
      cwd: workspaceRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tsc exited with ${code}`));
      }
    });
  });
}

async function copyIntoDist(source, target) {
  if (!(await exists(source))) {
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

/**
 * Populate `target` via a sibling staging directory then atomic-rename it
 * into place, so concurrent readers never observe the rm-then-cp window.
 */
async function replaceTreeAtomically(target, populate) {
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  const previous = `${target}.previous-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await populate(staging);
  } catch (error) {
    await bestEffortCleanup(rm(staging, { recursive: true, force: true }), `remove staging tree ${staging}`);
    throw error;
  }
  let renamedAway = false;
  try {
    await moveTree(target, previous);
    renamedAway = true;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      await bestEffortCleanup(rm(staging, { recursive: true, force: true }), `remove staging tree ${staging}`);
      throw error;
    }
  }
  try {
    await moveTree(staging, target);
  } catch (error) {
    if (renamedAway) {
      await bestEffortCleanup(moveTree(previous, target), `restore previous tree ${previous}`);
    }
    await bestEffortCleanup(rm(staging, { recursive: true, force: true }), `remove staging tree ${staging}`);
    throw error;
  }
  if (renamedAway) {
    await bestEffortCleanup(
      rm(previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      `remove previous tree ${previous}`,
    );
  }
}

async function moveTree(source, target) {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    if (!isErrorCode(error, "EXDEV")) {
      throw error;
    }
  }

  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await cp(source, target, { recursive: true });
  await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function bestEffortCleanup(operation, action) {
  try {
    await operation;
  } catch (error) {
    if (process.env.RUNX_BUILD_DEBUG_CLEANUP === "1") {
      process.stderr.write(`warning: failed to ${action}: ${errorMessage(error)}\n`);
    }
  }
}

async function stripSourceMaps(directory) {
  if (!(await exists(directory))) {
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await stripSourceMaps(entryPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js.map")) {
      await rm(entryPath, { force: true });
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      const source = await readFile(entryPath, "utf8");
      await writeFile(entryPath, source.replace(/\n\/\/# sourceMappingURL=.*\.js\.map\s*$/u, "\n"));
    }
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

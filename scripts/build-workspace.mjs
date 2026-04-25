import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const ts = require("typescript");

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
  const isCli = packageJson.name === "@runxhq/cli";
  const isExecutable = Boolean(packageJson.bin?.runx);

  if (mode === "pack") {
    await writePackDist({
      directory,
      dist,
      compiledPackageRoot: runtimePackageRoot,
      compiledEntry: path.join(dist, "src", "index.js"),
      executable: isExecutable,
      syncCliAssets: isCli,
    });
    return;
  }

  // Dev mode must also refresh dist/src because workspace consumers import
  // package subpath exports (for example @runxhq/core/registry) directly from
  // dist/src. Leaving those stale causes cross-workspace drift.
  await writeDevDist({
    directory,
    dist,
    compiledPackageRoot: runtimePackageRoot,
    compiledEntry: path.join(dist, "src", "index.js"),
    executable: isExecutable,
    syncCliAssets: isCli,
  });
}

async function writeDevDist({ directory, dist, compiledPackageRoot, compiledEntry, executable, syncCliAssets: shouldSyncCliAssets }) {
  await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await mkdir(dist, { recursive: true });
  await copyIntoDist(compiledPackageRoot, dist);
  await stripSourceMaps(dist);
  await writeEntryWrapper({
    dist,
    compiledEntry,
    executable,
  });
  if (executable) {
    await chmod(path.join(dist, "index.js"), 0o755);
  }
  if (shouldSyncCliAssets) {
    await syncCliAssets(directory);
  }
}

async function writePackDist({ directory, dist, compiledPackageRoot, compiledEntry, executable, syncCliAssets: shouldSyncCliAssets }) {
  // Publish mode: produce package-local dist trees that can be packed
  // without .build/runtime and without bundling sibling packages.
  await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await mkdir(dist, { recursive: true });
  await copyIntoDist(compiledPackageRoot, dist);
  await stripSourceMaps(dist);
  await writeEntryWrapper({
    dist,
    compiledEntry,
    executable,
  });
  if (executable) {
    await chmod(path.join(dist, "index.js"), 0o755);
  }
  if (shouldSyncCliAssets) {
    await syncCliAssets(directory);
  }
}

async function syncCliAssets(directory) {
  await syncCliTools(directory);
  await syncCliThreadAdapter(directory);
  await syncCliSkillRuntimeAssets(directory);
  await syncOfficialSkillLock(directory);
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

async function syncCliTools(directory) {
  const source = path.join(workspaceRoot, "tools");
  const target = path.join(directory, "tools");
  const compiledTarget = path.join(directory, "dist", "tools");
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(compiledTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  if (await exists(source)) {
    await cp(source, target, { recursive: true });
    await copyCliToolRuntimeTree(source, compiledTarget);
  }
  await stripSourceMaps(compiledTarget);
}

async function copyCliToolRuntimeTree(sourceRoot, targetRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await copyCliToolRuntimeTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    if (sourcePath.endsWith(".ts")) {
      const sourceText = await readFile(sourcePath, "utf8");
      const transpiled = ts.transpileModule(sourceText, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          verbatimModuleSyntax: true,
        },
        fileName: sourcePath,
      }).outputText;
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath.replace(/\.ts$/, ".js"), transpiled, "utf8");
      continue;
    }

    if (
      sourcePath.endsWith(".mjs") ||
      sourcePath.endsWith(".json") ||
      sourcePath.endsWith(".mts")
    ) {
      await copyFileToTarget(sourcePath, targetPath);
    }
  }
}

async function syncCliThreadAdapter(directory) {
  const threadRoot = path.join(workspaceRoot, "tools", "thread");
  const distThreadRoot = path.join(directory, "dist", "tools", "thread");
  for (const fileName of ["github_adapter.mjs", "github_adapter.d.mts"]) {
    const source = path.join(threadRoot, fileName);
    if (!(await exists(source))) {
      continue;
    }
    await copyFileToTarget(source, path.join(distThreadRoot, fileName));
  }
}

async function syncCliSkillRuntimeAssets(directory) {
  const source = path.join(workspaceRoot, "skills");
  const target = path.join(directory, "skills");
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  if (!(await exists(source))) {
    return;
  }
  await copyFilteredTree(source, target, (filePath) => {
    const base = path.basename(filePath);
    return base !== "SKILL.md" && base !== "X.yaml";
  });
}

async function syncOfficialSkillLock(directory) {
  const source = path.join(directory, "src", "official-skills.lock.json");
  if (!(await exists(source))) {
    return;
  }
  const distTarget = path.join(directory, "dist", "src", "official-skills.lock.json");
  if (await exists(path.dirname(distTarget))) {
    await copyFileToTarget(source, distTarget);
  }
}

async function copyFilteredTree(sourceRoot, targetRoot, includeFile) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  let copiedAny = false;
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      const nestedCopied = await copyFilteredTree(sourcePath, targetPath, includeFile);
      copiedAny = copiedAny || nestedCopied;
      continue;
    }
    if (!entry.isFile() || !includeFile(sourcePath)) {
      continue;
    }
    await copyFileToTarget(sourcePath, targetPath);
    copiedAny = true;
  }
  if (!copiedAny) {
    await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return copiedAny;
}

async function copyFileToTarget(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
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
  } catch {
    return false;
  }
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = path.join(workspaceRoot, "fixtures/scaffold/new-docs-demo");
const fixtureFilesDir = path.join(fixtureRoot, "files");
const packageName = "docs-demo";
const runx = process.env.RUNX_DEV_RUST_CLI_BIN
  ?? path.join(workspaceRoot, "crates", "target", "debug", process.platform === "win32" ? "runx.exe" : "runx");

const mode = process.argv.includes("--write") ? "write" : "check";
const tempRoot = await mkdir(path.join(os.tmpdir(), `runx-scaffold-${process.pid}-`), {
  recursive: true,
}).then(() => os.tmpdir());
const generatedRoot = path.join(tempRoot, `runx-scaffold-generated-${process.pid}`);

try {
  await rm(generatedRoot, { recursive: true, force: true });
  const run = spawnSync(runx, ["new", packageName, "--directory", generatedRoot, "--json"], {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || "native scaffold failed");
  const result = (JSON.parse(run.stdout) as {
    readonly new: { readonly name: string; readonly files: readonly string[]; readonly next_steps: readonly string[] };
  }).new;
  const generatedFiles = await collectFiles(generatedRoot);

  if (mode === "write") {
    await rm(fixtureFilesDir, { recursive: true, force: true });
    for (const relativePath of generatedFiles) {
      await writeFixtureFile(relativePath, await readFile(path.join(generatedRoot, relativePath), "utf8"));
    }
    await writeFile(
      path.join(fixtureRoot, "manifest.json"),
      `${JSON.stringify({
        name: result.name,
        files: result.files,
        next_steps: normalizeNextSteps(result.next_steps),
      }, null, 2)}\n`,
    );
    console.log(`Wrote scaffold fixture ${path.relative(workspaceRoot, fixtureRoot)}`);
  } else {
    await assertFixtureMatches(generatedRoot, generatedFiles);
    console.log("Scaffold fixture check passed.");
  }
} finally {
  await rm(generatedRoot, { recursive: true, force: true });
}

function normalizeNextSteps(nextSteps: readonly string[]): string[] {
  return nextSteps.map((step) => step === `cd ${generatedRoot}` ? "cd <target>" : step);
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collect(root, "");
  return files.sort((left, right) => left.localeCompare(right));

  async function collect(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
}

async function writeFixtureFile(relativePath: string, contents: string): Promise<void> {
  const destination = path.join(fixtureFilesDir, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function assertFixtureMatches(generatedRoot: string, generatedFiles: string[]): Promise<void> {
  const expectedFiles = await collectFiles(fixtureFilesDir);
  const problems: string[] = [];
  for (const relativePath of generatedFiles) {
    if (!expectedFiles.includes(relativePath)) {
      problems.push(`missing fixture file ${relativePath}`);
      continue;
    }
    const generated = await readFile(path.join(generatedRoot, relativePath), "utf8");
    const expected = await readFile(path.join(fixtureFilesDir, relativePath), "utf8");
    if (generated !== expected) {
      problems.push(`fixture mismatch ${relativePath}`);
    }
  }
  for (const relativePath of expectedFiles) {
    if (!generatedFiles.includes(relativePath)) {
      problems.push(`stale fixture file ${relativePath}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Scaffold fixture check failed:\n${problems.join("\n")}`);
  }
}

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isPlainRecord } from "../../authoring-utils.js";
import { runProcess } from "./fixture-execution.js";
import type { PreparedFixtureWorkspace } from "./internal.js";

export async function prepareFixtureWorkspace(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): Promise<PreparedFixtureWorkspace> {
  const workspace = isPlainRecord(fixture.workspace)
    ? fixture.workspace
    : isPlainRecord(fixture.repo)
      ? fixture.repo
      : undefined;
  const fixtureDir = path.dirname(fixturePath);
  if (!workspace) {
    return {
      tokens: {
        RUNX_REPO_ROOT: root,
        RUNX_FIXTURE_FILE: fixturePath,
        RUNX_FIXTURE_DIR: fixtureDir,
      },
      cleanup: async () => {},
    };
  }

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "runx-fixture-"));
  const tokens = {
    RUNX_REPO_ROOT: root,
    RUNX_FIXTURE_ROOT: fixtureRoot,
    RUNX_FIXTURE_FILE: fixturePath,
    RUNX_FIXTURE_DIR: fixtureDir,
  };
  try {
    await writeFixtureFileMap(fixtureRoot, workspace.files, tokens, 0o644);
    await writeFixtureFileMap(fixtureRoot, workspace.json_files, tokens, 0o644, true);
    await writeFixtureFileMap(fixtureRoot, workspace.executable_files, tokens, 0o755);
    await initializeFixtureGit(fixtureRoot, workspace.git, tokens, env);
    return {
      root: fixtureRoot,
      tokens,
      cleanup: async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function writeFixtureFileMap(
  root: string,
  value: unknown,
  tokens: Readonly<Record<string, string>>,
  mode: number,
  forceJson = false,
): Promise<void> {
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [relativePath, rawContents] of Object.entries(value)) {
    const targetPath = resolveInsideFixtureRoot(root, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const contents = forceJson
      ? `${JSON.stringify(materializeFixtureValue(rawContents, tokens), null, 2)}\n`
      : typeof rawContents === "string"
        ? materializeFixtureString(rawContents, tokens)
        : `${JSON.stringify(materializeFixtureValue(rawContents, tokens), null, 2)}\n`;
    await writeFile(targetPath, contents, { mode });
  }
}

export async function initializeFixtureGit(
  root: string,
  value: unknown,
  tokens: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const git = value === true ? {} : isPlainRecord(value) ? value : undefined;
  if (!git) {
    return;
  }
  const branch = typeof git.initial_branch === "string" && git.initial_branch.trim()
    ? git.initial_branch.trim()
    : "main";
  await runRequiredProcess("git", ["init", "-b", branch], root, env);
  await runRequiredProcess("git", ["config", "user.email", "fixture@example.com"], root, env);
  await runRequiredProcess("git", ["config", "user.name", "Runx Fixture"], root, env);
  if (git.commit !== false) {
    await runRequiredProcess("git", ["add", "."], root, env);
    await runRequiredProcess("git", ["commit", "-m", "fixture baseline"], root, env);
  }
  await writeFixtureFileMap(root, git.dirty_files, tokens, 0o644);
}

export async function runRequiredProcess(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(command, args, { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

export function materializeFixtureEnv(value: unknown, tokens: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, materializeFixtureString(String(nested), tokens)]),
  );
}

export function materializeFixtureValue(value: unknown, tokens: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    return materializeFixtureString(value, tokens);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeFixtureValue(entry, tokens));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, materializeFixtureValue(nested, tokens)]),
  );
}

export function materializeFixtureString(value: string, tokens: Readonly<Record<string, string>>): string {
  let resolved = value;
  for (const [key, replacement] of Object.entries(tokens)) {
    resolved = resolved.split(`$${key}`).join(replacement);
    resolved = resolved.split(`\${${key}}`).join(replacement);
  }
  return resolved;
}

export function resolveInsideFixtureRoot(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`fixture workspace path must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw new Error(`fixture workspace path escapes root: ${relativePath}`);
  }
  return resolved;
}

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export type JsonRecord = Record<string, unknown>;

export interface OracleCase {
  readonly name: string;
  readonly expectedStatus: "sealed" | "failure";
}

export interface RustOracleOwner {
  readonly spec: string;
  readonly rustTest: string;
  readonly markers: readonly string[];
}

export async function assertCompletedRustOwner(owner: RustOracleOwner): Promise<void> {
  const specPath = path.join(workspaceRoot, owner.spec);
  let spec: string | undefined;
  try {
    spec = await readFile(specPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  if (spec !== undefined && (!/^status:\s*completed$/mu.test(spec) || !/^Review gate:\s*pass$/mu.test(spec))) {
    throw new Error(`${owner.spec} does not declare completed Rust ownership with a passing review gate.`);
  }

  const rustTest = await readFile(path.join(workspaceRoot, owner.rustTest), "utf8");
  for (const required of owner.markers) {
    if (!rustTest.includes(required)) {
      throw new Error(`${owner.rustTest} is missing Rust ownership marker ${required}.`);
    }
  }

  if (spec === undefined) {
    console.log(`${owner.spec} is not present in this checkout; verified Rust ownership markers in ${owner.rustTest}.`);
  }
}

export async function checkNoStaleOracleFiles(
  oracleRoot: string,
  cases: readonly OracleCase[],
  label: string,
): Promise<void> {
  const expectedOracleFiles = new Set<string>();
  for (const oracleCase of cases) {
    for (const extension of ["stdout", "stderr", "status", "json"] as const) {
      expectedOracleFiles.add(path.join(oracleRoot, `${oracleCase.name}.${extension}`));
    }
  }
  for (const filePath of await collectFiles(oracleRoot)) {
    if (!expectedOracleFiles.has(filePath)) {
      throw new Error(`stale ${label} oracle file: ${relative(filePath)}`);
    }
  }
}

export async function readJson(filePath: string): Promise<JsonRecord> {
  return parseJson(await readFile(filePath, "utf8"), filePath);
}

export function parseJson(contents: string, filePath: string): JsonRecord {
  const value = JSON.parse(contents) as unknown;
  if (!isRecord(value)) {
    throw new Error(`${relative(filePath)} must contain a JSON object.`);
  }
  return value;
}

export function recordField(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`expected ${key} to be an object`);
  }
  return value;
}

export function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertNoPackageBoundary(filePath: string, contents: string): void {
  for (const value of ["@runxhq/runtime-local", "@runxhq/adapters", "packages/runtime-local", "packages/adapters"]) {
    if (contents.includes(value)) {
      throw new Error(`${relative(filePath)} still references retired package boundary ${value}.`);
    }
  }
}

export function assertCleanOracle(name: string, filePath: string, contents: string): void {
  assertNoPackageBoundary(filePath, contents);
  const forbidden = [
    workspaceRoot,
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "RUNX_AGENT_API_KEY",
    "sk-fixture-redacted",
    "super-secret-value",
  ];
  for (const value of forbidden) {
    if (value && contents.includes(value)) {
      throw new Error(`${name}: ${relative(filePath)} contains forbidden value '${value}'`);
    }
  }
  if (/\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+)\b/.test(contents)) {
    throw new Error(`${name}: ${relative(filePath)} appears to contain a secret token`);
  }
  if (/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/.test(contents)) {
    throw new Error(`${name}: ${relative(filePath)} contains a wall-clock timestamp`);
  }
}

export function casePath(fixtureRoot: string, name: string): string {
  return path.join(fixtureRoot, name);
}

export function relative(filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function collectFiles(directory: string): Promise<readonly string[]> {
  try {
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

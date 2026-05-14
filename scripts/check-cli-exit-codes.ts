import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliSourceRoot = path.join(workspaceRoot, "packages", "cli", "src");
const docsPath = path.join(workspaceRoot, "docs", "cli-exit-codes.md");

const sourceCodes = new Set<number>();
for (const filePath of await collectTypeScriptFiles(cliSourceRoot)) {
  const source = await readFile(filePath, "utf8");
  for (const match of source.matchAll(/\breturn\s+([0-9]+)\s*;/g)) {
    sourceCodes.add(Number(match[1]));
  }
}

const docs = await readFile(docsPath, "utf8");
const documentedCodes = new Set<number>();
for (const match of docs.matchAll(/^## Exit Code ([0-9]+):/gm)) {
  documentedCodes.add(Number(match[1]));
}

const missing = [...sourceCodes].filter((code) => !documentedCodes.has(code)).sort((left, right) => left - right);
const stale = [...documentedCodes].filter((code) => !sourceCodes.has(code)).sort((left, right) => left - right);

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error(`Missing CLI exit-code docs for: ${missing.join(", ")}`);
  }
  if (stale.length > 0) {
    console.error(`CLI exit-code docs mention codes not returned by source: ${stale.join(", ")}`);
  }
  process.exit(1);
}

async function collectTypeScriptFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

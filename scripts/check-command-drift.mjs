#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannedRoots = ["README.md", "docs", "skills", "examples", "crates", "packages", "scripts"];
const retiredSurfaces = [
  {
    pattern: /\brunx\s+skill\s+add\b/u,
    message: "retired command shape 'runx skill add'; use 'runx add <ref>' for installs",
  },
  {
    pattern: /\brunx\s+skill\s+search\b/u,
    message: "retired command shape 'runx skill search'; use 'runx registry search <query>'",
  },
  {
    pattern: /\brunx\s+skill\s+publish\b/u,
    message: "retired command shape 'runx skill publish'; use 'runx registry publish <skill-dir|SKILL.md>'",
  },
  {
    pattern: /\brunx\s+connect\s+github\b/u,
    message: "retired connect copy 'runx connect github'; use 'runx login --provider github --for publish'",
  },
  {
    pattern: /--(?:api-url|local-api|apiBaseUrl|allowLocalApi|registryDir|trustTier|destination|prefetchOfficial)\b/u,
    message: "retired CLI flag alias; use the canonical kebab-case flag documented by native runx",
  },
];
const failures = [];

for (const relativePath of scannedRoots.flatMap((entry) => textFiles(entry))) {
  const source = readFileSync(path.join(root, relativePath), "utf8");
  for (const retired of retiredSurfaces) {
    if (retired.pattern.test(source) && !allowedRetiredCommandReference(relativePath, source)) {
      failures.push(`${relativePath}: ${retired.message}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("command drift check ok");

function textFiles(relativePath) {
  if (isIgnoredPath(relativePath)) return [];
  const absolutePath = path.join(root, relativePath);
  const stat = statSync(absolutePath);
  if (stat.isFile()) return isText(relativePath) ? [relativePath] : [];
  return readdirSync(absolutePath).flatMap((entry) => {
    const child = path.join(relativePath, entry);
    if (isIgnoredPath(child)) return [];
    const absoluteChild = path.join(root, child);
    const childStat = statSync(absoluteChild);
    if (childStat.isDirectory()) return textFiles(child);
    return isText(child) ? [child] : [];
  });
}

function isIgnoredPath(relativePath) {
  return /(?:^|\/)(?:dist|target|node_modules|\.turbo|coverage)(?:\/|$)/u.test(relativePath);
}

function isText(relativePath) {
  return /\.(?:md|mdx|json|yaml|yml|toml|ts|tsx|js|mjs|rs)$/iu.test(relativePath);
}

function allowedRetiredCommandReference(relativePath, source) {
  if (relativePath === "scripts/check-command-drift.mjs") return true;
  if (/\bremoved\b|\bretired\b|\bno longer supported\b/u.test(source)) return true;
  return /(?:^|\/)(?:test|tests|fixtures)\//u.test(relativePath);
}

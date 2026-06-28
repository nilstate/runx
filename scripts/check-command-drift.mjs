#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannedRoots = ["README.md", "docs", "skills", "examples"];
const failures = [];

for (const relativePath of scannedRoots.flatMap((entry) => textFiles(entry))) {
  const source = readFileSync(path.join(root, relativePath), "utf8");
  if (/\brunx\s+skill\s+add\b/u.test(source) && !allowedRetiredCommandReference(relativePath, source)) {
    failures.push(`${relativePath}: retired command shape 'runx skill add'; use 'runx add <ref>' for installs`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("command drift check ok");

function textFiles(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = statSync(absolutePath);
  if (stat.isFile()) return isText(relativePath) ? [relativePath] : [];
  return readdirSync(absolutePath).flatMap((entry) => {
    const child = path.join(relativePath, entry);
    const absoluteChild = path.join(root, child);
    const childStat = statSync(absoluteChild);
    if (childStat.isDirectory()) return textFiles(child);
    return isText(child) ? [child] : [];
  });
}

function isText(relativePath) {
  return /\.(?:md|mdx|json|yaml|yml|toml|ts|tsx|js|mjs|rs)$/iu.test(relativePath);
}

function allowedRetiredCommandReference(relativePath, source) {
  if (/\bremoved\b|\bretired\b|\bno longer supported\b/u.test(source)) return true;
  return /(?:^|\/)(?:test|tests|fixtures)\//u.test(relativePath);
}

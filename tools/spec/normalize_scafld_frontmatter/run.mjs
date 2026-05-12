#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../../../");
const relativeToolDir = path.relative(packageRoot, here);
const sourceEntry = path.join(here, "src", "index.ts");
const distEntry = path.join(packageRoot, "dist", relativeToolDir, "src", "index.js");
const runningFromInstalledPackage = fileURLToPath(import.meta.url).includes(`${path.sep}node_modules${path.sep}`);
const entry = (runningFromInstalledPackage || !fs.existsSync(sourceEntry)) && fs.existsSync(distEntry)
  ? distEntry
  : sourceEntry;
const tool = (await import(pathToFileURL(entry).href)).default;
await tool.main();

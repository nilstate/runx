import { existsSync } from "node:fs";
import path from "node:path";

import { safeReadDir } from "@runxhq/core/util";

import { discoverToolDirectories } from "../tool.js";

export { safeReadDir };

export async function discoverFixturePaths(unitPath: string, root: string): Promise<readonly string[]> {
  const statPath = existsSync(unitPath) ? unitPath : root;
  const directFixtures = path.join(statPath, "fixtures");
  const paths: string[] = [];
  for (const entry of await safeReadDir(directFixtures)) {
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      paths.push(path.join(directFixtures, entry.name));
    }
  }
  if (paths.length > 0 && statPath !== root) {
    return paths.sort();
  }
  for (const toolDir of await discoverToolDirectories(root)) {
    for (const entry of await safeReadDir(path.join(toolDir, "fixtures"))) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        paths.push(path.join(toolDir, "fixtures", entry.name));
      }
    }
  }
  return paths.sort();
}


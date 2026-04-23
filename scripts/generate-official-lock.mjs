#!/usr/bin/env node

import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistrySkillVersion } from "@runxhq/core/registry";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const skillsRoot = path.join(workspaceRoot, "skills");
const outputPath = path.join(workspaceRoot, "packages", "cli", "src", "official-skills.lock.json");

const entries = [];
for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory()) continue;
  const skillDir = path.join(skillsRoot, entry.name);
  const profilePath = path.join(skillDir, "X.yaml");
  try {
    await access(path.join(skillDir, "SKILL.md"));
    await access(profilePath);
  } catch {
    continue;
  }
  const markdown = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const profileDocument = await readFile(profilePath, "utf8");
  const record = buildRegistrySkillVersion(markdown, {
    owner: "runx",
    profileDocument,
  });
  entries.push({
    skill_id: record.skill_id,
    version: record.version,
    digest: record.digest,
  });
}

await writeFile(outputPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");

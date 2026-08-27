#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lightOnlyPatterns = [
  /^\.github\/dependabot\.yml$/u,
  /^\.scafld\/(?:runs|specs)\//u,
  /^(?:AGENTS|CHANGELOG|CONTRIBUTING|CONVENTIONS|README)\.md$/u,
  /^LICENSE(?:\.|$)/u,
  /^docs\//u,
  /^plans\//u,
];

const skillPatterns = [
  /^skills\//u,
  /^skills\/official\.lock\.json$/u,
  /^scripts\/(?:audit-core-skills|check-codex-export|check-skill-version-drift|generate-official-lock|harness-sweep)\.mjs$/u,
];

const windowsPatterns = [
  /^\.github\/workflows\/ci\.yml$/u,
  /^Cargo\.lock$/u,
  /^rust-toolchain\.toml$/u,
  /^crates\/(?:runx-cli|runx-js-worker|runx-runtime)\//u,
  /^scripts\/harness-sweep\.mjs$/u,
];

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

export function classifyFiles(files) {
  const normalized = [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
  const skillsChanged = normalized.some((file) => matches(skillPatterns, file));
  const full = normalized.length === 0 || normalized.some((file) =>
    !matches(lightOnlyPatterns, file) && !matches(skillPatterns, file)
  );
  return {
    files: normalized,
    full,
    // Runtime changes can alter every skill. A skill-only change avoids the
    // workspace Rust corpus but still runs the real catalog harness.
    skills: full || skillsChanged,
    windows: normalized.length === 0 || normalized.some((file) => matches(windowsPatterns, file)),
    light: !full && !skillsChanged,
  };
}

function main() {
  const [baseRef, headRef = "HEAD"] = process.argv.slice(2);
  if (!baseRef) fail("usage: node scripts/classify-ci-changes.mjs <base-ref> [head-ref]");
  const classification = classifyFiles(changedFiles(baseRef, headRef));
  for (const key of ["full", "skills", "windows", "light"]) {
    writeOutput(key, String(classification[key]));
  }
  writeOutput("changed_files", classification.files.join(" "));
  writeOutput("summary", summarize(classification));
}

function matches(patterns, file) {
  return patterns.some((pattern) => pattern.test(file));
}

function changedFiles(base, head) {
  try {
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
      .split(/\r?\n/u);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warning: could not diff ${base}...${head}; running all checks. ${message.split("\n")[0]}`);
    return [];
  }
}

function summarize(input) {
  const lanes = [input.full ? "full" : undefined, input.skills ? "skills" : undefined,
    input.windows ? "windows" : undefined, input.light ? "light" : undefined].filter(Boolean);
  return `${lanes.join("+")} checks for ${input.files.length} changed file(s)`;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value.replace(/\n/gu, " ")}\n`);
  else console.log(`${name}=${value}`);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

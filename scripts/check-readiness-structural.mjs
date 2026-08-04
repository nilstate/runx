#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: workspaceRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((file) => existsSync(path.join(workspaceRoot, file)))
  .sort();
const trackedFileSet = new Set(trackedFiles);

const failures = [
  ...checkRetiredCoreImports(),
  ...checkStaleWorkspaceCommands(),
  ...checkCommittedBuildOutput(),
  ...checkTrackedEmptyDirPlaceholders(),
  ...checkDuplicateActiveAndDraftSpecs(),
];

if (failures.length > 0) {
  console.error("Readiness structural guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Readiness structural guard passed.");

function checkRetiredCoreImports() {
  const failures = [];
  const roots = [
    ".github/",
    "crates/",
    "examples/",
    "fixtures/",
    "package.json",
    "packages/",
    "pnpm-lock.yaml",
    "scripts/",
    "tests/",
    "tools/",
  ];
  const importPattern =
    /\b(?:from|import)\s*["']@runxhq\/core(?:\/[^"']*)?["']|\b(?:import|require)\(\s*["']@runxhq\/core(?:\/[^"']*)?["']\s*\)|^\s*['"]?@runxhq\/core(?:\/[^'":]*)?['"]?\s*:/mu;

  for (const file of trackedFiles) {
    if (!roots.some((root) => file === root || file.startsWith(root))) {
      continue;
    }
    if (isGeneratedOrVendorPath(file) || isBinaryish(file)) {
      continue;
    }
    const source = readFileSync(path.join(workspaceRoot, file), "utf8");
    if (importPattern.test(source)) {
      failures.push(`${file} references retired @runxhq/core as an import or package dependency`);
    }
  }

  return failures;
}

function checkStaleWorkspaceCommands() {
  const failures = [];
  const documentation = new Set([
    "CONTRIBUTING.md",
    "README.md",
    ...trackedFiles.filter((file) => file.startsWith("docs/") && file.endsWith(".md")),
  ]);
  const staleCommandPattern = /\b(?:cd\s+oss|pnpm\s+--dir\s+oss)\b|oss\/packages\/cli/u;

  for (const file of documentation) {
    if (!trackedFileSet.has(file)) {
      continue;
    }
    const source = readFileSync(path.join(workspaceRoot, file), "utf8");
    if (staleCommandPattern.test(source)) {
      failures.push(`${file} contains a stale parent-workspace command for the standalone OSS checkout`);
    }
  }

  return failures;
}

function checkCommittedBuildOutput() {
  const failures = [];
  for (const file of trackedFiles) {
    if (!hasBuildOutputSegment(file)) {
      continue;
    }
    if (isAllowedCommittedBuildOutput(file)) {
      continue;
    }
    failures.push(`${file} is committed build output outside the explicit allowlist`);
  }
  return failures;
}

function checkTrackedEmptyDirPlaceholders() {
  const allowedGitkeep = new Set([
    "fixtures/skill-author-runtime/skill/.gitkeep",
    "fixtures/skill-author-runtime/workspace-target/.gitkeep",
  ]);
  const failures = [];

  for (const file of trackedFiles) {
    if (!file.endsWith("/.gitkeep") && !file.endsWith("/.keep")) {
      continue;
    }
    if (!allowedGitkeep.has(file)) {
      failures.push(`${file} is an unapproved empty-directory placeholder`);
      continue;
    }
    const directory = path.dirname(path.join(workspaceRoot, file));
    const entries = readdirSync(directory).filter((entry) => entry !== ".DS_Store");
    if (entries.length !== 1 || entries[0] !== path.basename(file)) {
      failures.push(`${file} is no longer preserving an empty fixture directory`);
    }
  }

  return failures;
}

function checkDuplicateActiveAndDraftSpecs() {
  const activeSpecIds = new Map();
  const draftSpecIds = new Map();

  for (const file of trackedFiles) {
    if (!file.startsWith(".scafld/specs/") || !file.endsWith(".md")) {
      continue;
    }
    if (file.startsWith(".scafld/specs/archive/")) {
      continue;
    }
    // scafld owns spec identity and stores each live task at <task_id>.md.
    // This repository check only compares those owned paths; it must not
    // become a second parser for scafld lifecycle front matter.
    const taskId = path.basename(file, ".md");
    if (file.startsWith(".scafld/specs/drafts/")) {
      addSpec(draftSpecIds, taskId, file);
    } else if (file.startsWith(".scafld/specs/active/") || file.startsWith(".scafld/specs/approved/")) {
      addSpec(activeSpecIds, taskId, file);
    }
  }

  const failures = [];
  for (const [taskId, activeFiles] of activeSpecIds) {
    const draftFiles = draftSpecIds.get(taskId);
    if (draftFiles) {
      failures.push(
        `spec ${taskId} exists in active/approved and drafts: ${[...activeFiles, ...draftFiles].join(", ")}`,
      );
    }
  }
  return failures;
}

function addSpec(index, taskId, file) {
  const files = index.get(taskId) ?? [];
  files.push(file);
  index.set(taskId, files);
}

function hasBuildOutputSegment(file) {
  return file.split("/").some((segment) => segment === "dist" || segment === "build" || segment === ".build" || segment === "target");
}

function isAllowedCommittedBuildOutput(file) {
  return (
    /^dist\/packets\/[^/]+\.schema\.json$/u.test(file)
    || file.startsWith("fixtures/tool-catalogs/build/")
    || file.startsWith("tools/sourcey/build/")
  );
}

function isGeneratedOrVendorPath(file) {
  return file
    .split("/")
    .some((segment) => segment === "node_modules" || segment === "dist" || segment === ".build" || segment === "target");
}

function isBinaryish(file) {
  return /\.(?:png|jpg|jpeg|gif|webp|ico|pdf|tgz|zip|gz|wasm)$/iu.test(file);
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateRunxCliReleaseNotes } from "./lib/runx-cli-release-evidence.mjs";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
try {
  checkReleaseNotes();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function checkReleaseNotes() {
  const version = requiredVersion(process.argv.slice(2));
  const currentTag = `cli-v${version}`;
  const previousTag = execFileSync(
    "git",
    ["tag", "--list", "cli-v*", "--sort=-version:refname"],
    { cwd: workspaceRoot, encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .map((tag) => tag.trim())
    .find((tag) => /^cli-v\d+\.\d+\.\d+$/u.test(tag) && tag !== currentTag);

  if (!previousTag) {
    throw new Error(`no previous stable CLI release tag exists before ${currentTag}`);
  }

  const notesPath = path.join(workspaceRoot, "release", "notes", `${version}.md`);
  const result = validateRunxCliReleaseNotes({
    body: readFileSync(notesPath, "utf8"),
    version,
    previousTag,
  });

  process.stdout.write(`${JSON.stringify({
    status: result.ready ? "ready" : "failed",
    version,
    previous_tag: previousTag,
    file: path.relative(workspaceRoot, notesPath).split(path.sep).join("/"),
    checks: result.checks,
  }, null, 2)}\n`);

  if (!result.ready) {
    process.exitCode = 1;
  }
}

function requiredVersion(argv) {
  const index = argv.indexOf("--version");
  const versionValue = index >= 0 ? argv[index + 1] : "";
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(versionValue)) {
    throw new Error("--version requires a stable X.Y.Z version");
  }
  if (argv.length !== 2 || index !== 0) {
    throw new Error("usage: check-runx-cli-release-notes.mjs --version X.Y.Z");
  }
  return versionValue;
}

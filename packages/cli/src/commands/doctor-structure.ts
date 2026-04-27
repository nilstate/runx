import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildRegistrySkillVersion } from "@runxhq/core/registry";

import { safeReadDir, toProjectPath } from "../authoring-utils.js";

import { createDoctorDiagnostic, type DoctorDiagnostic } from "./doctor-types.js";

interface DoctorFileBudget {
  readonly path: string;
  readonly maxLines: number;
}

const DOCTOR_FILE_BUDGETS: readonly DoctorFileBudget[] = [
  {
    path: "packages/cli/src/index.ts",
    maxLines: 1000,
  },
  {
    path: "packages/cli/src/commands/doctor.ts",
    maxLines: 950,
  },
  {
    path: "packages/runtime-local/src/runner-local/index.ts",
    maxLines: 2000,
  },
] as const;

const DOCTOR_IMPORT_SPECIFIER_PATTERNS = [
  /^\s*import\s+(?:type\s+)?(?:[^"'`\n]+?\s+from\s+)?["']([^"'`]+)["'];?/gm,
  /^\s*export\s+(?:type\s+)?[^"'`\n]*?\s+from\s+["']([^"'`]+)["'];?/gm,
] as const;

export async function discoverStructuralDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  return [
    ...await discoverOfficialSkillsLockDoctorDiagnostics(root),
    ...await discoverDoctorFileBudgetDiagnostics(root),
    ...await discoverCrossPackageReachInDoctorDiagnostics(root),
  ];
}

async function discoverOfficialSkillsLockDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const lockDir = path.join(root, "packages", "cli", "src");
  const lockPath = path.join(lockDir, "official-skills.lock.json");
  if (!existsSync(lockDir)) {
    return [];
  }
  const expectedContents = await renderOfficialSkillsLock(root);
  if (expectedContents === undefined) {
    return [];
  }
  const actualContents = existsSync(lockPath) ? await readFile(lockPath, "utf8") : undefined;
  if (actualContents === expectedContents) {
    return [];
  }
  return [createDoctorDiagnostic({
    id: "runx.skill.lock.stale",
    severity: "error",
    title: "Official skills lock is stale",
    message: "packages/cli/src/official-skills.lock.json does not match the current first-party skills.",
    target: {
      kind: "workspace",
      ref: "official-skills.lock",
    },
    location: {
      path: toProjectPath(root, lockPath),
    },
    evidence: {
      expected_hash: hashDoctorContents(expectedContents),
      actual_hash: actualContents === undefined ? "missing" : hashDoctorContents(actualContents),
      repair_command: "node scripts/generate-official-lock.mjs",
    },
    repairs: [{
      id: "refresh_official_skills_lock",
      kind: existsSync(lockPath) ? "replace_file" : "create_file",
      confidence: "high",
      risk: "low",
      path: toProjectPath(root, lockPath),
      contents: expectedContents,
      requires_human_review: false,
    }],
  })];
}

async function renderOfficialSkillsLock(root: string): Promise<string | undefined> {
  const skillsRoot = path.join(root, "skills");
  if (!existsSync(skillsRoot)) {
    return undefined;
  }
  const entries: { skill_id: string; version: string; digest: string }[] = [];
  for (const entry of [...await safeReadDir(skillsRoot)].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(skillsRoot, entry.name);
    const markdownPath = path.join(skillDir, "SKILL.md");
    const profilePath = path.join(skillDir, "X.yaml");
    if (!existsSync(markdownPath) || !existsSync(profilePath)) {
      continue;
    }
    const markdown = await readFile(markdownPath, "utf8");
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
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function hashDoctorContents(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function discoverDoctorFileBudgetDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const budget of DOCTOR_FILE_BUDGETS) {
    const filePath = path.join(root, budget.path);
    if (!existsSync(filePath)) {
      continue;
    }
    const lineCount = countFileLines(await readFile(filePath, "utf8"));
    if (lineCount <= budget.maxLines) {
      continue;
    }
    diagnostics.push(createDoctorDiagnostic({
      id: "runx.structure.file_budget.exceeded",
      severity: "error",
      title: "File exceeded structural line budget",
      message: `${budget.path} is ${lineCount} lines, above the enforced budget of ${budget.maxLines}.`,
      target: {
        kind: "workspace",
        ref: budget.path,
      },
      location: {
        path: budget.path,
      },
      evidence: {
        line_count: lineCount,
        max_lines: budget.maxLines,
      },
      repairs: [{
        id: "split_file_along_real_boundary",
        kind: "manual",
        confidence: "medium",
        risk: "low",
        requires_human_review: false,
      }],
    }));
  }
  return diagnostics;
}

function countFileLines(contents: string): number {
  if (contents.length === 0) {
    return 0;
  }
  return (contents.match(/\n/g) ?? []).length;
}

async function discoverCrossPackageReachInDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const packagesRoot = path.join(root, "packages");
  if (!existsSync(packagesRoot)) {
    return [];
  }
  const diagnostics: DoctorDiagnostic[] = [];
  for (const entry of await listDoctorSourceFiles(packagesRoot)) {
    const sourcePackage = readWorkspacePackageName(root, entry);
    if (!sourcePackage) {
      continue;
    }
    const contents = await readFile(entry, "utf8");
    for (const specifier of extractImportSpecifiers(contents)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = path.resolve(path.dirname(entry), specifier);
      const targetSegments = path.relative(root, resolved).split(path.sep);
      if (targetSegments[0] !== "packages" || targetSegments[2] !== "src") {
        continue;
      }
      const targetPackage = targetSegments[1];
      if (!targetPackage || targetPackage === sourcePackage) {
        continue;
      }
      diagnostics.push(createDoctorDiagnostic({
        id: "runx.structure.cross_package_reach_in",
        severity: "error",
        title: "Cross-package src reach-in is forbidden",
        message: `${toProjectPath(root, entry)} imports ${specifier}, reaching into packages/${targetPackage}/src directly.`,
        target: {
          kind: "workspace",
          ref: toProjectPath(root, entry),
        },
        location: {
          path: toProjectPath(root, entry),
        },
        evidence: {
          specifier,
          source_package: sourcePackage,
          target_package: targetPackage,
          resolved_path: toProjectPath(root, resolved),
        },
        repairs: [{
          id: "replace_with_package_boundary_import",
          kind: "manual",
          confidence: "high",
          risk: "low",
          requires_human_review: false,
        }],
      }));
    }
  }
  return diagnostics;
}

async function listDoctorSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await safeReadDir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listDoctorSourceFiles(entryPath));
      continue;
    }
    if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function readWorkspacePackageName(root: string, filePath: string): string | undefined {
  const segments = path.relative(root, filePath).split(path.sep);
  return segments[0] === "packages" ? segments[1] : undefined;
}

function extractImportSpecifiers(contents: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const pattern of DOCTOR_IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

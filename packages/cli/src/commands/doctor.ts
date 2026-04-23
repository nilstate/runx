import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DoctorDiagnosticContract,
  DoctorRepairContract,
  DoctorReportContract,
} from "@runxhq/contracts";
import { resolvePathFromUserInput, resolveRunxWorkspaceBase } from "@runxhq/core/config";
import {
  parseRunnerManifestYaml,
  parseToolManifestJson,
  validateRunnerManifest,
  validateToolManifest,
} from "@runxhq/core/parser";
import { buildRegistrySkillVersion } from "@runxhq/core/registry";

import {
  buildLocalPacketIndex,
  countYamlFiles,
  discoverSkillProfilePaths,
  isPlainRecord,
  safeReadDir,
  sha256Stable,
  toProjectPath,
} from "../authoring-utils.js";
import { renderKeyValue, statusIcon, theme } from "../ui.js";
import { resolveToolDirFromRef } from "./tool.js";

export interface DoctorCommandArgs {
  readonly doctorPath?: string;
  readonly doctorFix: boolean;
}

export type DoctorRepair = DoctorRepairContract;
export type DoctorDiagnostic = DoctorDiagnosticContract;
export type DoctorReport = DoctorReportContract;

interface StepOutputDeclaration {
  readonly packet?: string;
}

interface DoctorFileBudget {
  readonly path: string;
  readonly maxLines: number;
}

const DOCTOR_FILE_BUDGETS: readonly DoctorFileBudget[] = [
  {
    path: "packages/cli/src/index.ts",
    maxLines: 3000,
  },
  {
    path: "packages/core/src/runner-local/index.ts",
    maxLines: 3800,
  },
];

const DOCTOR_IMPORT_SPECIFIER_PATTERNS = [
  /^\s*import\s+(?:type\s+)?(?:[^"'`\n]+?\s+from\s+)?["']([^"'`]+)["'];?/gm,
  /^\s*export\s+(?:type\s+)?[^"'`\n]*?\s+from\s+["']([^"'`]+)["'];?/gm,
] as const;

export async function handleDoctorCommand(parsed: DoctorCommandArgs, env: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const root = parsed.doctorPath
    ? resolvePathFromUserInput(parsed.doctorPath, env)
    : resolveRunxWorkspaceBase(env);
  const diagnostics = [
    ...await discoverStructuralDoctorDiagnostics(root),
    ...await discoverToolDoctorDiagnostics(root),
    ...await discoverSkillDoctorDiagnostics(root),
    ...await discoverPacketDoctorDiagnostics(root),
  ];
  if (parsed.doctorFix) {
    const applied = await applySafeDoctorRepairs(root, diagnostics);
    if (applied > 0) {
      return handleDoctorCommand({ ...parsed, doctorFix: false }, env);
    }
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
  return {
    schema: "runx.doctor.v1",
    status: errors > 0 ? "failure" : "success",
    summary: {
      errors,
      warnings,
      infos,
    },
    diagnostics: diagnostics.sort((left, right) => left.location.path.localeCompare(right.location.path) || left.id.localeCompare(right.id)),
  };
}

async function applySafeDoctorRepairs(root: string, diagnostics: readonly DoctorDiagnostic[]): Promise<number> {
  let applied = 0;
  for (const diagnostic of diagnostics) {
    const repair = diagnostic.repairs.find((candidate) =>
      candidate.confidence === "high"
      && candidate.requires_human_review === false
      && candidate.risk === "low"
      && (candidate.kind === "create_file" || candidate.kind === "replace_file")
      && typeof candidate.path === "string"
      && typeof candidate.contents === "string"
    );
    if (!repair?.path || repair.contents === undefined) {
      continue;
    }
    const targetPath = path.resolve(root, repair.path);
    if (!targetPath.startsWith(`${root}${path.sep}`) && targetPath !== root) {
      continue;
    }
    if (repair.kind === "create_file" && existsSync(targetPath)) {
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, repair.contents);
    applied += 1;
    break;
  }
  return applied;
}

async function discoverToolDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const toolsRoot = path.join(root, "tools");
  const diagnostics: DoctorDiagnostic[] = [];
  for (const namespaceEntry of await safeReadDir(toolsRoot)) {
    if (!namespaceEntry.isDirectory()) {
      continue;
    }
    const namespaceDir = path.join(toolsRoot, namespaceEntry.name);
    for (const toolEntry of await safeReadDir(namespaceDir)) {
      if (!toolEntry.isDirectory()) {
        continue;
      }
      const toolDir = path.join(namespaceDir, toolEntry.name);
      const legacyPath = path.join(toolDir, "tool.yaml");
      if (existsSync(legacyPath)) {
        const relativePath = toProjectPath(root, legacyPath);
        diagnostics.push(createDoctorDiagnostic({
          id: "runx.tool.manifest.legacy_format",
          severity: "error",
          title: "Legacy tool.yaml is no longer supported",
          message: `Tool ${namespaceEntry.name}.${toolEntry.name} still uses tool.yaml. Runx resolves manifest.json only.`,
          target: {
            kind: "tool",
            ref: `${namespaceEntry.name}.${toolEntry.name}`,
          },
          location: {
            path: relativePath,
          },
          evidence: {
            expected_manifest: toProjectPath(root, path.join(toolDir, "manifest.json")),
          },
          repairs: [{
            id: "migrate_to_define_tool",
            kind: "run_command",
            confidence: "high",
            risk: "medium",
            command: `runx tool migrate ${toProjectPath(root, toolDir)}`,
            requires_human_review: true,
          }],
        }));
      }

      const manifestPath = path.join(toolDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      try {
        const manifestContents = await readFile(manifestPath, "utf8");
        validateToolManifest(parseToolManifestJson(manifestContents));
        const manifest = JSON.parse(manifestContents) as unknown;
        if (isPlainRecord(manifest)) {
          const fixtureCount = await countYamlFiles(path.join(toolDir, "fixtures"));
          if (fixtureCount === 0) {
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.tool.fixture.missing",
              severity: "error",
              title: "Tool has no deterministic fixture",
              message: `Tool ${namespaceEntry.name}.${toolEntry.name} declares a manifest but has no deterministic fixture.`,
              target: {
                kind: "tool",
                ref: `${namespaceEntry.name}.${toolEntry.name}`,
              },
              location: {
                path: toProjectPath(root, manifestPath),
              },
              evidence: {
                fixture_count: fixtureCount,
                expected_location: toProjectPath(root, path.join(toolDir, "fixtures")),
              },
              repairs: [{
                id: "add_tool_fixture",
                kind: "manual",
                confidence: "medium",
                risk: "low",
                requires_human_review: false,
              }],
            }));
          }
          const actualSourceHash = await hashToolSource(toolDir);
          const actualSchemaHash = sha256Stable({
            inputs: manifest.inputs,
            output: manifest.output,
            artifacts: isPlainRecord(manifest.runx) ? manifest.runx.artifacts : undefined,
          });
          if (typeof manifest.source_hash === "string" && manifest.source_hash !== actualSourceHash) {
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.tool.manifest.stale",
              severity: "error",
              title: "Tool manifest is stale",
              message: `Tool ${namespaceEntry.name}.${toolEntry.name} source_hash does not match current source files.`,
              target: {
                kind: "tool",
                ref: `${namespaceEntry.name}.${toolEntry.name}`,
              },
              location: {
                path: toProjectPath(root, manifestPath),
                json_pointer: "/source_hash",
              },
              evidence: {
                expected: actualSourceHash,
                actual: manifest.source_hash,
              },
              repairs: [{
                id: "rebuild_tool_manifest",
                kind: "run_command",
                confidence: "high",
                risk: "low",
                command: `runx tool build ${toProjectPath(root, toolDir)}`,
                requires_human_review: false,
              }],
            }));
          }
          if (typeof manifest.schema_hash === "string" && manifest.schema_hash !== actualSchemaHash) {
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.tool.manifest.stale",
              severity: "error",
              title: "Tool manifest schema hash is stale",
              message: `Tool ${namespaceEntry.name}.${toolEntry.name} schema_hash does not match current manifest inputs/output.`,
              target: {
                kind: "tool",
                ref: `${namespaceEntry.name}.${toolEntry.name}`,
              },
              location: {
                path: toProjectPath(root, manifestPath),
                json_pointer: "/schema_hash",
              },
              evidence: {
                expected: actualSchemaHash,
                actual: manifest.schema_hash,
              },
              repairs: [{
                id: "rebuild_tool_manifest",
                kind: "run_command",
                confidence: "high",
                risk: "low",
                command: `runx tool build ${toProjectPath(root, toolDir)}`,
                requires_human_review: false,
              }],
            }));
          }
        }
      } catch (error) {
        diagnostics.push(createDoctorDiagnostic({
          id: "runx.tool.manifest.invalid",
          severity: "error",
          title: "Tool manifest is invalid",
          message: error instanceof Error ? error.message : String(error),
          target: {
            kind: "tool",
            ref: `${namespaceEntry.name}.${toolEntry.name}`,
          },
          location: {
            path: toProjectPath(root, manifestPath),
          },
          repairs: [{
            id: "repair_manifest",
            kind: "manual",
            confidence: "medium",
            risk: "low",
            requires_human_review: false,
          }],
        }));
      }
    }
  }
  return diagnostics;
}

async function discoverSkillDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const profilePath of await discoverSkillProfilePaths(root)) {
    const skillDir = path.dirname(profilePath);
    const skillName = skillDir === root ? path.basename(root) : path.basename(skillDir);
    try {
      const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(profilePath, "utf8")));
      const fixtureCount = await countYamlFiles(path.join(skillDir, "fixtures"));
      const harnessCaseCount = manifest.harness?.cases.length ?? 0;
      if (fixtureCount === 0 && harnessCaseCount === 0) {
        diagnostics.push(createDoctorDiagnostic({
          id: "runx.skill.fixture.missing",
          severity: "error",
          title: "Skill has no harness coverage",
          message: `Skill ${skillName} declares an execution profile but has no fixtures or inline harness.cases.`,
          target: {
            kind: "skill",
            ref: skillName,
          },
          location: {
            path: toProjectPath(root, profilePath),
            json_pointer: "/harness",
          },
          evidence: {
            fixture_count: fixtureCount,
            harness_case_count: harnessCaseCount,
          },
          repairs: [{
            id: "add_inline_harness_case",
            kind: "manual",
            confidence: "medium",
            risk: "low",
            requires_human_review: false,
          }],
        }));
      }
      diagnostics.push(...await validateChainContextReferences(root, skillDir, profilePath, manifest));
    } catch (error) {
      diagnostics.push(createDoctorDiagnostic({
        id: "runx.skill.profile.invalid",
        severity: "error",
        title: "Skill execution profile is invalid",
        message: error instanceof Error ? error.message : String(error),
        target: {
          kind: "skill",
          ref: skillName,
        },
        location: {
          path: toProjectPath(root, profilePath),
        },
        repairs: [{
          id: "repair_profile",
          kind: "manual",
          confidence: "medium",
          risk: "low",
          requires_human_review: false,
        }],
      }));
    }
  }
  return diagnostics;
}

async function discoverStructuralDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
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

async function discoverPacketDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  const index = await buildLocalPacketIndex(root, { writeCache: true });
  for (const error of index.errors) {
    diagnostics.push(createDoctorDiagnostic({
      id: error.id,
      severity: "error",
      title: error.title,
      message: error.message,
      target: {
        kind: "packet",
        ref: error.ref,
      },
      location: {
        path: error.path,
      },
      evidence: error.evidence,
      repairs: [{
        id: "repair_packet_schema",
        kind: "manual",
        confidence: "medium",
        risk: "low",
        requires_human_review: false,
      }],
    }));
  }
  return diagnostics;
}

async function validateChainContextReferences(
  root: string,
  skillDir: string,
  profilePath: string,
  manifest: ReturnType<typeof validateRunnerManifest>,
): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const runner of Object.values(manifest.runners)) {
    const graph = runner.source.chain;
    if (!graph) {
      continue;
    }
    const warnedMissingSchema = new Set<string>();
    const outputMap = new Map<string, Readonly<Record<string, StepOutputDeclaration>>>();
    for (const step of graph.steps) {
      for (const edge of step.contextEdges) {
        const producerOutputs = outputMap.get(edge.fromStep);
        if (!producerOutputs) {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.producer_missing",
            severity: "error",
            title: "Chain context producer is missing",
            message: `${step.id}.${edge.input} references missing producer step ${edge.fromStep}.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: { reference: `${edge.fromStep}.${edge.output}` },
            repairs: [{ id: "choose_existing_producer", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
          continue;
        }
        if (Object.keys(producerOutputs).length === 0) {
          continue;
        }
        const [emitName, envelopeSegment, ...packetPath] = edge.output.split(".");
        if (!emitName || !producerOutputs[emitName]) {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.output_missing",
            severity: "error",
            title: "Chain context output is missing",
            message: `${step.id}.${edge.input} references output ${emitName || "(empty)"} from ${edge.fromStep}, but that output is not declared.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: {
              reference: `${edge.fromStep}.${edge.output}`,
              available_outputs: Object.keys(producerOutputs),
            },
            repairs: [{ id: "choose_existing_output", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
          continue;
        }
        if (envelopeSegment !== "data") {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.data_envelope_skipped",
            severity: "error",
            title: "Chain context skipped artifact data envelope",
            message: `${step.id}.${edge.input} must reference ${edge.fromStep}.${emitName}.data before packet fields.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: {
              reference: `${edge.fromStep}.${edge.output}`,
              expected_prefix: `${edge.fromStep}.${emitName}.data`,
            },
            repairs: [{
              id: "insert_data_segment",
              kind: "edit_yaml",
              confidence: "high",
              risk: "low",
              path: toProjectPath(root, profilePath),
              requires_human_review: false,
            }],
          }));
          continue;
        }
        const packetId = producerOutputs[emitName]?.packet;
        if (!packetId) {
          const warningKey = `${edge.fromStep}.${emitName}`;
          if (!warnedMissingSchema.has(warningKey)) {
            warnedMissingSchema.add(warningKey);
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.chain.context.schema_missing",
              severity: "warning",
              title: "Chain context producer has no packet schema",
              message: `${edge.fromStep}.${emitName} has no packet metadata, so doctor cannot verify packet paths.`,
              target: { kind: "chain", ref: graph.name, step: step.id },
              location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
              evidence: { reference: `${edge.fromStep}.${emitName}.data` },
              repairs: [{ id: "add_output_packet", kind: "edit_yaml", confidence: "medium", risk: "low", path: toProjectPath(root, profilePath), requires_human_review: false }],
            }));
          }
          continue;
        }
        const packetCheck = await validatePacketPath(root, packetId, packetPath);
        if (packetCheck.status === "missing_packet") {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.packet.ref.missing",
            severity: "error",
            title: "Packet schema is missing",
            message: `Packet ${packetId} referenced by ${edge.fromStep}.${emitName} is not declared in package.json runx.packets.`,
            target: { kind: "packet", ref: packetId },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: { reference: `${edge.fromStep}.${edge.output}` },
            repairs: [{ id: "declare_packet_artifact", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
        } else if (packetCheck.status === "path_invalid") {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.path_invalid",
            severity: "error",
            title: "Chain context packet path is invalid",
            message: `${packetPath.join(".") || "(data)"} does not exist in packet ${packetId}.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: {
              reference: `${edge.fromStep}.${edge.output}`,
              packet: packetId,
              available_properties: packetCheck.available,
            },
            repairs: [{ id: "choose_existing_property", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
        }
      }
      outputMap.set(step.id, await loadStepOutputDeclarations(root, skillDir, step));
    }
  }
  return diagnostics;
}

async function loadStepOutputDeclarations(
  root: string,
  skillDir: string,
  step: { readonly tool?: string; readonly skill?: string; readonly run?: Readonly<Record<string, unknown>>; readonly runner?: string; readonly artifacts?: Readonly<Record<string, unknown>> },
): Promise<Readonly<Record<string, StepOutputDeclaration>>> {
  if (step.tool) {
    const toolDir = resolveToolDirFromRef(root, step.tool);
    if (!toolDir) {
      return {};
    }
    const raw = JSON.parse(await readFile(path.join(toolDir, "manifest.json"), "utf8")) as unknown;
    if (!isPlainRecord(raw)) return {};
    const output = isPlainRecord(raw.output) ? raw.output : {};
    const packet = readPacketRef(output.packet);
    const wrapAs = typeof output.wrap_as === "string"
      ? output.wrap_as
      : isPlainRecord(raw.runx) && isPlainRecord(raw.runx.artifacts) && typeof raw.runx.artifacts.wrap_as === "string"
        ? raw.runx.artifacts.wrap_as
        : undefined;
    if (wrapAs) {
      return { [wrapAs]: { packet } };
    }
    const namedEmits = isPlainRecord(output.named_emits) ? output.named_emits : undefined;
    if (namedEmits) {
      const outputPackets = isPlainRecord(output.outputs) ? output.outputs : {};
      return Object.fromEntries(Object.keys(namedEmits).map((name) => {
        const declared = outputPackets[name];
        return [name, { packet: readPacketRef(isPlainRecord(declared) ? declared.packet : undefined) ?? packet }];
      }));
    }
    return {};
  }
  if (step.skill) {
    const profilePath = resolveNestedSkillProfilePath(skillDir, step.skill);
    if (!profilePath) {
      return {};
    }
    const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(profilePath, "utf8")));
    const runner = step.runner ? manifest.runners[step.runner] : Object.values(manifest.runners).find((candidate) => candidate.default) ?? Object.values(manifest.runners)[0];
    if (!runner) {
      return {};
    }
    return outputDeclarationsFromArtifacts(runner.artifacts, runner.raw);
  }
  return outputDeclarationsFromArtifacts(
    step.artifacts ? {
      wrapAs: typeof step.artifacts.wrap_as === "string" ? step.artifacts.wrap_as : undefined,
      namedEmits: isPlainRecord(step.artifacts.named_emits) ? step.artifacts.named_emits as Readonly<Record<string, string>> : undefined,
    } : undefined,
    { ...(step.run ?? {}), artifacts: step.artifacts },
  );
}

function outputDeclarationsFromArtifacts(
  artifacts: { readonly wrapAs?: string; readonly namedEmits?: Readonly<Record<string, string>> } | undefined,
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, StepOutputDeclaration>> {
  const outputs = isPlainRecord(raw.outputs) ? raw.outputs : {};
  const artifactMetadata = isPlainRecord(raw.artifacts) ? raw.artifacts : {};
  const artifactPackets = isPlainRecord(artifactMetadata.packets) ? artifactMetadata.packets : {};
  if (artifacts?.wrapAs) {
    const output = outputs[artifacts.wrapAs];
    return {
      [artifacts.wrapAs]: {
        packet:
          readPacketRef(isPlainRecord(output) ? output.packet : undefined)
          ?? readPacketRef(artifactMetadata.packet)
          ?? readPacketRef(artifactPackets[artifacts.wrapAs]),
      },
    };
  }
  if (artifacts?.namedEmits) {
    return Object.fromEntries(
      Object.keys(artifacts.namedEmits).map((name) => [
        name,
        {
          packet:
            readPacketRef(isPlainRecord(outputs[name]) ? outputs[name].packet : undefined)
            ?? readPacketRef(artifactPackets[name]),
        },
      ]),
    );
  }
  return {};
}

function resolveNestedSkillProfilePath(skillDir: string, ref: string): string | undefined {
  const resolved = path.resolve(skillDir, ref);
  const directory = path.basename(resolved).toLowerCase() === "skill.md" ? path.dirname(resolved) : resolved;
  const profilePath = path.join(directory, "X.yaml");
  return existsSync(profilePath) ? profilePath : undefined;
}

function readPacketRef(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isPlainRecord(value) && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

async function validatePacketPath(
  root: string,
  packetId: string,
  packetPath: readonly string[],
): Promise<{ readonly status: "ok" } | { readonly status: "missing_packet" } | { readonly status: "path_invalid"; readonly available: readonly string[] }> {
  const index = await buildLocalPacketIndex(root, { writeCache: false });
  const packet = index.packets.find((candidate) => candidate.id === packetId);
  if (!packet) {
    return { status: "missing_packet" };
  }
  const schema = JSON.parse(await readFile(path.resolve(root, packet.path), "utf8")) as unknown;
  const result = schemaHasPath(schema, packetPath, schema);
  return result.ok ? { status: "ok" } : { status: "path_invalid", available: result.available };
}

function schemaHasPath(
  schema: unknown,
  packetPath: readonly string[],
  rootSchema: unknown,
): { readonly ok: boolean; readonly available: readonly string[] } {
  const resolved = resolveJsonSchemaRef(schema, rootSchema);
  if (packetPath.length === 0) {
    return { ok: true, available: [] };
  }
  if (!isPlainRecord(resolved)) {
    return { ok: false, available: [] };
  }
  if (Array.isArray(resolved.anyOf) || Array.isArray(resolved.oneOf)) {
    const branches = (Array.isArray(resolved.anyOf) ? resolved.anyOf : resolved.oneOf) as readonly unknown[];
    const results = branches.map((branch) => schemaHasPath(branch, packetPath, rootSchema));
    return results.some((result) => result.ok) ? { ok: true, available: [] } : results[0] ?? { ok: false, available: [] };
  }
  if (Array.isArray(resolved.allOf)) {
    const results = resolved.allOf.map((branch) => schemaHasPath(branch, packetPath, rootSchema));
    return results.some((result) => result.ok) ? { ok: true, available: [] } : results[0] ?? { ok: false, available: [] };
  }
  if (resolved.type === "array" && resolved.items !== undefined) {
    const [, ...rest] = /^\d+$/.test(packetPath[0] ?? "") ? packetPath : ["", ...packetPath];
    return schemaHasPath(resolved.items, rest, rootSchema);
  }
  const properties = isPlainRecord(resolved.properties) ? resolved.properties : {};
  const [head, ...rest] = packetPath;
  if (!head || !(head in properties)) {
    return { ok: false, available: Object.keys(properties) };
  }
  return schemaHasPath(properties[head], rest, rootSchema);
}

function resolveJsonSchemaRef(schema: unknown, rootSchema: unknown): unknown {
  if (!isPlainRecord(schema) || typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) {
    return schema;
  }
  return schema.$ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((value, segment) => isPlainRecord(value) ? value[segment] : undefined, rootSchema) ?? schema;
}

async function hashToolSource(toolDir: string): Promise<string> {
  const candidates = [
    path.join(toolDir, "src", "index.ts"),
    path.join(toolDir, "run.mjs"),
  ];
  const hash = createHash("sha256");
  let found = false;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    found = true;
    hash.update(toProjectPath(toolDir, candidate));
    hash.update("\0");
    hash.update(await readFile(candidate));
    hash.update("\0");
  }
  if (!found) {
    hash.update("no-source");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function createDoctorDiagnostic(
  diagnostic: Omit<DoctorDiagnostic, "instance_id">,
): DoctorDiagnostic {
  return {
    ...diagnostic,
    instance_id: `sha256:${createHash("sha256").update(JSON.stringify({
      id: diagnostic.id,
      target: diagnostic.target,
      location: diagnostic.location,
      evidence: diagnostic.evidence,
    })).digest("hex")}`,
  };
}

export function renderDoctorResult(result: DoctorReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}doctor${t.reset}  ${t.dim}${result.summary.errors} error(s), ${result.summary.warnings} warning(s)${t.reset}`,
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`  ${statusIcon(diagnostic.severity === "error" ? "failure" : "unverified", t)}  ${diagnostic.id}  ${t.dim}${diagnostic.location.path}${t.reset}`);
    lines.push(`     ${diagnostic.message}`);
  }
  lines.push("");
  return lines.join("\n");
}

const DOCTOR_DIAGNOSTIC_EXPLANATIONS: Readonly<Record<string, {
  readonly title: string;
  readonly severity: "error" | "warning" | "info";
  readonly explanation: string;
  readonly repair: string;
}>> = {
  "runx.tool.manifest.legacy_format": {
    title: "Legacy tool.yaml is no longer supported",
    severity: "error",
    explanation: "Runx v1 resolves tools from manifest.json generated or normalized by the authoring pipeline. A remaining tool.yaml means there are two potential sources of truth.",
    repair: "Run runx tool migrate <tool-dir>, review the generated manifest.json and run.mjs, then re-run runx doctor.",
  },
  "runx.tool.manifest.invalid": {
    title: "Tool manifest is invalid",
    severity: "error",
    explanation: "The resolver could not validate manifest.json, so the tool is not safe to list, compose, or execute.",
    repair: "Repair the manifest or rebuild it from src/index.ts with runx tool build <tool-dir>.",
  },
  "runx.tool.manifest.build_failed": {
    title: "Tool build failed",
    severity: "error",
    explanation: "The dev loop runs tool build before fixtures so generated manifests and shims are fresh.",
    repair: "Run the reported command manually, fix the tool source or manifest, then re-run runx dev.",
  },
  "runx.tool.manifest.stale": {
    title: "Tool manifest is stale",
    severity: "error",
    explanation: "manifest.json is the checked-in runtime contract. Its hashes must match the source and schema fields reviewers see in the same PR.",
    repair: "Run runx tool build <tool-dir> and commit the regenerated manifest.",
  },
  "runx.tool.fixture.missing": {
    title: "Tool has no deterministic fixture",
    severity: "error",
    explanation: "Every first-party tool needs at least one repo-visible deterministic fixture so humans and agents can see how to invoke it and runx dev can prove it still works.",
    repair: "Add tools/<namespace>/<name>/fixtures/<case>.yaml with target.kind: tool, inputs, and an output assertion.",
  },
  "runx.skill.profile.invalid": {
    title: "Skill execution profile is invalid",
    severity: "error",
    explanation: "X.yaml is the runx execution profile layered on top of SKILL.md. The X stands for execution. If it does not validate, runx cannot reliably compose the skill.",
    repair: "Fix the YAML and schema error reported by doctor.",
  },
  "runx.skill.fixture.missing": {
    title: "Skill has no harness coverage",
    severity: "error",
    explanation: "A runx-extended skill needs at least one executable example. Inline harness.cases in X.yaml and fixture files both count because they give humans and agents a replayable contract.",
    repair: "Add a focused harness.cases entry or a fixture that proves the intended success or stop condition, then re-run runx harness and runx doctor.",
  },
  "runx.skill.lock.stale": {
    title: "Official skills lock is stale",
    severity: "error",
    explanation: "official-skills.lock.json is checked-in generated metadata for first-party skills. If it drifts from SKILL.md or X.yaml, downstream consumers see an old catalog contract.",
    repair: "Run node scripts/generate-official-lock.mjs and commit the refreshed lockfile.",
  },
  "runx.structure.file_budget.exceeded": {
    title: "File exceeded structural line budget",
    severity: "error",
    explanation: "The cleanup only holds if the known monolith files stay below explicit budgets. When one crosses the line again, it means a real seam should be cut instead of appending more branches.",
    repair: "Split the file along an owning runtime or command boundary until it is back under budget, then re-run runx doctor.",
  },
  "runx.structure.cross_package_reach_in": {
    title: "Cross-package src reach-in is forbidden",
    severity: "error",
    explanation: "Workspace packages are only real boundaries if imports go through the declared package surface. Relative reaches into another package's src tree bypass ownership, exports, and publish shape.",
    repair: "Import through the owning package boundary or move the shared code to the package that owns it. Do not reference ../other-package/src paths.",
  },
  "runx.chain.context.path_invalid": {
    title: "Chain context path is invalid",
    severity: "error",
    explanation: "A chain context reference points at a producer output path that does not exist according to the producer packet schema.",
    repair: "Use the producer step id, emitted output name, mandatory data segment, and a valid property inside the packet.",
  },
  "runx.chain.context.schema_missing": {
    title: "Chain context producer has no packet schema",
    severity: "warning",
    explanation: "Doctor can verify topology but cannot type-check the referenced data path without a declared packet schema.",
    repair: "Add artifacts.packet for a single emitted artifact, artifacts.packets.<emit> for named emits, or output.packet metadata for tools.",
  },
  "runx.packet.ref.missing": {
    title: "Packet glob matched no files",
    severity: "error",
    explanation: "package.json runx.packets declares packet artifacts that do not exist, so packet assertions and chain validation cannot resolve them.",
    repair: "Fix the glob or build the packet artifacts.",
  },
  "runx.packet.id.collision": {
    title: "Packet ID collision",
    severity: "error",
    explanation: "Two schemas declare the same immutable packet id with different canonical hashes.",
    repair: "Rename one packet id or bump the version segment.",
  },
};

export function listDoctorDiagnostics(): Readonly<Record<string, unknown>> {
  return {
    schema: "runx.doctor.diagnostics.v1",
    diagnostics: Object.entries(DOCTOR_DIAGNOSTIC_EXPLANATIONS).map(([id, value]) => ({ id, ...value })),
  };
}

export function explainDoctorDiagnostic(id: string): Readonly<Record<string, unknown>> {
  const diagnostic = DOCTOR_DIAGNOSTIC_EXPLANATIONS[id];
  return diagnostic
    ? { schema: "runx.doctor.explain.v1", status: "success", id, ...diagnostic }
    : { schema: "runx.doctor.explain.v1", status: "failure", id, message: `Unknown diagnostic id ${id}.` };
}

export function renderDoctorDiagnosticList(result: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.filter(isPlainRecord) : [];
  const lines = ["", `  ${t.bold}doctor diagnostics${t.reset}  ${t.dim}${diagnostics.length} known${t.reset}`];
  for (const diagnostic of diagnostics) {
    lines.push(`  ${String(diagnostic.id).padEnd(42)} ${t.dim}${String(diagnostic.severity)}${t.reset}  ${String(diagnostic.title)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDoctorDiagnosticExplanation(result: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  if (result.status !== "success") {
    return `\n  ${statusIcon("failure", t)}  ${String(result.message)}\n\n`;
  }
  return renderKeyValue(
    String(result.id),
    "success",
    [
      ["severity", String(result.severity)],
      ["title", String(result.title)],
      ["why", String(result.explanation)],
      ["repair", String(result.repair)],
    ],
    t,
  );
}

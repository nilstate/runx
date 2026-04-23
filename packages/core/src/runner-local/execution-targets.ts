import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLocalSkillProfile } from "../config/index.js";
import {
  extractSkillQualityProfile,
  parseGraphYaml,
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  parseToolManifestJson,
  validateGraph,
  validateRunnerManifest,
  validateSkill,
  validateSkillArtifactContract,
  validateSkillSource,
  validateToolManifest,
  type ExecutionGraph,
  type GraphStep,
  type SkillRunnerDefinition,
  type ValidatedSkill,
  type ValidatedTool,
} from "../parser/index.js";
import type { RegistryStore } from "../registry/index.js";

import { defaultRegistrySkillCacheDir, isRegistryRef, materializeRegistrySkill } from "./registry-resolver.js";

const executionTargetsModuleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface ResolvedRunnerSelection {
  readonly skill: ValidatedSkill;
  readonly selectedRunnerName?: string;
}

export interface ResolvedSkillReference {
  readonly requestedPath: string;
  readonly skillPath: string;
  readonly skillDirectory: string;
}

interface ResolvedToolReference {
  readonly manifestPath: string;
}

interface SkillEnvironment {
  readonly name: string;
  readonly body: string;
}

export async function resolveSkillRunner(
  skill: ValidatedSkill,
  skillPath: string,
  runnerName: string | undefined,
): Promise<ResolvedRunnerSelection> {
  const profile = await resolveLocalSkillProfile(skillPath, skill.name);
  const profileDocument = profile.profileDocument;
  if (!profileDocument) {
    if (!runnerName) {
      return { skill };
    }
    throw new Error(`Runner '${runnerName}' requested but no execution profile was found for skill '${skill.name}'.`);
  }

  const manifest = validateRunnerManifest(parseRunnerManifestYaml(profileDocument));
  if (manifest.skill && manifest.skill !== skill.name) {
    throw new Error(`Runner manifest skill '${manifest.skill}' does not match skill '${skill.name}'.`);
  }

  const selectedRunnerName = runnerName ?? defaultRunnerName(manifest.runners);
  if (!selectedRunnerName) {
    return { skill };
  }

  const runner = manifest.runners[selectedRunnerName];
  if (!runner) {
    throw new Error(`Runner '${selectedRunnerName}' is not defined for skill '${skill.name}'.`);
  }

  return {
    skill: applyRunner(skill, runner),
    selectedRunnerName,
  };
}

export async function resolveSkillReference(skillPath: string): Promise<ResolvedSkillReference> {
  const requestedPath = path.resolve(skillPath);
  if (!(await pathExists(requestedPath))) {
    throw new Error(`Skill package not found: ${requestedPath}`);
  }
  const referenceStat = await stat(requestedPath);

  if (referenceStat.isDirectory()) {
    const skillMarkdownPath = path.join(requestedPath, "SKILL.md");
    if (!(await pathExists(skillMarkdownPath))) {
      throw new Error(`Skill package '${requestedPath}' is missing SKILL.md.`);
    }
    return {
      requestedPath,
      skillPath: skillMarkdownPath,
      skillDirectory: requestedPath,
    };
  }

  const skillDirectory = path.dirname(requestedPath);
  const skillFileName = path.basename(requestedPath).toLowerCase();
  if (skillFileName !== "skill.md") {
    throw new Error(
      `Skill references must point to a skill package directory or SKILL.md. Flat markdown files are not supported: ${requestedPath}`,
    );
  }
  return {
    requestedPath,
    skillPath: requestedPath,
    skillDirectory,
  };
}

export function materializeInlineGraph(skill: ValidatedSkill): ExecutionGraph {
  if (!skill.source.chain) {
    throw new Error(`Skill '${skill.name}' does not declare an inline chain.`);
  }
  return {
    ...skill.source.chain,
    name: skill.name,
  };
}

export async function resolveGraphExecution(options: {
  readonly graphPath?: string;
  readonly graph?: ExecutionGraph;
  readonly graphDirectory?: string;
}): Promise<{
  readonly graph: ExecutionGraph;
  readonly graphDirectory: string;
  readonly resolvedGraphPath?: string;
}> {
  if (options.graph) {
    return {
      graph: options.graph,
      graphDirectory: path.resolve(options.graphDirectory ?? process.cwd()),
    };
  }
  if (!options.graphPath) {
    throw new Error("runLocalGraph requires graphPath or graph.");
  }
  const resolvedGraphPath = path.resolve(options.graphPath);
  return {
    graph: validateGraph(parseGraphYaml(await readFile(resolvedGraphPath, "utf8"))),
    graphDirectory: path.dirname(resolvedGraphPath),
    resolvedGraphPath,
  };
}

export async function loadGraphStepExecutables(
  graph: ExecutionGraph,
  graphDirectory: string,
  registryStore?: RegistryStore,
  skillCacheDir?: string,
): Promise<ReadonlyMap<string, ValidatedSkill>> {
  const skills = new Map<string, ValidatedSkill>();
  for (const step of graph.steps) {
    if (step.skill) {
      const resolvedPath = await resolveGraphStepSkillPath(step.skill, graphDirectory, registryStore, skillCacheDir);
      skills.set(step.id, await loadValidatedSkill(resolvedPath, step.runner));
      continue;
    }
    if (step.tool) {
      skills.set(step.id, await loadValidatedTool(step.tool, graphDirectory));
    }
  }
  return skills;
}

export async function resolveGraphStepExecution(options: {
  readonly step: GraphStep;
  readonly graphDirectory: string;
  readonly graphStepCache: ReadonlyMap<string, ValidatedSkill>;
  readonly skillEnvironment?: SkillEnvironment;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
}): Promise<{
  readonly skill: ValidatedSkill;
  readonly skillPath: string;
  readonly reference: string;
}> {
  if (options.step.skill) {
    const resolvedPath = await resolveGraphStepSkillPath(
      options.step.skill,
      options.graphDirectory,
      options.registryStore,
      options.skillCacheDir,
    );
    return {
      skill:
        options.graphStepCache.get(options.step.id)
        ?? (await loadValidatedSkill(resolvedPath, options.step.runner)),
      skillPath: resolvedPath,
      reference: options.step.skill,
    };
  }

  if (options.step.tool) {
    const resolvedTool = await resolveToolReference(options.step.tool, options.graphDirectory);
    return {
      skill: options.graphStepCache.get(options.step.id) ?? (await loadValidatedTool(options.step.tool, options.graphDirectory)),
      skillPath: resolvedTool.manifestPath,
      reference: options.step.tool,
    };
  }

  if (!options.step.run) {
    throw new Error(`Chain step '${options.step.id}' is missing skill, tool, or run.`);
  }

  return {
    skill: buildInlineGraphStepSkill(options.step, options.skillEnvironment),
    skillPath: `inline:${options.step.id}`,
    reference: `run:${String(options.step.run.type)}`,
  };
}

export function buildInlineGraphStepSkill(
  step: GraphStep,
  skillEnvironment?: SkillEnvironment,
): ValidatedSkill {
  if (!step.run) {
    throw new Error(`Chain step '${step.id}' is missing an inline run definition.`);
  }
  const body = composeInlineStepBody(skillEnvironment?.body, step);
  return {
    name: `${skillEnvironment?.name ?? "graph"}.${step.id}`,
    description: step.instructions,
    body,
    source: validateSkillSource(step.run),
    inputs: {},
    retry: step.retry,
    idempotency: step.idempotencyKey ? { key: step.idempotencyKey } : undefined,
    mutating: step.mutating,
    artifacts: validateSkillArtifactContract(step.artifacts, `steps.${step.id}.artifacts`),
    qualityProfile: extractSkillQualityProfile(body),
    allowedTools: step.allowedTools,
    runx: step.allowedTools ? { allowed_tools: step.allowedTools } : undefined,
    raw: {
      frontmatter: {},
      rawFrontmatter: "",
      body,
    },
  };
}

async function loadValidatedSkill(skillPath: string, runner?: string): Promise<ValidatedSkill> {
  const resolvedSkill = await resolveSkillReference(skillPath);
  const rawSkill = parseSkillMarkdown(await readFile(resolvedSkill.skillPath, "utf8"));
  const selection = await resolveSkillRunner(
    validateSkill(rawSkill, { mode: "strict" }),
    resolvedSkill.skillPath,
    runner,
  );
  return selection.skill;
}

async function loadValidatedTool(toolName: string, searchFromDirectory: string): Promise<ValidatedSkill> {
  const resolvedTool = await resolveToolReference(toolName, searchFromDirectory);
  const manifestContents = await readFile(resolvedTool.manifestPath, "utf8");
  const tool = validateToolManifest(parseToolManifestJson(manifestContents));
  return validatedToolToExecutableSkill(tool);
}

function validatedToolToExecutableSkill(tool: ValidatedTool): ValidatedSkill {
  return {
    name: tool.name,
    description: tool.description,
    body: tool.description ?? "",
    source: tool.source,
    inputs: tool.inputs,
    risk: tool.risk,
    runtime: tool.runtime,
    retry: tool.retry,
    idempotency: tool.idempotency,
    mutating: tool.mutating,
    artifacts: tool.artifacts,
    runx: tool.runx,
    raw: {
      frontmatter: {},
      rawFrontmatter: "",
      body: tool.description ?? "",
    },
  };
}

async function resolveGraphStepSkillPath(
  stepSkill: string,
  graphDirectory: string,
  registryStore: RegistryStore | undefined,
  skillCacheDir: string | undefined,
): Promise<string> {
  if (isRegistryRef(stepSkill)) {
    if (!registryStore) {
      throw new Error(
        `Registry ref '${stepSkill}' used in graph step, but no registry store is configured. Pass registryStore to runLocalGraph, or set RUNX_REGISTRY_URL / RUNX_REGISTRY_DIR to a local registry path.`,
      );
    }
    const materialized = await materializeRegistrySkill({
      ref: stepSkill,
      store: registryStore,
      cacheDir: skillCacheDir ?? defaultRegistrySkillCacheDir(),
    });
    return materialized.skillDirectory;
  }
  return path.resolve(graphDirectory, stepSkill);
}

function defaultRunnerName(runners: Readonly<Record<string, SkillRunnerDefinition>>): string | undefined {
  const defaults = Object.values(runners).filter((runner) => runner.default);
  if (defaults.length > 1) {
    throw new Error(`Runner manifest declares multiple default runners: ${defaults.map((runner) => runner.name).join(", ")}.`);
  }
  return defaults[0]?.name;
}

function applyRunner(skill: ValidatedSkill, runner: SkillRunnerDefinition): ValidatedSkill {
  return {
    ...skill,
    source: runner.source,
    inputs: {
      ...skill.inputs,
      ...runner.inputs,
    },
    auth: runner.auth ?? skill.auth,
    risk: runner.risk ?? skill.risk,
    runtime: runner.runtime ?? skill.runtime,
    retry: runner.retry ?? skill.retry,
    idempotency: runner.idempotency ?? skill.idempotency,
    mutating: runner.mutating ?? skill.mutating,
    artifacts: runner.artifacts ?? skill.artifacts,
    allowedTools: runner.allowedTools ?? skill.allowedTools,
    execution: runner.execution ?? skill.execution,
    runx: runner.runx ?? skill.runx,
  };
}

async function resolveToolReference(toolName: string, searchFromDirectory: string): Promise<ResolvedToolReference> {
  const segments = toolName.split(".").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`Tool '${toolName}' must include a namespace, for example fs.read.`);
  }

  const searchRoots = await resolveToolRoots(searchFromDirectory);
  for (const root of searchRoots) {
    const manifestPath = path.join(root, ...segments, "manifest.json");
    if (await pathExists(manifestPath)) {
      return { manifestPath };
    }
  }

  throw new Error(`Tool '${toolName}' was not found in configured tool roots.`);
}

async function resolveToolRoots(searchFromDirectory: string): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  let current = path.resolve(searchFromDirectory);

  while (true) {
    const candidate = path.join(current, ".runx", "tools");
    if (!seen.has(candidate) && await isDirectory(candidate)) {
      roots.push(candidate);
      seen.add(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (const builtinRoot of await resolveBuiltinToolRoots()) {
    if (!seen.has(builtinRoot)) {
      roots.push(builtinRoot);
      seen.add(builtinRoot);
    }
  }

  return roots;
}

async function resolveBuiltinToolRoots(): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  const envRoots = (process.env.RUNX_TOOL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => path.resolve(value));

  for (const envRoot of envRoots) {
    if (!seen.has(envRoot) && await isDirectory(envRoot)) {
      roots.push(envRoot);
      seen.add(envRoot);
    }
  }

  let current = executionTargetsModuleDirectory;
  while (true) {
    const candidate = path.join(current, "tools");
    if (!seen.has(candidate) && await isDirectory(candidate)) {
      roots.push(candidate);
      seen.add(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function composeInlineStepBody(skillBody: string | undefined, step: GraphStep): string {
  const parts = [
    skillBody?.trim(),
    step.instructions?.trim(),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));
  return parts.join("\n\n");
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLocalSkillProfile } from "@runxhq/core/config";
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
} from "@runxhq/core/parser";
import type { RegistryStore } from "@runxhq/core/registry";
import { resolveCatalogTool, type ToolCatalogAdapter } from "@runxhq/runtime-local/tool-catalogs";

import { defaultRegistrySkillCacheDir, isRegistryRef, materializeRegistrySkill, parseRegistryRef, type ParsedRegistryRef } from "./registry-resolver.js";

export interface OfficialSkillResolver {
  resolve(ref: ParsedRegistryRef): Promise<string | undefined>;
}

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
  readonly referencePath: string;
  readonly skillDirectory: string;
  readonly tool?: ValidatedTool;
}

export interface ResolvedToolExecutionTarget {
  readonly referencePath: string;
  readonly skillDirectory: string;
  readonly skill: ValidatedSkill;
}

interface SkillEnvironment {
  readonly name: string;
  readonly body: string;
}

interface ToolResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly toolRoots?: readonly string[];
  readonly toolCatalogAdapters?: readonly ToolCatalogAdapter[];
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
  if (!skill.source.graph) {
    throw new Error(`Skill '${skill.name}' does not declare an inline graph.`);
  }
  return {
    ...skill.source.graph,
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
  toolCatalogAdapters?: readonly ToolCatalogAdapter[],
  officialSkillResolver?: OfficialSkillResolver,
): Promise<ReadonlyMap<string, ValidatedSkill>> {
  const skills = new Map<string, ValidatedSkill>();
  for (const step of graph.steps) {
    if (step.skill) {
      const resolvedPath = await resolveGraphStepSkillPath(step.skill, graphDirectory, registryStore, skillCacheDir, officialSkillResolver);
      skills.set(step.id, await loadValidatedSkill(resolvedPath, step.runner));
      continue;
    }
    if (step.tool) {
      skills.set(step.id, await loadValidatedTool(step.tool, graphDirectory, { toolCatalogAdapters }));
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
  readonly toolCatalogAdapters?: readonly ToolCatalogAdapter[];
  readonly officialSkillResolver?: OfficialSkillResolver;
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
      options.officialSkillResolver,
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
    const resolvedTool = await resolveToolReference(options.step.tool, options.graphDirectory, {
      toolCatalogAdapters: options.toolCatalogAdapters,
    });
    return {
      skill: options.graphStepCache.get(options.step.id) ?? (await loadValidatedTool(options.step.tool, options.graphDirectory, {
        toolCatalogAdapters: options.toolCatalogAdapters,
      })),
      skillPath: resolvedTool.referencePath,
      reference: options.step.tool,
    };
  }

  if (!options.step.run) {
    throw new Error(`Graph step '${options.step.id}' is missing skill, tool, or run.`);
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
    throw new Error(`Graph step '${step.id}' is missing an inline run definition.`);
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

async function loadValidatedTool(
  toolName: string,
  searchFromDirectory: string,
  options: ToolResolutionOptions = {},
): Promise<ValidatedSkill> {
  return (await resolveToolExecutionTarget(toolName, searchFromDirectory, options)).skill;
}

export async function resolveToolExecutionTarget(
  toolName: string,
  searchFromDirectory: string,
  options: ToolResolutionOptions = {},
): Promise<ResolvedToolExecutionTarget> {
  const resolvedTool = await resolveToolReference(toolName, searchFromDirectory, options);
  const tool = resolvedTool.tool
    ?? validateToolManifest(parseToolManifestJson(await readFile(resolvedTool.referencePath, "utf8")));
  return {
    referencePath: resolvedTool.referencePath,
    skillDirectory: resolvedTool.skillDirectory,
    skill: validatedToolToExecutableSkill(tool),
  };
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
  officialSkillResolver?: OfficialSkillResolver,
): Promise<string> {
  if (isRegistryRef(stepSkill)) {
    const parsed = parseRegistryRef(stepSkill);
    if (officialSkillResolver) {
      const resolved = await officialSkillResolver.resolve(parsed);
      if (resolved) {
        return resolved;
      }
    }
    if (!registryStore) {
      throw new Error(
        `Registry ref '${stepSkill}' used in graph step, but no registry store or official-skill resolver is configured. Pass registryStore or officialSkillResolver to runLocalGraph, or set RUNX_REGISTRY_URL / RUNX_REGISTRY_DIR to a local registry path.`,
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

async function resolveToolReference(
  toolName: string,
  searchFromDirectory: string,
  options: ToolResolutionOptions = {},
): Promise<ResolvedToolReference> {
  const segments = toolName.split(".").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`Tool '${toolName}' must include a namespace, for example fs.read.`);
  }

  const searchRoots = await resolveToolRoots(searchFromDirectory, options);
  for (const root of searchRoots) {
    const manifestPath = path.join(root, ...segments, "manifest.json");
    if (await pathExists(manifestPath)) {
      return {
        referencePath: manifestPath,
        skillDirectory: path.dirname(manifestPath),
      };
    }
  }

  const catalogTool = await resolveCatalogTool(options.toolCatalogAdapters ?? [], toolName, {
    env: options.env,
    searchFromDirectory,
  });
  if (catalogTool) {
    return {
      referencePath: catalogTool.referencePath,
      skillDirectory: catalogTool.skillDirectory,
      tool: catalogTool.tool,
    };
  }

  throw new Error(`Tool '${toolName}' was not found in configured tool roots.`);
}

async function resolveToolRoots(
  searchFromDirectory: string,
  options: ToolResolutionOptions = {},
): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const root of options.toolRoots ?? []) {
    const resolvedRoot = path.resolve(root);
    if (!seen.has(resolvedRoot) && await isDirectory(resolvedRoot)) {
      roots.push(resolvedRoot);
      seen.add(resolvedRoot);
    }
  }

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

  for (const builtinRoot of await resolveBuiltinToolRoots(options.env)) {
    if (!seen.has(builtinRoot)) {
      roots.push(builtinRoot);
      seen.add(builtinRoot);
    }
  }

  return roots;
}

async function resolveBuiltinToolRoots(env: NodeJS.ProcessEnv = process.env): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  const envRoots = (env.RUNX_TOOL_ROOTS ?? "")
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

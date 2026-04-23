import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePathFromUserInput, resolveRunxWorkspaceBase } from "@runxhq/core/config";
import { parseToolManifestJson, validateToolManifest } from "@runxhq/core/parser";

import {
  isPlainRecord,
  safeReadDir,
  sha256Stable,
  toProjectPath,
  writeJsonFile,
} from "../authoring-utils.js";
import { statusIcon, theme } from "../ui.js";
import { parse as parseYaml } from "yaml";

export interface ToolCommandArgs {
  readonly toolAction?: "build" | "migrate";
  readonly toolPath?: string;
  readonly toolAll: boolean;
}

export interface ToolBuildReport {
  readonly schema: "runx.tool.build.v1";
  readonly status: "success" | "failure";
  readonly built: readonly {
    readonly path: string;
    readonly manifest: string;
    readonly source_hash: string;
    readonly schema_hash: string;
  }[];
  readonly errors: readonly string[];
}

export interface ToolMigrateReport {
  readonly schema: "runx.tool.migrate.v1";
  readonly status: "success" | "failure";
  readonly migrated: readonly {
    readonly path: string;
    readonly manifest: string;
  }[];
  readonly errors: readonly string[];
}

export async function handleToolBuildCommand(parsed: ToolCommandArgs, env: NodeJS.ProcessEnv): Promise<ToolBuildReport> {
  const root = resolveRunxWorkspaceBase(env);
  const toolDirs = parsed.toolAll
    ? await discoverToolDirectories(root)
    : [resolvePathFromUserInput(parsed.toolPath ?? "", env)];
  const built: {
    readonly path: string;
    readonly manifest: string;
    readonly source_hash: string;
    readonly schema_hash: string;
  }[] = [];
  const errors: string[] = [];
  for (const toolDir of toolDirs) {
    try {
      const result = await buildToolManifest(root, toolDir);
      built.push(result);
    } catch (error) {
      errors.push(`${toProjectPath(root, toolDir)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    schema: "runx.tool.build.v1",
    status: errors.length > 0 ? "failure" : "success",
    built,
    errors,
  };
}

export async function handleToolMigrateCommand(parsed: ToolCommandArgs, env: NodeJS.ProcessEnv): Promise<ToolMigrateReport> {
  const root = resolveRunxWorkspaceBase(env);
  const toolDirs = parsed.toolAll
    ? await discoverLegacyToolDirectories(root)
    : [resolvePathFromUserInput(parsed.toolPath ?? "", env)];
  const migrated: {
    readonly path: string;
    readonly manifest: string;
  }[] = [];
  const errors: string[] = [];
  for (const toolDir of toolDirs) {
    try {
      const yamlPath = path.join(toolDir, "tool.yaml");
      const manifestPath = path.join(toolDir, "manifest.json");
      const raw = parseYaml(await readFile(yamlPath, "utf8")) as unknown;
      if (!isPlainRecord(raw)) {
        throw new Error("tool.yaml must parse to an object.");
      }
      await writeJsonFile(manifestPath, raw);
      await rm(yamlPath, { force: true });
      await buildToolManifest(root, toolDir);
      migrated.push({
        path: toProjectPath(root, toolDir),
        manifest: toProjectPath(root, manifestPath),
      });
    } catch (error) {
      errors.push(`${toProjectPath(root, toolDir)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    schema: "runx.tool.migrate.v1",
    status: errors.length > 0 ? "failure" : "success",
    migrated,
    errors,
  };
}

export function renderToolCommandResult(result: ToolBuildReport | ToolMigrateReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const count = "built" in result ? result.built.length : result.migrated.length;
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}${"built" in result ? "tool build" : "tool migrate"}${t.reset}  ${t.dim}${count} tool(s)${t.reset}`,
  ];
  for (const error of result.errors) {
    lines.push(`  ${t.red}${error}${t.reset}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function buildToolManifest(root: string, toolDir: string): Promise<ToolBuildReport["built"][number]> {
  const manifestPath = path.join(toolDir, "manifest.json");
  const authored = await loadAuthoredToolDefinition(toolDir);
  if (!existsSync(manifestPath) && !authored) {
    throw new Error("missing manifest.json");
  }
  const raw = authored ?? JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isPlainRecord(raw)) {
    throw new Error("manifest.json must be an object.");
  }
  if (authored) {
    await writeAuthoredToolShim(toolDir);
  }
  const sourceHash = await hashToolSource(toolDir);
  const output = isPlainRecord(raw.output)
    ? raw.output
    : normalizeToolOutput(raw);
  const schemaHash = sha256Stable({
    inputs: raw.inputs,
    output,
    artifacts: isPlainRecord(raw.runx) ? raw.runx.artifacts : undefined,
  });
  const normalized = {
    schema: "runx.tool.manifest.v1",
    ...raw,
    runtime: isPlainRecord(raw.runtime)
      ? raw.runtime
      : {
          command: isPlainRecord(raw.source) ? raw.source.command ?? "node" : "node",
          args: isPlainRecord(raw.source) ? raw.source.args ?? ["./run.mjs"] : ["./run.mjs"],
        },
    output,
    source_hash: sourceHash,
    schema_hash: schemaHash,
    toolkit_version: "0.0.0",
  };
  validateToolManifest(parseToolManifestJson(JSON.stringify(normalized)));
  await writeJsonFile(manifestPath, normalized);
  return {
    path: toProjectPath(root, toolDir),
    manifest: toProjectPath(root, manifestPath),
    source_hash: sourceHash,
    schema_hash: schemaHash,
  };
}

async function loadAuthoredToolDefinition(toolDir: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const sourcePath = path.join(toolDir, "src", "index.ts");
  if (!existsSync(sourcePath)) {
    return undefined;
  }
  try {
    const imported = await import(`${pathToFileURL(sourcePath).href}?runx_build=${Date.now()}`);
    const tool = imported.default;
    if (!isPlainRecord(tool) || typeof tool.name !== "string") {
      return undefined;
    }
    const output = isPlainRecord(tool.output) ? tool.output : undefined;
    const wrapAs = typeof output?.wrap_as === "string" ? output.wrap_as : undefined;
    return {
      name: tool.name,
      version: typeof tool.version === "string" ? tool.version : undefined,
      description: typeof tool.description === "string" ? tool.description : undefined,
      source: isPlainRecord(tool.source)
        ? tool.source
        : {
            type: "cli-tool",
            command: "node",
            args: ["./run.mjs"],
          },
      inputs: serializeAuthoringInputs(isPlainRecord(tool.inputs) ? tool.inputs : {}),
      output: output
        ? {
            ...(typeof output.packet === "string" ? { packet: output.packet } : {}),
            ...(wrapAs ? { wrap_as: wrapAs } : {}),
          }
        : undefined,
      scopes: Array.isArray(tool.scopes) ? tool.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      runx: wrapAs ? { artifacts: { wrap_as: wrapAs } } : undefined,
    };
  } catch {
    return undefined;
  }
}

function serializeAuthoringInputs(inputs: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, parser]) => {
      const manifest = isPlainRecord(parser) && isPlainRecord(parser.manifest)
        ? parser.manifest
        : { type: "json", required: !(isPlainRecord(parser) && parser.optional === true) };
      return [name, manifest];
    }),
  );
}

async function writeAuthoredToolShim(toolDir: string): Promise<void> {
  await writeFile(
    path.join(toolDir, "run.mjs"),
    [
      "#!/usr/bin/env node",
      "import { register } from \"node:module\";",
      "import { pathToFileURL } from \"node:url\";",
      "register(\"tsx/esm\", pathToFileURL(\"./\"));",
      "const tool = (await import(\"./src/index.ts\")).default;",
      "await tool.main();",
      "",
    ].join("\n"),
  );
}

function normalizeToolOutput(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const runx = isPlainRecord(raw.runx) ? raw.runx : undefined;
  const artifacts = isPlainRecord(runx?.artifacts) ? runx.artifacts : undefined;
  if (typeof artifacts?.wrap_as === "string") {
    return { wrap_as: artifacts.wrap_as };
  }
  if (isPlainRecord(artifacts?.named_emits)) {
    return { named_emits: artifacts.named_emits };
  }
  return {};
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

export async function discoverToolDirectories(root: string): Promise<readonly string[]> {
  const toolsRoot = path.join(root, "tools");
  const directories: string[] = [];
  for (const namespaceEntry of await safeReadDir(toolsRoot)) {
    if (!namespaceEntry.isDirectory()) continue;
    for (const toolEntry of await safeReadDir(path.join(toolsRoot, namespaceEntry.name))) {
      if (toolEntry.isDirectory()) {
        directories.push(path.join(toolsRoot, namespaceEntry.name, toolEntry.name));
      }
    }
  }
  return directories.sort();
}

async function discoverLegacyToolDirectories(root: string): Promise<readonly string[]> {
  return (await discoverToolDirectories(root)).filter((toolDir) => existsSync(path.join(toolDir, "tool.yaml")));
}

export function resolveToolDirFromRef(root: string, ref: string): string | undefined {
  const parts = ref.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;
  const candidate = path.join(root, "tools", ...parts);
  return existsSync(path.join(candidate, "manifest.json")) ? candidate : undefined;
}

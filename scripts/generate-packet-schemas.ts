import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

type JsonObject = Record<string, unknown>;

interface PacketContract {
  readonly packetId: string;
  readonly source: string;
  readonly schema: JsonObject;
}

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillsRoot = path.join(workspaceRoot, "skills");
const packetRoot = path.join(workspaceRoot, "dist", "packets");
const check = process.argv.includes("--check");
const contracts = new Map<string, PacketContract>();
const declarations = new Map<string, string>();
const existingById = await existingSchemas();

for (const profilePath of await findProfiles(skillsRoot)) {
  const profile = YAML.parse(await readFile(profilePath, "utf8")) as unknown;
  collectContracts(profile, path.relative(workspaceRoot, profilePath), "root");
}

for (const contract of [...contracts.values()].sort((left, right) => left.packetId.localeCompare(right.packetId))) {
  const existing = existingById.get(contract.packetId);
  if (existing && !existing.generated) continue;
  const filePath = existing?.path ?? path.join(packetRoot, `${packetFileName(contract.packetId)}.schema.json`);
  const document = `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: packetSchemaId(contract.packetId),
    "x-runx-packet-id": contract.packetId,
    "x-runx-generated-from": contract.source,
    ...contract.schema,
  }, null, 2)}\n`;
  if (check) {
    const current = await readFile(filePath, "utf8").catch(() => undefined);
    if (current !== document) {
      throw new Error(`packet schema is missing or stale: ${path.relative(workspaceRoot, filePath)}`);
    }
  } else {
    await writeFile(filePath, document, "utf8");
  }
}

const missing = [...declarations.keys()].filter(
  (packetId) => !existingById.has(packetId) && !contracts.has(packetId),
);
if (missing.length > 0) {
  throw new Error(`packet declarations have no schema contract: ${missing.join(", ")}`);
}
console.log(`${check ? "checked" : "generated"} ${declarations.size} packet contracts`);

function collectContracts(value: unknown, profile: string, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectContracts(child, profile, `${location}.${index}`));
    return;
  }
  if (!isRecord(value)) return;
  const execution = isRecord(value.run) && typeof value.run.type === "string"
    ? value.run
    : isRecord(value.source) && typeof value.source.type === "string"
      ? value.source
      : value;
  const type = execution.type;
  const outputs = isRecord(execution.outputs)
    ? execution.outputs
    : isRecord(value.outputs)
      ? value.outputs
      : undefined;
  const artifacts = isRecord(value.artifacts)
    ? value.artifacts
    : isRecord(execution.artifacts)
      ? execution.artifacts
      : undefined;
  if (type === "agent" || type === "agent-task") {
    if (!outputs || Object.keys(outputs).length === 0) {
      throw new Error(`${profile}#${location} agent runner has no declared outputs`);
    }
  }
  if (artifacts) {
    const source = `${profile}#${location}`;
    collectPacketDeclarations(artifacts, source);
    if (outputs && Object.keys(outputs).length > 0) {
      collectArtifactContracts(artifacts, outputs, source);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    collectContracts(child, profile, `${location}.${key}`);
  }
}

function collectPacketDeclarations(artifacts: JsonObject, source: string): void {
  const packetIds = [nonEmptyString(artifacts.packet)];
  if (isRecord(artifacts.packets)) {
    packetIds.push(...Object.values(artifacts.packets).map(nonEmptyString));
  }
  for (const packetId of packetIds) {
    if (!packetId) continue;
    const existing = declarations.get(packetId);
    if (!existing) declarations.set(packetId, source);
  }
}

function collectArtifactContracts(
  artifacts: JsonObject,
  outputs: JsonObject,
  source: string,
): void {
  const wrapAs = nonEmptyString(artifacts.wrap_as);
  const packet = nonEmptyString(artifacts.packet);
  if (packet) {
    if (!wrapAs) throw new Error(`${source} packet requires wrap_as`);
    register({
      packetId: packet,
      source,
      schema: objectSchema(outputs),
    });
  }
  if (!isRecord(artifacts.packets)) return;
  for (const [output, packetValue] of Object.entries(artifacts.packets)) {
    const packetId = nonEmptyString(packetValue);
    if (!packetId) throw new Error(`${source} packets.${output} must be a packet id`);
    if (!(output in outputs)) throw new Error(`${source} packets.${output} has no matching output declaration`);
    register({ packetId, source, schema: outputSchema(outputs[output]) });
  }
}

function register(contract: PacketContract): void {
  if (existingById.get(contract.packetId)?.generated === false) {
    if (!contracts.has(contract.packetId)) contracts.set(contract.packetId, contract);
    return;
  }
  const existing = contracts.get(contract.packetId);
  if (existing && JSON.stringify(existing.schema) !== JSON.stringify(contract.schema)) {
    throw new Error(`packet '${contract.packetId}' has conflicting X.yaml output contracts`);
  }
  if (!existing) contracts.set(contract.packetId, contract);
}

function objectSchema(outputs: JsonObject): JsonObject {
  const required = Object.entries(outputs)
    .filter(([, declaration]) => outputIsRequired(declaration))
    .map(([name]) => name)
    .sort();
  return {
    type: "object",
    required,
    properties: Object.fromEntries(
      Object.entries(outputs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, declaration]) => [name, outputSchema(declaration)]),
    ),
    additionalProperties: false,
  };
}

function outputIsRequired(declaration: unknown): boolean {
  return !isRecord(declaration) || declaration.required !== false;
}

function outputSchema(declaration: unknown): JsonObject {
  const type = typeof declaration === "string"
    ? declaration
    : isRecord(declaration) && typeof declaration.type === "string"
      ? declaration.type
      : "json";
  switch (type) {
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "integer": return { type: "integer" };
    case "boolean": return { type: "boolean" };
    case "array": return { type: "array" };
    case "object": return { type: "object" };
    case "json": return {};
    default: throw new Error(`unsupported agent output type '${type}'`);
  }
}

async function existingSchemas(): Promise<Map<string, { readonly path: string; readonly generated: boolean }>> {
  const schemas = new Map<string, { readonly path: string; readonly generated: boolean }>();
  for (const entry of (await readdir(packetRoot)).filter((name) => name.endsWith(".json")).sort()) {
    const filePath = path.join(packetRoot, entry);
    const value = JSON.parse(await readFile(filePath, "utf8")) as JsonObject;
    const packetId = nonEmptyString(value["x-runx-packet-id"]);
    if (!packetId) continue;
    if (schemas.has(packetId)) throw new Error(`duplicate packet schema id '${packetId}'`);
    schemas.set(packetId, {
      path: filePath,
      generated: typeof value["x-runx-generated-from"] === "string",
    });
  }
  return schemas;
}

async function findProfiles(directory: string): Promise<readonly string[]> {
  const profiles: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) profiles.push(...await findProfiles(entryPath));
    else if (entry.isFile() && entry.name === "X.yaml") profiles.push(entryPath);
  }
  return profiles.sort();
}

function packetFileName(packetId: string): string {
  return packetId.replace(/[^a-zA-Z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
}

function packetSchemaId(packetId: string): string {
  const segments = packetId.split(".").filter(Boolean);
  if (segments[0] === "runx") segments.shift();
  return `https://schemas.runx.ai/runx/${segments.join("/")}.json`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

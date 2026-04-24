import { parseRegistrySkillRef } from "./resolve.js";
import { normalizeRegistrySearchResult, type RegistrySearchResult } from "./search.js";
import type { ToolCatalogSearchResult, ToolInspectResult } from "../tool-catalogs/index.js";
import {
  validateRegistryAttestations,
  validateRegistryPublisher,
  validateRegistryTrustTier,
  type RegistryAttestation,
  type RegistryPublisher,
  type RegistrySourceMetadata,
  type RegistryTrustTier,
} from "./store.js";

export interface AcquireRegistrySkillOptions {
  readonly baseUrl: string;
  readonly installationId: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
  readonly channel?: string;
}

export interface SearchRemoteRegistryOptions {
  readonly baseUrl: string;
  readonly limit?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ReadRemoteRegistrySkillOptions {
  readonly baseUrl: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface SearchRemoteToolsOptions {
  readonly baseUrl: string;
  readonly limit?: number;
  readonly source?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ReadRemoteToolOptions {
  readonly baseUrl: string;
  readonly source?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RemoteRegistrySkillDetail {
  readonly skill_id: string;
  readonly owner: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly digest: string;
  readonly markdown: string;
  readonly profile_digest?: string;
  readonly runner_names: readonly string[];
  readonly source_type: string;
  readonly trust_tier: RegistryTrustTier;
  readonly required_scopes: readonly string[];
  readonly tags: readonly string[];
  readonly publisher: RegistryPublisher;
  readonly source_metadata?: RegistrySourceMetadata;
  readonly attestations: readonly RegistryAttestation[];
  readonly install_command: string;
  readonly run_command: string;
}

export interface ResolveRemoteRegistryRefOptions {
  readonly baseUrl: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface AcquiredRegistrySkill {
  readonly skill_id: string;
  readonly owner: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly markdown: string;
  readonly profile_document?: string;
  readonly profile_digest?: string;
  readonly runner_names: readonly string[];
  readonly trust_tier: RegistryTrustTier;
  readonly publisher: RegistryPublisher;
  readonly source_metadata?: RegistrySourceMetadata;
  readonly attestations: readonly RegistryAttestation[];
  readonly install_count: number;
}

export async function searchRemoteRegistry(
  query: string,
  options: SearchRemoteRegistryOptions,
): Promise<readonly RegistrySearchResult[]> {
  const fetchImpl = requireFetch(options.fetchImpl);
  const params = new URLSearchParams();
  if (query.trim().length > 0) {
    params.set("q", query.trim());
  }
  params.set("limit", String(options.limit ?? 20));
  const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/v1/skills?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Registry search failed for '${query}': HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    readonly status?: string;
    readonly skills?: ReadonlyArray<{
      readonly skill_id?: string;
      readonly name?: string;
      readonly description?: string;
      readonly owner?: string;
      readonly version?: string;
      readonly source_type?: string;
      readonly profile_mode?: "portable" | "profiled";
      readonly runner_names?: readonly string[];
      readonly required_scopes?: readonly string[];
      readonly tags?: readonly string[];
      readonly trust_tier?: RegistryTrustTier;
      readonly trust_signals?: RegistrySearchResult["trust_signals"];
      readonly install_command?: string;
      readonly run_command?: string;
    }>;
  };
  if (payload.status !== "success" || !Array.isArray(payload.skills)) {
    throw new Error(`Registry search returned an invalid payload for '${query}'.`);
  }
  return payload.skills.map((skill) => {
    if (
      typeof skill.skill_id !== "string"
      || typeof skill.name !== "string"
      || typeof skill.owner !== "string"
      || typeof skill.source_type !== "string"
      || (skill.profile_mode !== "portable" && skill.profile_mode !== "profiled")
      || !Array.isArray(skill.runner_names)
      || !Array.isArray(skill.required_scopes)
      || !Array.isArray(skill.tags)
      || (skill.trust_tier !== "first_party" && skill.trust_tier !== "verified" && skill.trust_tier !== "community")
      || typeof skill.install_command !== "string"
      || typeof skill.run_command !== "string"
    ) {
      throw new Error(`Registry search returned an invalid skill entry for '${query}'.`);
    }
    return normalizeRegistrySearchResult({
      skill_id: skill.skill_id,
      name: skill.name,
      summary: skill.description,
      owner: skill.owner,
      version: typeof skill.version === "string" ? skill.version : undefined,
      source_type: skill.source_type,
      trust_tier: validateRegistryTrustTier(skill.trust_tier, "remote_registry.skills[].trust_tier"),
      required_scopes: skill.required_scopes,
      tags: skill.tags,
      profile_mode: skill.profile_mode,
      runner_names: skill.runner_names,
      trust_signals: Array.isArray(skill.trust_signals) ? skill.trust_signals : undefined,
      add_command: skill.install_command,
      run_command: skill.run_command,
    });
  });
}

export async function searchRemoteTools(
  query: string,
  options: SearchRemoteToolsOptions,
): Promise<readonly ToolCatalogSearchResult[]> {
  const fetchImpl = requireFetch(options.fetchImpl);
  const params = new URLSearchParams();
  if (query.trim().length > 0) {
    params.set("q", query.trim());
  }
  if (options.source?.trim()) {
    params.set("source", options.source.trim());
  }
  params.set("limit", String(options.limit ?? 20));
  const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/v1/tools?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Remote tool search failed for '${query}': HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    readonly status?: string;
    readonly tools?: readonly ToolCatalogSearchResult[];
  };
  if (payload.status !== "success" || !Array.isArray(payload.tools)) {
    throw new Error(`Remote tool search returned an invalid payload for '${query}'.`);
  }
  return payload.tools.map(validateRemoteToolSearchResult);
}

export async function readRemoteTool(
  ref: string,
  options: ReadRemoteToolOptions,
): Promise<ToolInspectResult | undefined> {
  const fetchImpl = requireFetch(options.fetchImpl);
  const params = new URLSearchParams();
  if (options.source?.trim()) {
    params.set("source", options.source.trim());
  }
  const query = params.toString();
  const response = await fetchImpl(
    `${options.baseUrl.replace(/\/$/, "")}/v1/tools/${encodeURIComponent(ref)}${query ? `?${query}` : ""}`,
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Remote tool read failed for ${ref}: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    readonly status?: string;
    readonly tool?: ToolInspectResult;
  };
  if (payload.status !== "success" || payload.tool === undefined) {
    throw new Error(`Remote tool read returned an invalid payload for ${ref}.`);
  }
  return validateRemoteToolInspectResult(payload.tool);
}

export async function readRemoteRegistrySkill(
  skillId: string,
  options: ReadRemoteRegistrySkillOptions,
): Promise<RemoteRegistrySkillDetail | undefined> {
  const [owner, name] = splitRegistrySkillId(skillId);
  const fetchImpl = requireFetch(options.fetchImpl);
  const suffix = options.version ? `${name}@${options.version}` : name;
  const response = await fetchImpl(
    `${options.baseUrl.replace(/\/$/, "")}/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(suffix)}`,
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Registry read failed for ${skillId}: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    readonly status?: string;
    readonly skill?: {
      readonly skill_id?: string;
      readonly owner?: string;
      readonly name?: string;
      readonly description?: string;
      readonly version?: string;
      readonly digest?: string;
      readonly markdown?: string;
      readonly profile_digest?: string;
      readonly runner_names?: readonly string[];
      readonly source_type?: string;
      readonly trust_tier?: RegistryTrustTier;
      readonly required_scopes?: readonly string[];
      readonly tags?: readonly string[];
      readonly publisher?: RegistryPublisher;
      readonly source_metadata?: RegistrySourceMetadata;
      readonly attestations?: readonly RegistryAttestation[];
      readonly install_command?: string;
      readonly run_command?: string;
    };
  };
  const skill = payload.skill;
  if (
    payload.status !== "success"
    || !skill
    || typeof skill.skill_id !== "string"
    || typeof skill.owner !== "string"
    || typeof skill.name !== "string"
    || typeof skill.version !== "string"
    || typeof skill.digest !== "string"
    || typeof skill.markdown !== "string"
    || !Array.isArray(skill.runner_names)
    || typeof skill.source_type !== "string"
    || (skill.trust_tier !== "first_party" && skill.trust_tier !== "verified" && skill.trust_tier !== "community")
    || !Array.isArray(skill.required_scopes)
    || !Array.isArray(skill.tags)
    || skill.publisher === undefined
    || skill.attestations === undefined
    || typeof skill.install_command !== "string"
    || typeof skill.run_command !== "string"
  ) {
    throw new Error(`Registry read returned an invalid payload for ${skillId}.`);
  }
  return {
    skill_id: skill.skill_id,
    owner: skill.owner,
    name: skill.name,
    description: typeof skill.description === "string" ? skill.description : undefined,
    version: skill.version,
    digest: skill.digest,
    markdown: skill.markdown,
    profile_digest: typeof skill.profile_digest === "string" ? skill.profile_digest : undefined,
    runner_names: skill.runner_names,
    source_type: skill.source_type,
    trust_tier: validateRegistryTrustTier(skill.trust_tier, "remote_registry.skill.trust_tier"),
    required_scopes: skill.required_scopes,
    tags: skill.tags,
    publisher: validateRegistryPublisher(skill.publisher, "remote_registry.skill.publisher"),
    source_metadata: skill.source_metadata,
    attestations: validateRegistryAttestations(skill.attestations, "remote_registry.skill.attestations") ?? [],
    install_command: skill.install_command,
    run_command: skill.run_command,
  };
}

export async function resolveRemoteRegistryRef(
  ref: string,
  options: ResolveRemoteRegistryRefOptions,
): Promise<{ readonly skill_id: string; readonly version?: string } | undefined> {
  const parsed = parseRegistrySkillRef(ref);
  if (parsed.skillId.includes("/")) {
    return {
      skill_id: parsed.skillId,
      version: options.version ?? parsed.version,
    };
  }

  const matches = (await searchRemoteRegistry(parsed.skillId, {
    baseUrl: options.baseUrl,
    limit: 100,
    fetchImpl: options.fetchImpl,
  })).filter((candidate) => candidate.name === parsed.skillId.trim().toLowerCase());
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(`Registry ref '${parsed.skillId}' is ambiguous. Use '<owner>/<name>' instead.`);
  }
  return {
    skill_id: matches[0].skill_id,
    version: options.version ?? parsed.version ?? matches[0].version,
  };
}

export async function acquireRegistrySkill(
  skillId: string,
  options: AcquireRegistrySkillOptions,
): Promise<AcquiredRegistrySkill> {
  const [owner, name] = splitRegistrySkillId(skillId);
  const fetchImpl = requireFetch(options.fetchImpl);

  const response = await fetchImpl(
    `${options.baseUrl.replace(/\/$/, "")}/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/acquire`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        installation_id: options.installationId,
        version: options.version,
        channel: options.channel ?? "cli",
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Registry acquire failed for ${skillId}: HTTP ${response.status}`);
  }

  const payload = await response.json() as {
    readonly status?: string;
    readonly install_count?: number;
    readonly acquisition?: {
      readonly skill_id?: string;
      readonly owner?: string;
      readonly name?: string;
      readonly version?: string;
      readonly digest?: string;
      readonly markdown?: string;
      readonly profile_document?: string;
      readonly profile_digest?: string;
      readonly runner_names?: readonly string[];
      readonly trust_tier?: RegistryTrustTier;
      readonly publisher?: RegistryPublisher;
      readonly source_metadata?: RegistrySourceMetadata;
      readonly attestations?: readonly RegistryAttestation[];
    };
  };
  const acquisition = payload.acquisition;
  if (
    payload.status !== "success"
    || !acquisition
    || typeof acquisition.skill_id !== "string"
    || typeof acquisition.owner !== "string"
    || typeof acquisition.name !== "string"
    || typeof acquisition.version !== "string"
    || typeof acquisition.digest !== "string"
    || typeof acquisition.markdown !== "string"
    || !Array.isArray(acquisition.runner_names)
    || (acquisition.trust_tier !== "first_party" && acquisition.trust_tier !== "verified" && acquisition.trust_tier !== "community")
    || acquisition.publisher === undefined
    || acquisition.attestations === undefined
  ) {
    throw new Error(`Registry acquire returned an invalid payload for ${skillId}.`);
  }

  return {
    skill_id: acquisition.skill_id,
    owner: acquisition.owner,
    name: acquisition.name,
    version: acquisition.version,
    digest: acquisition.digest,
    markdown: acquisition.markdown,
    profile_document: acquisition.profile_document,
    profile_digest: acquisition.profile_digest,
    runner_names: acquisition.runner_names,
    trust_tier: validateRegistryTrustTier(acquisition.trust_tier, "remote_registry.acquisition.trust_tier"),
    publisher: validateRegistryPublisher(acquisition.publisher, "remote_registry.acquisition.publisher"),
    source_metadata: acquisition.source_metadata,
    attestations: validateRegistryAttestations(acquisition.attestations, "remote_registry.acquisition.attestations") ?? [],
    install_count: typeof payload.install_count === "number" ? payload.install_count : 0,
  };
}

function requireFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new Error("Global fetch is not available. Use Node.js 20+ or inject fetchImpl.");
  }
  return resolved;
}

function splitRegistrySkillId(skillId: string): readonly [string, string] {
  const parts = skillId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid registry skill id '${skillId}'. Expected '<owner>/<name>'.`);
  }
  return [parts[0], parts[1]];
}

function validateRemoteToolSearchResult(value: unknown): ToolCatalogSearchResult {
  const record = requireRecord(value, "remote_tools.tools[]");
  return {
    tool_id: requireString(record.tool_id, "remote_tools.tools[].tool_id"),
    name: requireString(record.name, "remote_tools.tools[].name"),
    summary: optionalString(record.summary, "remote_tools.tools[].summary"),
    source: requireString(record.source, "remote_tools.tools[].source"),
    source_label: requireString(record.source_label, "remote_tools.tools[].source_label"),
    source_type: requireString(record.source_type, "remote_tools.tools[].source_type"),
    namespace: requireString(record.namespace, "remote_tools.tools[].namespace"),
    external_name: requireString(record.external_name, "remote_tools.tools[].external_name"),
    required_scopes: requireStringArray(record.required_scopes, "remote_tools.tools[].required_scopes"),
    tags: requireStringArray(record.tags, "remote_tools.tools[].tags"),
    catalog_ref: requireString(record.catalog_ref, "remote_tools.tools[].catalog_ref"),
  };
}

function validateRemoteToolInspectResult(value: unknown): ToolInspectResult {
  const record = requireRecord(value, "remote_tools.tool");
  const inputsRecord = requireRecord(record.inputs, "remote_tools.tool.inputs");
  const inputs: Record<string, { readonly type: string; readonly required: boolean; readonly description?: string }> = {};
  for (const [name, entry] of Object.entries(inputsRecord)) {
    const input = requireRecord(entry, `remote_tools.tool.inputs.${name}`);
    inputs[name] = {
      type: requireString(input.type, `remote_tools.tool.inputs.${name}.type`),
      required: requireBoolean(input.required, `remote_tools.tool.inputs.${name}.required`),
      description: optionalString(input.description, `remote_tools.tool.inputs.${name}.description`),
    };
  }
  const provenanceRecord = requireRecord(record.provenance, "remote_tools.tool.provenance");
  return {
    ref: requireString(record.ref, "remote_tools.tool.ref"),
    name: requireString(record.name, "remote_tools.tool.name"),
    description: optionalString(record.description, "remote_tools.tool.description"),
    execution_source_type: requireString(record.execution_source_type, "remote_tools.tool.execution_source_type"),
    inputs,
    scopes: requireStringArray(record.scopes, "remote_tools.tool.scopes"),
    mutating: optionalBoolean(record.mutating, "remote_tools.tool.mutating"),
    runtime: optionalRecord(record.runtime, "remote_tools.tool.runtime"),
    risk: optionalRecord(record.risk, "remote_tools.tool.risk"),
    runx: optionalRecord(record.runx, "remote_tools.tool.runx"),
    reference_path: requireString(record.reference_path, "remote_tools.tool.reference_path"),
    skill_directory: requireString(record.skill_directory, "remote_tools.tool.skill_directory"),
    provenance: {
      origin: requireEnum(provenanceRecord.origin, "remote_tools.tool.provenance.origin", ["local", "imported"]) as "local" | "imported",
      source: optionalString(provenanceRecord.source, "remote_tools.tool.provenance.source"),
      source_label: optionalString(provenanceRecord.source_label, "remote_tools.tool.provenance.source_label"),
      source_type: optionalString(provenanceRecord.source_type, "remote_tools.tool.provenance.source_type"),
      namespace: optionalString(provenanceRecord.namespace, "remote_tools.tool.provenance.namespace"),
      external_name: optionalString(provenanceRecord.external_name, "remote_tools.tool.provenance.external_name"),
      catalog_ref: optionalString(provenanceRecord.catalog_ref, "remote_tools.tool.provenance.catalog_ref"),
      tool_id: optionalString(provenanceRecord.tool_id, "remote_tools.tool.provenance.tool_id"),
      tags: optionalStringArray(provenanceRecord.tags, "remote_tools.tool.provenance.tags"),
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, _label: string): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringArray(value, label);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireBoolean(value, label);
}

function optionalRecord(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, label);
}

function requireEnum(value: unknown, label: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return value;
}

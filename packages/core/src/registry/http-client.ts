import { parseRegistrySkillRef } from "./resolve.js";
import { normalizeRegistrySearchResult, type RegistrySearchResult } from "./search.js";

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
  readonly required_scopes: readonly string[];
  readonly tags: readonly string[];
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
      readonly required_scopes?: readonly string[];
      readonly tags?: readonly string[];
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
    || !Array.isArray(skill.required_scopes)
    || !Array.isArray(skill.tags)
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
    required_scopes: skill.required_scopes,
    tags: skill.tags,
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

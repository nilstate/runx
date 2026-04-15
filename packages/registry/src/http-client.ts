export interface AcquireRegistrySkillOptions {
  readonly baseUrl: string;
  readonly installationId: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
  readonly channel?: string;
}

export interface AcquiredRegistrySkill {
  readonly skill_id: string;
  readonly owner: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly markdown: string;
  readonly x_manifest?: string;
  readonly x_digest?: string;
  readonly runner_names: readonly string[];
  readonly install_count: number;
}

export async function acquireRegistrySkill(
  skillId: string,
  options: AcquireRegistrySkillOptions,
): Promise<AcquiredRegistrySkill> {
  const [owner, name] = splitRegistrySkillId(skillId);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Use Node.js 20+ or inject fetchImpl.");
  }

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
      readonly x_manifest?: string;
      readonly x_digest?: string;
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
    x_manifest: acquisition.x_manifest,
    x_digest: acquisition.x_digest,
    runner_names: acquisition.runner_names,
    install_count: typeof payload.install_count === "number" ? payload.install_count : 0,
  };
}

function splitRegistrySkillId(skillId: string): readonly [string, string] {
  const parts = skillId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid registry skill id '${skillId}'. Expected '<owner>/<name>'.`);
  }
  return [parts[0], parts[1]];
}

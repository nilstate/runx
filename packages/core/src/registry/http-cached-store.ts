import { errorMessage } from "../util/types.js";

import { acquireRegistrySkill, type AcquiredRegistrySkill } from "./http-client.js";
import {
  FileRegistryStore,
  type PutVersionOptions,
  type RegistrySkill,
  type RegistrySkillVersion,
  type RegistryStore,
} from "./store.js";
import { mergeRegistryAttestations } from "./trust.js";

export interface HttpCachedRegistryStoreOptions {
  readonly remoteBaseUrl: string;
  readonly installationId: string;
  readonly cache: RegistryStore;
  readonly fetchImpl?: typeof fetch;
  readonly channel?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export class HttpCachedRegistryStore implements RegistryStore {
  constructor(private readonly options: HttpCachedRegistryStoreOptions) {}

  async getVersion(skillId: string, version?: string): Promise<RegistrySkillVersion | undefined> {
    const cached = await this.options.cache.getVersion(skillId, version);
    if (cached && version) {
      return cached;
    }

    const acquired = await safeAcquire({
      skillId,
      baseUrl: this.options.remoteBaseUrl,
      installationId: this.options.installationId,
      version,
      fetchImpl: this.options.fetchImpl,
      channel: this.options.channel,
      timeoutMs: this.options.timeoutMs,
    });
    if (!acquired) {
      return cached;
    }

    const record = acquiredToRegistrySkillVersion(acquired, this.options.now?.() ?? new Date());
    return await this.options.cache.putVersion(record, { upsert: true });
  }

  async listVersions(skillId: string): Promise<readonly RegistrySkillVersion[]> {
    return await this.options.cache.listVersions(skillId);
  }

  async listSkills(): Promise<readonly RegistrySkill[]> {
    return await this.options.cache.listSkills();
  }

  async putVersion(version: RegistrySkillVersion, options?: PutVersionOptions): Promise<RegistrySkillVersion> {
    return await this.options.cache.putVersion(version, options);
  }
}

export function createHttpCachedRegistryStore(options: HttpCachedRegistryStoreOptions): RegistryStore {
  return new HttpCachedRegistryStore(options);
}

export function createDefaultHttpCachedRegistryStore(options: {
  readonly remoteBaseUrl: string;
  readonly cacheRoot: string;
  readonly installationId: string;
  readonly fetchImpl?: typeof fetch;
  readonly channel?: string;
  readonly timeoutMs?: number;
}): RegistryStore {
  return new HttpCachedRegistryStore({
    remoteBaseUrl: options.remoteBaseUrl,
    installationId: options.installationId,
    cache: new FileRegistryStore(options.cacheRoot),
    fetchImpl: options.fetchImpl,
    channel: options.channel,
    timeoutMs: options.timeoutMs,
  });
}

function acquiredToRegistrySkillVersion(
  acquired: AcquiredRegistrySkill,
  now: Date,
): RegistrySkillVersion {
  const isoNow = now.toISOString();
  return {
    skill_id: acquired.skill_id,
    owner: acquired.owner,
    name: acquired.name,
    version: acquired.version,
    digest: acquired.digest,
    markdown: acquired.markdown,
    profile_document: acquired.profile_document,
    profile_digest: acquired.profile_digest,
    runner_names: acquired.runner_names,
    source_type: "runx-registry",
    trust_tier: acquired.trust_tier,
    source_metadata: acquired.source_metadata,
    attestations: mergeRegistryAttestations(acquired.attestations),
    required_scopes: [],
    tags: [],
    publisher: acquired.publisher,
    created_at: isoNow,
    updated_at: isoNow,
  };
}

async function safeAcquire(args: {
  skillId: string;
  baseUrl: string;
  installationId: string;
  version?: string;
  fetchImpl?: typeof fetch;
  channel?: string;
  timeoutMs?: number;
}): Promise<AcquiredRegistrySkill | undefined> {
  try {
    return await acquireRegistrySkill(args.skillId, {
      baseUrl: args.baseUrl,
      installationId: args.installationId,
      version: args.version,
      fetchImpl: args.fetchImpl,
      channel: args.channel,
      timeoutMs: args.timeoutMs,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/HTTP 404/.test(message)) {
      return undefined;
    }
    throw error;
  }
}

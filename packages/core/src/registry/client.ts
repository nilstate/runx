import {
  createRegistrySkillVersion,
  type CreateRegistrySkillVersionResult,
  type IngestSkillOptions,
} from "./ingest.js";
import type { RegistryStore } from "./store.js";

export interface RegistryClient {
  readonly createSkillVersion: (
    markdown: string,
    options?: IngestSkillOptions,
  ) => Promise<CreateRegistrySkillVersionResult>;
}

export function createLocalRegistryClient(store: RegistryStore): RegistryClient {
  return {
    createSkillVersion: async (markdown, options = {}) => await createRegistrySkillVersion(store, markdown, options),
  };
}

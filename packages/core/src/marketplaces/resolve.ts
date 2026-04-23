import type { SkillSearchResult } from "./index.js";

export interface MarketplaceResolvedSkill {
  readonly markdown: string;
  readonly profileDocument?: string;
  readonly result: SkillSearchResult;
}

export interface MarketplaceResolveOptions {
  readonly version?: string;
}

export interface MarketplaceResolver {
  readonly source: string;
  readonly label: string;
  readonly resolve?: (ref: string, options?: MarketplaceResolveOptions) => Promise<MarketplaceResolvedSkill | undefined>;
}

export async function resolveMarketplaceSkill(
  adapters: readonly MarketplaceResolver[],
  ref: string,
  options: MarketplaceResolveOptions = {},
): Promise<MarketplaceResolvedSkill | undefined> {
  const parsed = parseMarketplaceRef(ref);
  const candidates = adapters.filter((adapter) => adapter.source === parsed.source);

  for (const adapter of candidates) {
    const resolved = await adapter.resolve?.(parsed.name, options);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

export function isMarketplaceRef(ref: string): boolean {
  if (ref.startsWith("runx://skill/")) {
    return false;
  }
  const separator = ref.indexOf(":");
  if (separator <= 0) {
    return false;
  }
  const source = ref.slice(0, separator);
  return source !== "registry" && source !== "runx-registry";
}

export function parseMarketplaceRef(ref: string): { readonly source: string; readonly name: string } {
  const separator = ref.indexOf(":");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(`Invalid marketplace ref '${ref}'. Expected '<marketplace>:<skill>'.`);
  }

  return {
    source: ref.slice(0, separator),
    name: ref.slice(separator + 1),
  };
}

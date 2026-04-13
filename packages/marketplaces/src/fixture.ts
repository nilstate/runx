import { hashString } from "../../receipts/src/index.js";

import type { MarketplaceAdapter, SkillSearchResult } from "./index.js";

const fixtureMarkdown = `---
name: sourcey-docs
description: External fixture skill for generating Sourcey documentation.
---

# Sourcey Docs

Fixture marketplace skill used by runx tests. It is installed as markdown only; \`skill add\` must not execute it.
`;

const fixtureXManifest = `skill: sourcey-docs
runners:
  sourcey-docs-cli:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - console.log("fixture sourcey docs")
`;

const standardOnlyMarkdown = `---
name: marketplace-standard-only
description: External standard-only fixture skill.
---

# Marketplace Standard Only

Fixture marketplace skill without runx X metadata.
`;

const fixtureResults: readonly SkillSearchResult[] = [
  {
    skill_id: "fixture/sourcey-docs",
    name: "sourcey-docs",
    summary: "External fixture skill for generating Sourcey documentation.",
    owner: "fixture",
    version: "2026.04.10",
    digest: hashString(fixtureMarkdown),
    source: "fixture-marketplace",
    source_label: "Fixture Marketplace",
    source_type: "agent",
    trust_tier: "external-unverified",
    required_scopes: [],
    tags: ["sourcey", "docs"],
    runner_mode: "x-manifest",
    runner_names: ["sourcey-docs-cli"],
    x_digest: hashString(fixtureXManifest),
    x_trust_tier: "external-unverified",
    add_command: "runx add fixture-marketplace:sourcey-docs",
    run_command: "runx sourcey-docs",
  },
  {
    skill_id: "fixture/marketplace-standard-only",
    name: "marketplace-standard-only",
    summary: "External standard-only fixture skill.",
    owner: "fixture",
    version: "2026.04.10",
    digest: hashString(standardOnlyMarkdown),
    source: "fixture-marketplace",
    source_label: "Fixture Marketplace",
    source_type: "agent",
    trust_tier: "external-unverified",
    required_scopes: [],
    tags: ["portable"],
    runner_mode: "standard-only",
    runner_names: [],
    add_command: "runx add fixture-marketplace:marketplace-standard-only",
    run_command: "runx marketplace-standard-only",
  },
];

export function createFixtureMarketplaceAdapter(results: readonly SkillSearchResult[] = fixtureResults): MarketplaceAdapter {
  return {
    source: "fixture-marketplace",
    label: "Fixture Marketplace",
    search: async (query, options = {}) => {
      const normalizedQuery = query.trim().toLowerCase();
      return results
        .filter((result) => normalizedQuery.length === 0 || searchableText(result).includes(normalizedQuery))
        .slice(0, options.limit ?? 20);
    },
    resolve: async (ref, options = {}) => {
      const normalizedRef = ref.trim().toLowerCase();
      const match = results.find((result) => {
        const resultRef = result.skill_id.split("/")[1] ?? result.name;
        const versionMatches = options.version === undefined || result.version === options.version;
        return versionMatches && [result.name, result.skill_id, resultRef].includes(normalizedRef);
      });

      if (!match) {
        return undefined;
      }
      return {
        markdown: match.name === "marketplace-standard-only" ? standardOnlyMarkdown : fixtureMarkdown,
        xManifest: match.name === "marketplace-standard-only" ? undefined : fixtureXManifest,
        result: match,
      };
    },
  };
}

function searchableText(result: SkillSearchResult): string {
  return [
    result.skill_id,
    result.name,
    result.summary,
    result.owner,
    result.source,
    result.source_type,
    ...result.tags,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

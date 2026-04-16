import { describe, expect, it } from "vitest";

import { createFixtureMarketplaceAdapter, isMarketplaceRef, resolveMarketplaceSkill, searchMarketplaceAdapters } from "./index.js";

describe("marketplace search models", () => {
  it("skill-search normalizes fixture marketplace results with external attribution", async () => {
    const results = await searchMarketplaceAdapters([createFixtureMarketplaceAdapter()], "sourcey");

    expect(results).toEqual([
      expect.objectContaining({
        skill_id: "fixture/sourcey-docs",
        source: "fixture-marketplace",
        source_label: "Fixture Marketplace",
        trust_tier: "external-unverified",
        profile_mode: "profiled",
        runner_names: ["sourcey-docs-cli"],
        profile_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it("skill-add resolver returns fixture markdown without executing it", async () => {
    const resolved = await resolveMarketplaceSkill([createFixtureMarketplaceAdapter()], "fixture:sourcey-docs");

    expect(resolved).toEqual(
      expect.objectContaining({
        markdown: expect.stringContaining("name: sourcey-docs"),
        profileDocument: expect.stringContaining("sourcey-docs-cli"),
        result: expect.objectContaining({
          skill_id: "fixture/sourcey-docs",
          source: "fixture-marketplace",
          source_type: "agent",
          trust_tier: "external-unverified",
          profile_mode: "profiled",
          runner_names: ["sourcey-docs-cli"],
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("resolves portable marketplace skills without execution profile", async () => {
    const resolved = await resolveMarketplaceSkill([createFixtureMarketplaceAdapter()], "fixture:marketplace-portable");

    expect(resolved).toEqual(
      expect.objectContaining({
        markdown: expect.stringContaining("name: marketplace-portable"),
        profileDocument: undefined,
        result: expect.objectContaining({
          skill_id: "fixture/marketplace-portable",
          source_type: "agent",
          profile_mode: "portable",
          runner_names: [],
        }),
      }),
    );
  });

  it("does not classify runx registry links as marketplace refs", () => {
    expect(isMarketplaceRef("runx://skill/0state%2Fsourcey@1.0.0")).toBe(false);
    expect(isMarketplaceRef("fixture:sourcey-docs")).toBe(true);
  });
});

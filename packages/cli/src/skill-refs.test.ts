import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseRunnerManifestYaml, validateRunnerManifest } from "./cli-parser/index.js";

import { officialSkillVisibleForCatalog } from "./skill-refs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publicOfficialCatalogSkills = [
  "brand-voice",
  "charge",
  "content-pipeline",
  "deep-research-brief",
  "dependency-cve-audit",
  "design-skill",
  "dispute-respond",
  "draft-content",
  "ecosystem-brief",
  "ecosystem-vuln-scan",
  "evolve",
  "github-sync",
  "governed-outbound",
  "improve-skill",
  "inbox-and-calendar-exec",
  "issue-intake",
  "issue-to-pr",
  "issue-triage",
  "knowledge-router",
  "lead-enrichment",
  "lead-router",
  "ledger",
  "least-privilege-auditor",
  "messageboard",
  "moltbook",
  "n8n-handoff",
  "nitrosend",
  "nws-weather-forecast",
  "overlay-generator",
  "policy-author",
  "pr-review-note",
  "prior-art",
  "receipt-auditor",
  "redact-pii",
  "reflect-digest",
  "refund",
  "release",
  "research",
  "review-receipt",
  "review-skill",
  "run-history-analyst",
  "runx-operator",
  "sandbox-harden",
  "send-as",
  "settle-invoice",
  "sign-receipt",
  "skill-lab",
  "skill-testing",
  "slack-notify",
  "sourcey",
  "spend",
  "sql-analyst",
  "stripe-pay",
  "taste-profile",
  "vault-unseal",
  "vuln-scan",
  "weather-forecast",
  "web-fetch",
  "work-plan",
  "write-harness",
  "x402-pay",
  "zapier-handoff",
];
const paymentGraphStageOwners: Readonly<Record<string, string>> = {
  "charge-challenge": "charge",
  "charge-price": "charge",
  "charge-verify": "charge",
  "pay-fulfill-rail": "spend",
  "pay-quote": "spend",
  "pay-recover": "spend",
  "pay-reserve": "spend",
  "refund-quote": "refund",
  "refund-recover": "refund",
  "refund-reserve": "refund",
};
const paymentHarnessFixtures = [
  "mock-charge",
  "mock-pay",
  "mock-refund",
];
const paymentRuntimePaths = [
  "mpp-charge",
  "mpp-pay",
  "mpp-refund",
  "stripe-charge",
  "stripe-refund",
];
const issueToPrGraphStageOwners: Readonly<Record<string, string>> = {
  scafld: "issue-to-pr",
};

describe("official skill catalog exposure", () => {
  it("hides non-catalog official skills unless the dev catalog is explicitly enabled", () => {
    expect(officialSkillVisibleForCatalog("runx/mock-pay", {})).toBe(false);
    expect(officialSkillVisibleForCatalog("runx/x402-pay", {})).toBe(true);
    expect(officialSkillVisibleForCatalog("runx/stripe-pay", {})).toBe(true);
    expect(officialSkillVisibleForCatalog("runx/issue-to-pr", {})).toBe(true);
    expect(officialSkillVisibleForCatalog("runx/research", {})).toBe(true);
    expect(officialSkillVisibleForCatalog("runx/stripe-charge", {})).toBe(false);
    expect(
      officialSkillVisibleForCatalog("runx/mock-pay", {
        RUNX_DEV_CATALOG: "1",
      }),
    ).toBe(true);
  });

  it("keeps implemented catalog skills visible", () => {
    for (const skill of publicOfficialCatalogSkills) {
      expect(officialSkillVisibleForCatalog(`runx/${skill}`, {}), skill).toBe(true);
    }
  });

  it("keeps catalog visibility explicit in first-party runner manifests", () => {
    const allSkills = readdirSync(path.join(repoRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        const skillDir = path.join(repoRoot, "skills", entry.name);
        return existsSync(path.join(skillDir, "SKILL.md")) && existsSync(path.join(skillDir, "X.yaml"));
      })
      .map((entry) => entry.name)
      .sort();
    const expectedPublic = new Set(publicOfficialCatalogSkills);
    const actualPublic = allSkills.filter((skill) => catalogVisibility(skill) === "public");

    expect(actualPublic).toEqual([...publicOfficialCatalogSkills].sort());
    for (const skill of allSkills) {
      expect(catalogVisibility(skill), skill).toBe(expectedPublic.has(skill) ? "public" : "internal");
      expect(catalogRole(skill), skill).toBeTruthy();
    }
  });

  it("keeps payment lifecycle internals and rail fixtures out of the catalog with explicit roles", () => {
    for (const [stage, owner] of Object.entries(paymentGraphStageOwners)) {
      expect(existsSync(path.join(repoRoot, "skills", owner, "graph", stage, "X.yaml")), stage).toBe(true);
      expect(existsSync(path.join(repoRoot, "skills", stage)), stage).toBe(false);
    }
    for (const [stage, owner] of Object.entries(issueToPrGraphStageOwners)) {
      expect(existsSync(path.join(repoRoot, "skills", owner, "graph", stage, "X.yaml")), stage).toBe(true);
      expect(existsSync(path.join(repoRoot, "skills", stage)), stage).toBe(false);
    }
    for (const skill of paymentHarnessFixtures) {
      expect(catalogVisibility(skill), skill).toBe("internal");
      expect(catalogRole(skill), skill).toBe("harness-fixture");
    }
    for (const skill of paymentRuntimePaths) {
      expect(catalogVisibility(skill), skill).toBe("internal");
      expect(catalogRole(skill), skill).toBe("runtime-path");
    }
  });
});

function catalogVisibility(skill: string): string | undefined {
  const manifestPath = path.join(repoRoot, "skills", skill, "X.yaml");
  const manifest = validateRunnerManifest(parseRunnerManifestYaml(readFileSync(manifestPath, "utf8")));
  return manifest.catalog?.visibility;
}

function catalogRole(skill: string): string | undefined {
  const manifestPath = path.join(repoRoot, "skills", skill, "X.yaml");
  const manifest = validateRunnerManifest(parseRunnerManifestYaml(readFileSync(manifestPath, "utf8")));
  return manifest.catalog?.role;
}

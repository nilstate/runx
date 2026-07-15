import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  type ValidatedRunnerManifest as SkillRunnerManifest,
  validateRunnerManifestYaml as validateNativeRunnerManifestYaml,
  validateSkillMarkdown,
} from "./parser-eval.js";
import { resolveRunxBinary } from "./runx-binary.js";

const publicSkillRequiredHeadings = [
  "What this skill does",
  "When to use this skill",
  "When not to use this skill",
  "Procedure",
  "Edge cases and stop conditions",
  "Output schema",
  "Worked example",
  "Inputs",
] as const;

const currentPaymentRegistrySkillIds = [
  "runx/charge",
  "runx/dispute-respond",
  "runx/mock-charge",
  "runx/mock-pay",
  "runx/mock-refund",
  "runx/mpp-charge",
  "runx/mpp-pay",
  "runx/mpp-refund",
  "runx/refund",
  "runx/spend",
  "runx/stripe-charge",
  "runx/stripe-refund",
  "runx/stripe-pay",
  "runx/x402-pay",
] as const;

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

const issueToPrGraphStageOwners: Readonly<Record<string, string>> = {
  scafld: "issue-to-pr",
};

const retiredPaymentRegistrySkillIds = [
  "runx/payment-authorize-reserve",
  "runx/payment-charge",
  "runx/payment-charge-challenge",
  "runx/payment-charge-price",
  "runx/payment-charge-verify",
  "runx/payment-execute",
  "runx/payment-execution",
  "runx/payment-fulfill",
  "runx/payment-fulfill-rail",
  "runx/payment-quote",
  "runx/payment-quote-preflight",
  "runx/payment-rail-mock",
  "runx/payment-recover",
  "runx/payment-recover-inspect",
  "runx/payment-refund",
  "runx/payment-refund-quote",
  "runx/payment-refund-recover",
  "runx/payment-refund-reserve",
  "runx/payment-reserve",
  "runx/x402-charge",
  "runx/x402-refund",
] as const;

function isPaymentRegistrySkillId(skillId: string): boolean {
  return (
    skillId.startsWith("runx/payment-") ||
    skillId.startsWith("runx/pay-") ||
    skillId.startsWith("runx/charge-") ||
    skillId.startsWith("runx/refund-") ||
    skillId === "runx/charge" ||
    skillId === "runx/refund" ||
    skillId === "runx/spend" ||
    skillId.startsWith("runx/x402-") ||
    skillId === "runx/dispute-respond" ||
    /^runx\/(?:mock|mpp|stripe)-(?:charge|pay|refund)$/.test(skillId)
  );
}

const harnessedShowcasePackages = [
  "content-pipeline",
  "deep-research",
  "ghostwrite",
  "ecosystem-vuln-scan",
  "evolve",
  "issue-intake",
  "issue-triage",
  "ecosystem-brief",
  "moltbook",
  "work-plan",
  "design-skill",
  "prior-art",
  "write-harness",
  "review-receipt",
  "review-skill",
  "improve-skill",
  "reflect-digest",
  "release",
  "skill-lab",
  "research",
  "skill-testing",
  "sourcey",
  "vuln-scan",
] as const;

const workspaceRoot = process.cwd();
const nativeRunx = resolveRunxBinary();
const receiptSigningEnv = {
  RUNX_RECEIPT_SIGN_KID: process.env.RUNX_RECEIPT_SIGN_KID ?? "official-skill-catalog-test-key",
  RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:
    process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64 ?? "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
  RUNX_RECEIPT_SIGN_ISSUER_TYPE: process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE ?? "hosted",
};

describe("official skill catalog", () => {
  it("ships official skills as portable packages plus checked-in execution profiles", async () => {
    for (const skillName of officialSkillPackages()) {
      const skillDir = path.resolve("skills", skillName);
      const skillMarkdownPath = path.join(skillDir, "SKILL.md");
      const manifestPath = path.join(skillDir, "X.yaml");

      expect(existsSync(skillDir)).toBe(true);
      expect(existsSync(skillMarkdownPath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);

      const skill = validateSkillMarkdown(await readFile(skillMarkdownPath, "utf8"));
      const manifest = validateRunnerManifestYaml(await readFile(manifestPath, "utf8"));

      expect(skill.name).toBe(skillName);
      expect(manifest.catalog).toBeDefined();
      expect(Object.keys(manifest.runners).length).toBeGreaterThan(0);
    }
  });

  it("keeps the public official catalog limited to implemented catalog skills", async () => {
    const publicSkills = officialSkillPackages().filter((skillName) => catalogVisibility(skillName) === "public");
    const entries = JSON.parse(
      await readFile(path.resolve("skills", "official.lock.json"), "utf8"),
    ) as ReadonlyArray<{ readonly skill_id: string; readonly catalog_visibility?: string }>;
    const publicLockSkills = entries
      .filter((entry) => entry.catalog_visibility === "public")
      .map((entry) => entry.skill_id.slice("runx/".length))
      .sort();

    expect(publicLockSkills).toEqual(publicSkills);
  });

  it("keeps public official skills at the execution-context documentation bar", () => {
    for (const skillName of officialSkillPackages()) {
      if (catalogVisibility(skillName) !== "public") {
        continue;
      }
      if (catalogRole(skillName) === "context") {
        continue;
      }
      const skillMarkdown = readFileSync(path.resolve("skills", skillName, "SKILL.md"), "utf8");

      expect(
        hasMarkdownHeading(skillMarkdown, "Quality Profile"),
        `${skillName} should express quality criteria through execution instructions, not a public rubric`,
      ).toBe(false);
      for (const heading of publicSkillRequiredHeadings) {
        expect(hasMarkdownHeading(skillMarkdown, heading), `${skillName} missing ## ${heading}`).toBe(true);
      }
      expect(
        /\b(needs_input|needs_agent|needs_more_evidence|reject|refused|escalated)\b/.test(skillMarkdown),
        `${skillName} must name a non-ready stop decision`,
      ).toBe(true);
      expect(
        /\b(authority|grant|scope|gate|receipt|proof)\b/i.test(skillMarkdown),
        `${skillName} must document the governing authority, gate, receipt, or proof surface`,
      ).toBe(true);
    }
  });

  it("keeps public catalog manifests scenario-free", () => {
    for (const skillName of officialSkillPackages()) {
      if (catalogVisibility(skillName) !== "public") {
        continue;
      }
      if (catalogRole(skillName) === "context") {
        continue;
      }
      const manifest = validateRunnerManifestYaml(readFileSync(path.resolve("skills", skillName, "X.yaml"), "utf8"));

      expect(manifest.harness, `${skillName} must keep concrete scenarios in fixtures, not X.yaml`).toBeUndefined();
    }
  });

  it("keeps public packages covered by standalone runner fixtures", () => {
    for (const skillName of officialSkillPackages()) {
      if (catalogVisibility(skillName) !== "public") {
        continue;
      }
      if (catalogRole(skillName) === "context") {
        continue;
      }
      const manifest = validateRunnerManifestYaml(readFileSync(path.resolve("skills", skillName, "X.yaml"), "utf8"));
      const fixtures = publicSkillFixtureCases(skillName);
      const runnerNames = Object.keys(manifest.runners).sort();
      const coveredRunners = new Set(fixtures.map((entry) => entry.runner).filter(isNonEmptyString));

      const missing = runnerNames.filter((runner) => !coveredRunners.has(runner));

      expect(fixtures.length, `${skillName} needs standalone fixtures`).toBeGreaterThan(0);
      expect(fixtures.every((entry) => entry.kind === "skill"), `${skillName} fixtures must target the skill`).toBe(true);
      expect(fixtures.every((entry) => entry.target === ".."), `${skillName} fixtures must target their parent skill`).toBe(true);
      expect(missing, `${skillName} missing standalone fixture coverage for runners`).toEqual([]);
    }
  });

  it("keeps graph stages out of the official skills catalog", async () => {
    const entries = JSON.parse(
      await readFile(path.resolve("skills", "official.lock.json"), "utf8"),
    ) as ReadonlyArray<{ readonly skill_id: string }>;
    const entryIds = entries.map((entry) => entry.skill_id);
    const ids = new Set(entryIds);

    expect(currentPaymentRegistrySkillIds.filter((skillId) => !ids.has(skillId))).toEqual([]);
    expect(retiredPaymentRegistrySkillIds.filter((skillId) => ids.has(skillId))).toEqual([]);
    expect(entryIds.filter(isPaymentRegistrySkillId).sort()).toEqual(
      [...currentPaymentRegistrySkillIds].sort(),
    );
    for (const [stage, owner] of Object.entries(paymentGraphStageOwners)) {
      expect(existsSync(path.resolve("skills", owner, "graph", stage, "X.yaml")), stage).toBe(true);
      expect(ids.has(`runx/${stage}`), stage).toBe(false);
      expect(existsSync(path.resolve("skills", stage)), stage).toBe(false);
    }
    for (const [stage, owner] of Object.entries(issueToPrGraphStageOwners)) {
      expect(existsSync(path.resolve("skills", owner, "graph", stage, "X.yaml")), stage).toBe(true);
      expect(ids.has(`runx/${stage}`), stage).toBe(false);
      expect(existsSync(path.resolve("skills", stage)), stage).toBe(false);
    }
    expect([...paymentCatalogPublicIds()].sort()).toEqual([
      "runx/charge",
      "runx/dispute-respond",
      "runx/refund",
      "runx/spend",
      "runx/stripe-pay",
      "runx/x402-pay",
    ]);
  });

  it("classifies internal official packages by why they remain bundled", () => {
    for (const skillName of officialSkillPackages()) {
      const manifest = validateRunnerManifestYaml(readFileSync(path.resolve("skills", skillName, "X.yaml"), "utf8"));
      const catalog = manifest.catalog as {
        readonly visibility?: "public" | "internal";
        readonly role?: string;
        readonly partOf?: readonly string[];
      } | undefined;
      expect(catalog?.visibility, `${skillName} visibility`).toMatch(/^(public|internal)$/);
      expect(catalog?.role, `${skillName} role`).toBeTruthy();

      if (catalog?.visibility === "public") {
        expect(
          ["canonical", "branded", "context"].includes(catalog.role ?? ""),
          `${skillName} public role`,
        ).toBe(true);
      }
      if (["graph-stage", "runtime-path", "harness-fixture"].includes(catalog?.role ?? "")) {
        expect(catalog?.visibility, `${skillName} stage visibility`).toBe("internal");
        expect(catalog?.partOf?.length, `${skillName} part_of`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps evaluator-facing packages runnable through native inline harness fixtures", async () => {
    const internalHarnessedShowcasePackages = harnessedShowcasePackages.filter(
      (skillName) => catalogVisibility(skillName) !== "public",
    );
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-official-native-harness-"));
    let executedCases = 0;
    try {
      for (const skillName of internalHarnessedShowcasePackages) {
        const manifestPath = path.resolve("skills", skillName, "X.yaml");
        const manifest = validateRunnerManifestYaml(await readFile(manifestPath, "utf8"));
        if (Object.values(manifest.runners).some((runner) => runner.source.graph)) {
          continue;
        }
        if (!manifest.harness || manifest.harness.cases.length === 0) {
          throw new Error(`expected inline harness suite for ${skillName}`);
        }
        for (const entry of manifest.harness.cases) {
          const fixturePath = path.join(tempDir, `${skillName}-${entry.name}.yaml`);
          await writeFile(fixturePath, JSON.stringify({
            name: entry.name,
            kind: "skill",
            target: path.resolve("skills", skillName),
            runner: entry.runner,
            inputs: entry.inputs,
            env: entry.env,
            caller: entry.caller,
            expect: entry.expect,
          }, null, 2));
          const result = spawnSync(nativeRunx, ["harness", fixturePath, "--json"], {
            cwd: workspaceRoot,
            encoding: "utf8",
            env: { ...process.env, ...receiptSigningEnv, RUNX_KERNEL_EVAL_BIN: nativeRunx },
            maxBuffer: 8 * 1024 * 1024,
          });

          expect(result.status, `${skillName}/${entry.name}\n${result.stderr || result.stdout}`).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({ schema: "runx.receipt.v1" });
          executedCases += 1;
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    if (internalHarnessedShowcasePackages.length === 0) {
      expect(executedCases).toBe(0);
      return;
    }
    expect(executedCases).toBeGreaterThan(0);
  }, 60_000);
});

function officialSkillPackages(): readonly string[] {
  return readdirSync(path.resolve("skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => existsSync(path.resolve("skills", entry.name, "SKILL.md")))
    .filter((entry) => existsSync(path.resolve("skills", entry.name, "X.yaml")))
    .map((entry) => entry.name)
    .sort();
}

function catalogVisibility(skillName: string): "public" | "internal" {
  const manifest = validateRunnerManifestYaml(readFileSync(path.resolve("skills", skillName, "X.yaml"), "utf8"));
  const catalog = manifest.catalog as { readonly visibility?: "public" | "internal" } | undefined;
  return catalog?.visibility ?? "public";
}

function catalogRole(skillName: string): string | undefined {
  const manifest = validateRunnerManifestYaml(readFileSync(path.resolve("skills", skillName, "X.yaml"), "utf8"));
  const catalog = manifest.catalog as { readonly role?: string } | undefined;
  return catalog?.role;
}

function paymentCatalogPublicIds(): readonly string[] {
  return officialSkillPackages()
    .map((skillName) => `runx/${skillName}`)
    .filter(isPaymentRegistrySkillId)
    .filter((skillId) => catalogVisibility(skillId.slice("runx/".length)) === "public");
}

function hasMarkdownHeading(markdown: string, heading: string): boolean {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escapedHeading}(?:\\b|\\s|$)`, "m").test(markdown);
}

type PublicSkillFixtureCase = {
  readonly kind?: string;
  readonly target?: string;
  readonly runner?: string;
};

function publicSkillFixtureCases(skillName: string): readonly PublicSkillFixtureCase[] {
  const fixturesDir = path.resolve("skills", skillName, "fixtures");
  if (!existsSync(fixturesDir)) {
    return [];
  }
  return readdirSync(fixturesDir)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort()
    .map((entry) => parseYaml(readFileSync(path.join(fixturesDir, entry), "utf8")) as PublicSkillFixtureCase);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateRunnerManifestYaml(profileDocument: string): SkillRunnerManifest {
  return validateNativeRunnerManifestYaml(profileDocument);
}

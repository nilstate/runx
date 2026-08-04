import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateHarnessFixtureYamlBatch,
  validateRunnerManifestYaml as validateNativeRunnerManifestYaml,
  validateRunnerManifestYamlBatch as validateNativeRunnerManifestYamlBatch,
  validateSkillMarkdownBatch as validateNativeSkillMarkdownBatch,
} from "../scripts/lib/native-parser.mjs";
import { resolveRunxBinary } from "./runx-binary.js";

type SkillRunner = {
  readonly name: string;
  readonly default: boolean;
  readonly source: {
    readonly type: string;
    readonly graph?: { readonly steps: readonly unknown[] };
  };
};

type SkillRunnerManifest = {
  readonly catalog?: Record<string, unknown>;
  readonly runners: Readonly<Record<string, SkillRunner>>;
  readonly harness?: {
    readonly cases: readonly {
      readonly name: string;
      readonly runner?: string;
      readonly inputs?: unknown;
      readonly env?: unknown;
      readonly caller?: unknown;
      readonly expect?: unknown;
    }[];
  };
  readonly raw: { readonly document: Record<string, unknown> };
};

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
  "vuln-disclosure",
  "issue-intake",
  "issue-triage",
  "ecosystem-brief",
  "moltbook",
  "work-plan",
  "prior-art",
  "review-receipt",
  "review-skill",
  "reflect-digest",
  "release",
  "skill-lab",
  "research",
  "sourcey",
  "vuln-triage",
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
    const packages = await Promise.all(officialSkillPackages().map(async (skillName) => {
      const skillDir = path.resolve("skills", skillName);
      const skillMarkdownPath = path.join(skillDir, "SKILL.md");
      const manifestPath = path.join(skillDir, "X.yaml");

      expect(existsSync(skillDir)).toBe(true);
      expect(existsSync(skillMarkdownPath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
      return {
        skillName,
        markdown: await readFile(skillMarkdownPath, "utf8"),
        profile: await readFile(manifestPath, "utf8"),
      };
    }));
    const skills = validateNativeSkillMarkdownBatch(packages.map((entry) => entry.markdown)) as Array<{
      readonly name: string;
    }>;
    const manifests = validateNativeRunnerManifestYamlBatch(
      packages.map((entry) => entry.profile),
    ) as SkillRunnerManifest[];
    for (const [index, { skillName }] of packages.entries()) {
      const skill = skills[index];
      const manifest = manifests[index];
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

  it("keeps static agent instructions exclusively in SKILL.md", () => {
    for (const manifestPath of skillManifestPaths(path.resolve("skills"))) {
      const manifest = validateRunnerManifestYaml(readFileSync(manifestPath, "utf8")).raw.document;
      expect(findObjectKeyPaths(manifest, "instructions"), manifestPath).toEqual([]);

      if (findAgentTaskNames(manifest).length === 0) {
        continue;
      }
      const skillMarkdownPath = path.join(path.dirname(manifestPath), "SKILL.md");
      expect(existsSync(skillMarkdownPath), manifestPath).toBe(true);
    }
  });

  it("keeps internal review rubrics out of public skill guidance", () => {
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
        `${skillName} should express operating criteria through SKILL.md, not a public rubric`,
      ).toBe(false);
    }
  });

  it("keeps public packages covered by executable proof", () => {
    for (const skillName of officialSkillPackages()) {
      if (catalogVisibility(skillName) !== "public") {
        continue;
      }
      if (catalogRole(skillName) === "context") {
        continue;
      }
      const manifest = validateRunnerManifestYaml(readFileSync(path.resolve("skills", skillName, "X.yaml"), "utf8"));
      const fixtures = publicSkillFixtureCases(skillName);
      const inlineCases = manifest.harness?.cases ?? [];

      expect(fixtures.length + inlineCases.length, `${skillName} needs executable proof`).toBeGreaterThan(0);
      expect(
        fixtures.every((entry) => entry.kind === "skill" || entry.kind === "graph"),
        `${skillName} fixtures must target a skill or operator journey`,
      ).toBe(true);
      expect(
        fixtures
          .filter((entry) => entry.kind === "skill")
          .every((entry) => entry.target === ".." || entry.target?.startsWith("../graph/") === true),
        `${skillName} skill fixtures must stay within their package`,
      ).toBe(true);
      expect(
        fixtures
          .filter((entry) => entry.kind === "graph")
          .every((entry) => entry.target?.startsWith("../harness/") === true),
        `${skillName} journey fixtures must target their package harness`,
      ).toBe(true);
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
            env: { ...process.env, ...receiptSigningEnv, RUNX_RUST_CLI_BIN: nativeRunx },
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

function skillManifestPaths(root: string): readonly string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...skillManifestPaths(entryPath));
    } else if (entry.name === "X.yaml") {
      paths.push(entryPath);
    }
  }
  return paths.sort();
}

function findObjectKeyPaths(value: unknown, key: string, prefix = "$"): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findObjectKeyPaths(entry, key, `${prefix}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([name, entry]) => [
    ...(name === key ? [`${prefix}.${name}`] : []),
    ...findObjectKeyPaths(entry, key, `${prefix}.${name}`),
  ]);
}

function findAgentTaskNames(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(findAgentTaskNames);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const current = record.type === "agent-task" && typeof record.task === "string"
    ? [record.task]
    : [];
  return [...current, ...Object.values(record).flatMap(findAgentTaskNames)];
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
  const documents = readdirSync(fixturesDir)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort()
    .map((entry) => readFileSync(path.join(fixturesDir, entry), "utf8"));
  return validateHarnessFixtureYamlBatch(documents) as PublicSkillFixtureCase[];
}

function validateRunnerManifestYaml(profileDocument: string): SkillRunnerManifest {
  return validateNativeRunnerManifestYaml(profileDocument);
}

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

type CatalogSemanticDiagnostic = {
  readonly code: string;
  readonly skill: string;
  readonly runner: string;
  readonly claimedExecution?: string;
  readonly claimedCompletion?: string;
  readonly observed: readonly string[];
  readonly requiredCorrection: string;
};

type CatalogSemanticReport = {
  readonly mode: "enforced";
  readonly skill: string;
  readonly defaultRunner?: string;
  readonly diagnostics: readonly CatalogSemanticDiagnostic[];
  readonly readiness: {
    readonly evaluated: boolean;
    readonly coldSelection: boolean;
    readonly standaloneDefault: boolean;
    readonly composedReuse: boolean;
    readonly providerProof: "none" | "harness" | "live";
    readonly suppliedAgentAnswers: boolean;
    readonly coldSelectionConfusors?: readonly string[];
    readonly standaloneCase?: string;
    readonly composedCase?: string;
  };
};

type NativeSkillInspection = {
  readonly status: string;
  readonly name: string;
  readonly description?: string;
  readonly runner?: { readonly name?: string };
  readonly catalog?: {
    readonly visibility?: "public" | "internal";
    readonly role?: string;
    readonly execution?: string;
    readonly completion?: string;
  };
  readonly semantic_report: CatalogSemanticReport;
  readonly operator_journeys?: readonly {
    readonly case: string;
    readonly mode: "standalone" | "composed" | "refusal";
    readonly request: string;
    readonly expected_outcome: string;
    readonly runner?: string;
    readonly exercises_runner?: string;
    readonly confusors: readonly string[];
    readonly prior_evidence: readonly string[];
    readonly must_not_repeat: readonly string[];
  }[];
};

const currentPaymentRegistrySkillIds = [
  "runx/charge",
  "runx/dispute-respond",
  "runx/mock-charge",
  "runx/mock-pay",
  "runx/mock-refund",
  "runx/refund",
  "runx/settle-invoice",
  "runx/spend",
  "runx/stripe-pay",
  "runx/x402-pay",
] as const;

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
  "runx/mpp-charge",
  "runx/mpp-pay",
  "runx/mpp-refund",
  "runx/stripe-charge",
  "runx/stripe-refund",
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
    skillId === "runx/settle-invoice" ||
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
  "diagnose-skill-run",
  "review-skill",
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
      .map((entry) => entry.skill_id.split("/").at(-1)!)
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

  it("keeps only the public hosted contracts and local simulators in the payment catalog", async () => {
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
    expect(ids.has("runx/scafld")).toBe(false);
    expect(existsSync(path.resolve("skills", "issue-to-pr", "graph", "scafld"))).toBe(false);
    expect([...paymentCatalogPublicIds()].sort()).toEqual([
      "runx/charge",
      "runx/dispute-respond",
      "runx/refund",
      "runx/settle-invoice",
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

  it("enforces clean public defaults while retaining explicit internal fixtures", () => {
    for (const skillName of ["charge", "refund", "spend", "github-sync", "business-ops"]) {
      const inspection = inspectOfficialSkill(skillName);
      expect(inspection.status, skillName).toBe("ok");
      expect(inspection.catalog?.visibility, skillName).toBe("public");
      expect(inspection.semantic_report.mode, skillName).toBe("enforced");
      expect(inspection.semantic_report.diagnostics, skillName).toEqual([]);
    }

    const internal = inspectOfficialSkill("mock-pay");
    expect(internal.catalog?.visibility).toBe("internal");
    expect(internal.semantic_report.mode).toBe("enforced");
    expect(internal.semantic_report.diagnostics).toEqual([]);
    const harness = runNativeJson(["harness", "skills/mock-pay", "--json"]);
    expect(harness).toMatchObject({ status: "passed", assertion_error_count: 0 });
  }, 40_000);

  it("emits deterministic structured semantic diagnostics from native inspection", () => {
    const first = inspectOfficialSkill("github-sync");
    const second = inspectOfficialSkill("github-sync");
    expect(second.semantic_report).toEqual(first.semantic_report);
    expect(first.semantic_report).toMatchObject({
      mode: "enforced",
      skill: "github-sync",
      defaultRunner: "github-sync",
      diagnostics: [],
    });

    const auditSelfTest = spawnSync(process.execPath, [
      "scripts/audit-core-skills.mjs",
      "--self-test",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    expect(
      auditSelfTest.status,
      auditSelfTest.stderr || auditSelfTest.stdout,
    ).toBe(0);
  }, 40_000);

  it("keeps operator intent selection on terminal issue-to-pr and hides internal stages", async () => {
    const terminal = inspectOfficialSkill("issue-to-pr");
    expect(terminal).toMatchObject({
      name: "issue-to-pr",
      runner: { name: "issue-to-pr" },
      catalog: {
        visibility: "public",
        role: "canonical",
        execution: "execute",
        completion: "provider_readback",
      },
    });

    for (const optionalSkill of ["issue-intake", "issue-triage", "work-plan"]) {
      expect(inspectOfficialSkill(optionalSkill)).toMatchObject({
        name: optionalSkill,
        catalog: { visibility: "public" },
      });
    }

    const home = await mkdtemp(path.join(os.tmpdir(), "runx-operator-selection-"));
    try {
      const exported = runNativeJson(["export", "codex", "--json"], {
        HOME: home,
        RUNX_HOME: path.join(home, ".runx"),
      }) as { readonly exported: readonly { readonly skill: string }[] };
      const names = exported.exported.map((entry) => entry.skill);
      const expectedPublicNames = [
        ...officialSkillPackages().filter((skillName) => catalogVisibility(skillName) === "public"),
        "runx",
      ].sort();
      expect([...names].sort()).toEqual(expectedPublicNames);
      expect(names).toEqual(expect.arrayContaining([
        "adopt-skill",
        "diagnose-skill-run",
        "github-pr-comment",
        "issue-to-pr",
        "issue-intake",
        "issue-triage",
        "runx",
        "work-plan",
      ]));
      expect(names).not.toContain("overlay");
      expect(names).not.toContain("pr-review-note");
      expect(names).not.toContain("review-receipt");
      expect(names).not.toContain("reflect-digest");
      expect(names).not.toContain("scafld");
      expect(names).not.toContain("issue-to-pr-push-outbox");
      expect(names).not.toContain("issue-to-pr-push-outbox-provider");

      const shim = await readFile(
        path.join(home, ".codex", "skills", "issue-to-pr", "SKILL.md"),
        "utf8",
      );
      expect(shim).toContain("name: issue-to-pr");
      expect(shim).toContain("runx skill");
      expect(shim).toContain("skills/issue-to-pr");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  it("projects an intuitive direct request and reusable chain journey for every public skill", () => {
    const publicSkillNames = new Set(
      officialSkillPackages().filter((skillName) => catalogVisibility(skillName) === "public"),
    );
    for (const skillName of officialSkillPackages()) {
      if (catalogVisibility(skillName) !== "public") continue;
      const inspection = inspectOfficialSkill(skillName);
      const journeys = inspection.operator_journeys ?? [];
      const standalone = journeys.filter((journey) => journey.mode === "standalone");
      const composed = journeys.filter((journey) => journey.mode === "composed");

      expect(inspection.description?.trim().length, `${skillName} selection description`).toBeGreaterThan(24);
      expect(inspection.semantic_report.diagnostics, `${skillName} native semantic diagnostics`).toEqual([]);
      expect(inspection.semantic_report.readiness, `${skillName} native readiness`).toMatchObject({
        evaluated: true,
        coldSelection: true,
        standaloneDefault: true,
        composedReuse: true,
      });
      const confusors = inspection.semantic_report.readiness.coldSelectionConfusors ?? [];
      expect(confusors.length, `${skillName} distinct cold-selection confusors`).toBeGreaterThanOrEqual(2);
      for (const confusor of confusors) {
        expect(confusor, `${skillName} must not confuse itself`).not.toBe(skillName);
        expect(publicSkillNames.has(confusor), `${skillName} confusor ${confusor} must be public`).toBe(true);
      }
      expect(standalone.length, `${skillName} standalone journey`).toBeGreaterThan(0);
      expect(composed.length, `${skillName} composed journey`).toBeGreaterThan(0);
      for (const journey of journeys) {
        expect(journey.request.trim().length, `${skillName}/${journey.case} request`).toBeGreaterThan(12);
        expect(
          journey.expected_outcome.trim().length,
          `${skillName}/${journey.case} expected outcome`,
        ).toBeGreaterThan(12);
        if (journey.mode === "composed") {
          expect(journey.prior_evidence.length, `${skillName}/${journey.case} prior evidence`).toBeGreaterThan(0);
          expect(journey.must_not_repeat.length, `${skillName}/${journey.case} non-repetition`).toBeGreaterThan(0);
        }
      }
    }
  }, 60_000);

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

function inspectOfficialSkill(skillName: string): NativeSkillInspection {
  return runNativeJson([
    "skill",
    "inspect",
    `skills/${skillName}`,
    "--json",
  ]) as NativeSkillInspection;
}

function runNativeJson(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): unknown {
  const result = spawnSync(nativeRunx, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...receiptSigningEnv,
      RUNX_CWD: workspaceRoot,
      ...env,
      NO_COLOR: "1",
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${nativeRunx} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { authorityTermSchema, contractSchemaMatches, validateContractSchemaForDiagnostics } from "@runxhq/contracts";
import { describe, expect, it } from "vitest";

import {
  parseRunnerManifestYaml,
  validateRunnerManifest,
  type SkillRunnerDefinition as RunnerDefinition,
  type SkillRunnerManifest,
} from "../packages/cli/src/cli-parser/index.js";
import {
  validateSkillMarkdown,
} from "./parser-eval.js";

const paymentSecretKeyPattern = /(?:^|_)(?:pan|cvv|cvc|card_number|cardnumber|account_number|routing_number|private_key|seed_phrase|mnemonic|secret_key|api_key|access_token|refresh_token|client_secret|merchant_secret|provider_secret|raw_secret|raw_token|bearer_token|password|credential_material|secret_material|key_material)(?:$|_)/i;
const paymentSecretMetadataFields = new Set(["receives_rail_secret_material"]);
const retiredReceiptFields = new Set(["schema_version", "source_type"]);
const canonicalConsumerPaymentSkillNames = new Set([
  "mock-pay",
  "mpp-pay",
  "spend",
  "stripe-pay",
  "x402-pay",
]);
const paymentGraphStageNames = new Set([
  "charge-challenge",
  "charge-price",
  "charge-verify",
  "pay-fulfill-rail",
  "pay-quote",
  "pay-recover",
  "pay-reserve",
  "refund-quote",
  "refund-recover",
  "refund-reserve",
]);
const retiredConsumerPaymentSkillNames = new Set([
  "payment-authorize-reserve",
  "payment-execute",
  "payment-fulfill-rail",
  "payment-quote",
  "payment-quote-preflight",
  "payment-rail-mock",
  "payment-recover",
  "payment-recover-inspect",
  "payment-reserve",
]);
const forbiddenX402PaymentAliases = new Set([
  "x402-charge",
  "x402-refund",
]);
const explicitGovernedPaymentSkillNames = new Set([
  "charge",
  "charge-challenge",
  "charge-price",
  "charge-verify",
  "dispute-respond",
  "mock-charge",
  "mock-refund",
  "mpp-charge",
  "mpp-refund",
  "refund",
  "refund-quote",
  "refund-recover",
  "refund-reserve",
  "stripe-charge",
  "stripe-refund",
  ...canonicalConsumerPaymentSkillNames,
]);
const expectedChargePacketMetadata = new Map([
  ["charge-price", { runner: "price", output: "charge_price_packet", packet: "runx.payment.charge_price.v1" }],
  ["charge-challenge", { runner: "challenge", output: "charge_challenge_packet", packet: "runx.payment.charge_challenge.v1" }],
  ["charge-verify", { runner: "verify", output: "charge_verification_packet", packet: "runx.payment.charge_verification.v1" }],
]);
const chargeGraphSkillNames = new Set(["charge"]);
const canonicalPaymentStageRefs: Readonly<Record<string, readonly string[]>> = {
  charge: ["charge-price", "charge-challenge", "charge-verify"],
  refund: ["refund-quote", "refund-reserve"],
  spend: ["pay-quote", "pay-reserve", "pay-fulfill-rail"],
};
const canonicalPaymentDelegateRefs: Readonly<Record<string, string>> = {
  "mock-charge": "../charge",
  "mock-pay": "../spend",
  "mock-refund": "../refund",
  "mpp-charge": "../charge",
  "mpp-pay": "../spend",
  "mpp-refund": "../refund",
  "stripe-charge": "../charge",
  "stripe-pay": "../spend",
  "stripe-refund": "../refund",
  "x402-pay": "../spend",
};

describe("payment skill execution profiles", () => {
  it("uses canonical consumer payment skill names without legacy aliases", async () => {
    const entries = new Set(
      (await readdir(path.resolve("skills"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const stages = new Set((await discoverGraphStageDirs()).map((dir) => path.basename(dir)));

    expect([...canonicalConsumerPaymentSkillNames].filter((name) => !entries.has(name))).toEqual([]);
    expect([...paymentGraphStageNames].filter((name) => !stages.has(name))).toEqual([]);
    expect([...paymentGraphStageNames].filter((name) => entries.has(name))).toEqual([]);
    expect([...retiredConsumerPaymentSkillNames].filter((name) => entries.has(name))).toEqual([]);
    expect([...forbiddenX402PaymentAliases].filter((name) => entries.has(name))).toEqual([]);
    expect(entries.has("crypto-pay"), "crypto-pay stays a reserved placeholder, not an exposed skill").toBe(false);
  });

  it("keeps canonical payment roots as owner-local stage graphs", async () => {
    for (const [skillName, expectedStages] of Object.entries(canonicalPaymentStageRefs)) {
      const manifest = parseRunnerManifest(await readFile(path.resolve("skills", skillName, "X.yaml"), "utf8"));
      const graphRunners = Object.values(manifest.runners).filter((runner) => runner.source.graph);

      expect(graphRunners.length, `${skillName} graph runners`).toBeGreaterThan(0);
      for (const runner of graphRunners) {
        const steps = runner.source.graph?.steps ?? [];
        const graphRefs = steps.flatMap((step) => (step.skill?.startsWith("graph/") ? [step.skill] : []));
        const expectedRefs = expectedStages.map((stage) => `graph/${stage}`);

        expect(graphRefs, `${skillName}.${runner.name} canonical graph skill refs`).toEqual(expectedRefs);
        for (const stage of expectedStages) {
          expect(existsSync(path.resolve("skills", skillName, "graph", stage, "X.yaml")), `${skillName}/${stage}`).toBe(true);
          expect(existsSync(path.resolve("skills", stage)), stage).toBe(false);
        }
      }
    }
  });

  it("keeps branded and runtime payment wrappers as single canonical skill delegates", async () => {
    for (const [skillName, canonicalRef] of Object.entries(canonicalPaymentDelegateRefs)) {
      const manifest = parseRunnerManifest(await readFile(path.resolve("skills", skillName, "X.yaml"), "utf8"));

      for (const runner of Object.values(manifest.runners)) {
        const steps = runner.source.graph?.steps ?? [];
        expect(steps, `${skillName}.${runner.name} graph steps`).toHaveLength(1);
        expect(steps[0]?.skill, `${skillName}.${runner.name} canonical skill ref`).toBe(canonicalRef);
      }
    }
  });

  it("parse payment profiles and ingest packaged skills without raw payment credential fields", async () => {
    const skillDirs = await discoverPaymentSkillDirs();

    for (const skillDir of skillDirs) {
      const skillName = path.basename(skillDir);
      const profileDocument = await readFile(path.join(skillDir, "X.yaml"), "utf8");
      const manifest = parseRunnerManifest(profileDocument);

      expect(manifest.skill, `${skillName} profile names its skill`).toBe(skillName);
      expect(Object.keys(manifest.runners), `${skillName} declares runners`).not.toHaveLength(0);
      expect(findPaymentSecretFields(manifest.raw.document), `${skillName} raw payment credential fields`).toEqual([]);

      const markdown = await readOptionalFile(path.join(skillDir, "SKILL.md"));
      if (markdown) {
        const skill = validateSkillMarkdown(markdown, { mode: "strict" });
        expect(manifest.skill ?? skill.name, `${skill.name} profile skill binding`).toBe(skill.name);

        const version = buildPaymentRegistryFixtureVersion(markdown, {
          owner: "runx-pay",
          version: "validation",
          profileDocument,
        });
        expect(version.profile_document).toBe(profileDocument);
        expect(version.profile_digest).toMatch(/^[a-f0-9]{64}$/);
        expect([...version.runner_names].sort()).toEqual(Object.keys(manifest.runners).sort());
      }
    }
  });

  it("keeps payment graph references, packet ids, receipts, and authority examples coherent", async () => {
    const skillDirs = await discoverPaymentSkillDirs();
    const packetIds = await loadDeclaredPacketIds();

    for (const skillDir of skillDirs) {
      const skillName = path.basename(skillDir);
      const profileDocument = await readFile(path.join(skillDir, "X.yaml"), "utf8");
      const manifest = parseRunnerManifest(profileDocument);

      expect(findRetiredReceiptFields(manifest.raw.document), `${skillName} retired receipt fields`).toEqual([]);
      expect(findInvalidPaymentAuthorityTerms(manifest.raw.document), `${skillName} payment authority term examples`).toEqual([]);
      const expectedPacket = expectedChargePacketMetadata.get(skillName);
      if (expectedPacket) {
        const runner = manifest.runners[expectedPacket.runner];
        expect(runner, `${skillName}.${expectedPacket.runner} runner`).toBeDefined();
        const outputs = runner ? outputDeclarationsFromArtifacts(runner.raw) : {};
        expect(outputs[expectedPacket.output]?.packet, `${skillName}.${expectedPacket.output} packet`).toBe(expectedPacket.packet);
      }

      for (const [runnerName, runner] of Object.entries(manifest.runners)) {
        expect(findUnknownPacketRefs(runner.raw, packetIds), `${skillName}.${runnerName} payment packet refs`).toEqual([]);
        const graph = runner.source.graph;
        if (!graph) {
          continue;
        }
        const outputDeclarations = new Map<string, Readonly<Record<string, OutputDeclaration>>>();
        for (const step of graph.steps) {
          if (step.skill) {
            const nested = await loadNestedRunner(skillDir, step.skill, step.runner);
            expect(nested.error, `${skillName}.${runnerName}.${step.id} nested runner`).toBeUndefined();
          }
          outputDeclarations.set(step.id, await loadStepOutputDeclarations(skillDir, step));
        }
        if (chargeGraphSkillNames.has(skillName)) {
          expect(outputDeclarations.get("seal")?.charge_seal?.packet, `${skillName}.${runnerName}.seal packet`)
            .toBe("runx.payment.charge_seal.v1");
        }

        for (const guard of graph.policy?.guards ?? []) {
          const result = validateGraphFieldReference(guard.field, outputDeclarations, packetIds);
          expect(result, `${skillName}.${runnerName} guard ${guard.field}`).toBeUndefined();
        }
      }
    }
  });

  it("rejects common raw merchant and provider secret field names", () => {
    const secretFieldNames = [
      "merchant_secret",
      "stripe_api_key",
      "client_secret",
      "access_token",
      "api_key",
      "provider_secret",
      "raw_token",
      "credential_material",
      "secret_material",
    ];

    for (const fieldName of secretFieldNames) {
      expect(findPaymentSecretFields({ inputs: { [fieldName]: { type: "string" } } }), fieldName)
        .toEqual([`inputs.${fieldName}`]);
    }

    expect(findPaymentSecretFields({
      credential_ref: "credential:mock:paid-search-001",
      payment_credential_ref: "credential:mock:paid-search-001",
      proof_ref: "receipt-proof:mock-charge:paid-search-001",
      idempotency_key: "charge:paid-search-001",
      verify_capability_ref: "capability:charge-verify:paid-search-001",
      receives_rail_secret_material: false,
    })).toEqual([]);
  });
});

interface OutputDeclaration {
  readonly packet?: string;
  readonly packetDataShape: "payload" | "packet";
}

async function discoverPaymentSkillDirs(): Promise<readonly string[]> {
  const roots = [path.resolve("skills"), ...(await discoverGraphStageDirs())];
  const discovered = await Promise.all(roots.map(async (root) => {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillDir = path.join(root, entry.name);
        const profileDocument = await readOptionalFile(path.join(skillDir, "X.yaml"));
        if (!profileDocument) {
          return undefined;
        }
        if (entry.name.includes("payment") || explicitGovernedPaymentSkillNames.has(entry.name)) {
          return skillDir;
        }
        return /\bresource_family:\s*payment\b|\bpayment[.:_-]/.test(profileDocument) ? skillDir : undefined;
      }));
    return candidates.filter((entry): entry is string => entry !== undefined);
  }));
  return discovered.flat().sort();
}

async function discoverGraphStageDirs(): Promise<readonly string[]> {
  const skillsRoot = path.resolve("skills");
  const skills = await readdir(skillsRoot, { withFileTypes: true });
  const stageGroups = await Promise.all(skills
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const graphDir = path.join(skillsRoot, entry.name, "graph");
      if (!existsSync(graphDir)) {
        return [];
      }
      const stages = await readdir(graphDir, { withFileTypes: true });
      return stages
        .filter((stage) => stage.isDirectory())
        .map((stage) => path.join(graphDir, stage.name));
    }));
  return stageGroups.flat().sort();
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function findPaymentSecretFields(value: unknown, pathParts: readonly string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPaymentSecretFields(entry, [...pathParts, `[${index}]`]));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const fieldPath = [...pathParts, key];
    const current = paymentSecretKeyPattern.test(key) && !paymentSecretMetadataFields.has(key) ? [fieldPath.join(".")] : [];
    return [...current, ...findPaymentSecretFields(entry, fieldPath)];
  });
}

function findRetiredReceiptFields(value: unknown, pathParts: readonly string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findRetiredReceiptFields(entry, [...pathParts, `[${index}]`]));
  }
  if (!isRecord(value)) {
    return [];
  }
  const inExpectedReceipt = pathParts.at(-1) === "receipt" && pathParts.includes("expect");
  return Object.entries(value).flatMap(([key, entry]) => {
    const fieldPath = [...pathParts, key];
    const current = inExpectedReceipt && retiredReceiptFields.has(key) ? [fieldPath.join(".")] : [];
    return [...current, ...findRetiredReceiptFields(entry, fieldPath)];
  });
}

function findInvalidPaymentAuthorityTerms(value: unknown, pathParts: readonly string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findInvalidPaymentAuthorityTerms(entry, [...pathParts, `[${index}]`]));
  }
  if (!isRecord(value)) {
    return [];
  }
  const entries = Object.entries(value);
  const currentKey = pathParts.at(-1);
  const isFixtureAuthority =
    currentKey?.endsWith("payment_authority") === true
    && !pathParts.includes("runx")
    && !("authority_ref" in value);
  const current = isFixtureAuthority && hasInlinePaymentAuthorityShape(value) && !contractSchemaMatches(authorityTermSchema, value)
    ? [`${pathParts.join(".")}: ${validateContractSchemaForDiagnostics(authorityTermSchema, value).join(", ")}`]
    : [];
  return [
    ...current,
    ...entries.flatMap(([key, entry]) => findInvalidPaymentAuthorityTerms(entry, [...pathParts, key])),
  ];
}

function hasInlinePaymentAuthorityShape(value: Readonly<Record<string, unknown>>): boolean {
  return value.resource_family === "payment" || (isRecord(value.bounds) && isRecord(value.bounds.payment));
}

function findUnknownPacketRefs(value: unknown, packetIds: ReadonlySet<string>, pathParts: readonly string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findUnknownPacketRefs(entry, packetIds, [...pathParts, `[${index}]`]));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const fieldPath = [...pathParts, key];
    const current = key === "packet" && typeof entry === "string" && entry.startsWith("runx.payment.") && !packetIds.has(entry)
      ? [`${fieldPath.join(".")}: ${entry}`]
      : [];
    return [...current, ...findUnknownPacketRefs(entry, packetIds, fieldPath)];
  });
}

async function loadDeclaredPacketIds(): Promise<ReadonlySet<string>> {
  const packetDir = path.resolve("dist", "packets");
  const entries = await readdir(packetDir, { withFileTypes: true });
  const ids = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("payment.") && entry.name.endsWith(".schema.json"))
      .map(async (entry) => {
        const schema = JSON.parse(await readFile(path.join(packetDir, entry.name), "utf8")) as unknown;
        return isRecord(schema) && typeof schema["x-runx-packet-id"] === "string" ? schema["x-runx-packet-id"] : undefined;
      }),
  );
  return new Set(ids.filter((id): id is string => id !== undefined));
}

async function loadNestedRunner(
  skillDir: string,
  ref: string,
  runnerName: string | undefined,
): Promise<{ readonly error?: string; readonly runner?: RunnerDefinition }> {
  const profilePath = resolveNestedProfilePath(skillDir, ref);
  if (!profilePath) {
    return { error: `missing profile for ${ref}` };
  }
  const manifest = parseRunnerManifest(await readFile(profilePath, "utf8"));
  const runner = runnerName ? manifest.runners[runnerName] : Object.values(manifest.runners).find((candidate) => candidate.default) ?? Object.values(manifest.runners)[0];
  return runner ? { runner } : { error: `missing runner ${runnerName ?? "(default)"}` };
}

async function loadStepOutputDeclarations(
  skillDir: string,
  step: { readonly skill?: string; readonly run?: Readonly<Record<string, unknown>>; readonly runner?: string; readonly artifacts?: Readonly<Record<string, unknown>> },
): Promise<Readonly<Record<string, OutputDeclaration>>> {
  if (step.skill) {
    const nested = await loadNestedRunner(skillDir, step.skill, step.runner);
    return nested.runner ? outputDeclarationsFromArtifacts(nested.runner.raw) : {};
  }
  return outputDeclarationsFromArtifacts({ ...(step.run ?? {}), artifacts: step.artifacts });
}

function outputDeclarationsFromArtifacts(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, OutputDeclaration>> {
  const artifacts = isRecord(raw.artifacts) ? raw.artifacts : {};
  const wrapAs = typeof artifacts.wrap_as === "string" ? artifacts.wrap_as : undefined;
  if (!wrapAs) {
    return {};
  }
  return {
    [wrapAs]: {
      packet: typeof artifacts.packet === "string" ? artifacts.packet : undefined,
      packetDataShape: "payload",
    },
  };
}

function validateGraphFieldReference(
  field: string,
  outputs: ReadonlyMap<string, Readonly<Record<string, OutputDeclaration>>>,
  packetIds: ReadonlySet<string>,
): string | undefined {
  const [stepId, outputName, dataSegment, ...payloadPath] = field.split(".");
  if (!stepId || !outputName) {
    return "field must start with step.output";
  }
  const stepOutputs = outputs.get(stepId);
  const declaration = stepOutputs?.[outputName];
  if (!declaration) {
    return `unknown output ${stepId}.${outputName}`;
  }
  if (dataSegment !== "data") {
    return `field must reference ${stepId}.${outputName}.data before payload fields`;
  }
  if (declaration.packet?.startsWith("runx.payment.") && !packetIds.has(declaration.packet)) {
    return `unknown packet ${declaration.packet}`;
  }
  if (declaration.packet === "runx.payment.approval.v1" && payloadPath[0] !== "approved") {
    return `approval transition must read approved from ${stepId}.${outputName}.data.approved`;
  }
  return undefined;
}

function resolveNestedProfilePath(skillDir: string, ref: string): string | undefined {
  const resolved = path.resolve(skillDir, ref);
  const directory = path.basename(resolved).toLowerCase() === "skill.md" ? path.dirname(resolved) : resolved;
  const profilePath = path.join(directory, "X.yaml");
  return existsSync(profilePath) ? profilePath : undefined;
}


function parseRunnerManifest(profileDocument: string): SkillRunnerManifest {
  return validateRunnerManifest(parseRunnerManifestYaml(profileDocument));
}

function buildPaymentRegistryFixtureVersion(
  markdown: string,
  options: { readonly owner: string; readonly version: string; readonly profileDocument: string },
): {
  readonly profile_document: string;
  readonly profile_digest: string;
  readonly runner_names: readonly string[];
} {
  const skill = validateSkillMarkdown(markdown, { mode: "strict" });
  const manifest = parseRunnerManifest(options.profileDocument);

  expect(manifest.skill ?? skill.name, `${skill.name} profile skill binding`).toBe(skill.name);
  expect(options.owner).toBeTruthy();
  expect(options.version).toBeTruthy();

  return {
    profile_document: options.profileDocument,
    profile_digest: sha256(options.profileDocument),
    runner_names: Object.keys(manifest.runners),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("CLI skill registry execution profile", () => {
  it("publishes, searches, and adds folder package execution profile", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-registry-x-"));
    const registryDir = path.join(tempDir, "registry");
    const skillsDir = path.join(tempDir, "skills");
    const signingKey = testManifestSigningKey();
    const trustEnv = registryTrustEnv("acme", signingKey);

    try {
      const publishOut = createMemoryStream();
      const publishErr = createMemoryStream();
      await expect(
        runCli(
          ["skill", "publish", "skills/sourcey", "--owner", "acme", "--version", "1.0.0", "--registry", registryDir, "--json"],
          { stdin: process.stdin, stdout: publishOut, stderr: publishErr },
          { ...process.env, RUNX_CWD: process.cwd(), RUNX_DEV_RUST_CLI_BIN: nativeRunxBinaryForTest(), ...trustEnv },
        ),
      ).resolves.toBe(0);
      expect(publishErr.contents()).toBe("");
      signPublishedRegistryEntry(registryDir, signingKey);
      expect(JSON.parse(publishOut.contents()).registry.publish).toMatchObject({
        skill_id: "acme/sourcey",
        runner_names: ["sourcey"],
        profile_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        harness: {
          status: "not_declared",
          case_count: 0,
        },
      });

      const searchOut = createMemoryStream();
      const searchErr = createMemoryStream();
      await expect(
        runCli(
          ["skill", "search", "sourcey", "--json"],
          { stdin: process.stdin, stdout: searchOut, stderr: searchErr },
          {
            ...process.env,
            RUNX_CWD: process.cwd(),
            RUNX_DEV_RUST_CLI_BIN: nativeRunxBinaryForTest(),
            RUNX_REGISTRY_DIR: registryDir,
            ...trustEnv,
          },
        ),
      ).resolves.toBe(0);
      expect(searchErr.contents()).toBe("");
      expect(JSON.parse(searchOut.contents()).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skill_id: "acme/sourcey",
            profile_mode: "profiled",
            runner_names: ["sourcey"],
            profile_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
      );

      const addOut = createMemoryStream();
      const addErr = createMemoryStream();
      await expect(
        runCli(
          ["add", "acme/sourcey@1.0.0", "--to", skillsDir, "--json"],
          { stdin: process.stdin, stdout: addOut, stderr: addErr },
          {
            ...process.env,
            RUNX_CWD: process.cwd(),
            RUNX_DEV_RUST_CLI_BIN: nativeRunxBinaryForTest(),
            RUNX_REGISTRY_DIR: registryDir,
            ...trustEnv,
          },
        ),
      ).resolves.toBe(0);
      expect(addErr.contents()).toBe("");
      const installedSkillDir = path.join(skillsDir, "acme", "sourcey", "1.0.0");
      expect(JSON.parse(addOut.contents()).registry.install).toMatchObject({
        destination: path.join(installedSkillDir, "SKILL.md"),
        profile_state_path: path.join(installedSkillDir, ".runx", "profile.json"),
        runner_names: ["sourcey"],
      });
      await expect(readFile(path.join(installedSkillDir, ".runx", "profile.json"), "utf8")).resolves.toContain(
        "tool: sourcey.build",
      );
      await expect(readRegistryVersion(registryDir, "acme/sourcey", "1.0.0")).resolves.toMatchObject({
        runner_names: ["sourcey"],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}

interface TestManifestSigningKey {
  readonly keyId: string;
  readonly signerId: string;
  readonly publicKeyBase64: string;
  readonly privateKey: KeyObject;
}

let cachedManifestSigningKey: TestManifestSigningKey | undefined;

function testManifestSigningKey(): TestManifestSigningKey {
  if (cachedManifestSigningKey) {
    return cachedManifestSigningKey;
  }
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  const publicKeyRaw = Buffer.from(publicKeyDer).subarray(-32);
  cachedManifestSigningKey = {
    keyId: "runx-test-registry-ed25519",
    signerId: "runx-test-registry",
    publicKeyBase64: publicKeyRaw.toString("base64"),
    privateKey: keyPair.privateKey,
  };
  return cachedManifestSigningKey;
}

function registryTrustEnv(owner: string, signingKey: TestManifestSigningKey): NodeJS.ProcessEnv {
  return {
    RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID: signingKey.keyId,
    RUNX_REGISTRY_MANIFEST_TRUST_KEY_BASE64: signingKey.publicKeyBase64,
    RUNX_REGISTRY_MANIFEST_TRUST_OWNER: owner,
  };
}

function nativeRunxBinaryForTest(): string {
  const existing = process.env.RUNX_DEV_RUST_CLI_BIN;
  if (existing) {
    return existing;
  }
  const candidate = path.resolve("crates/target/debug/runx");
  return existsSync(candidate) ? candidate : "runx";
}

function signPublishedRegistryEntry(registryDir: string, signingKey: TestManifestSigningKey): void {
  const entryPath = findSingleRegistryEntry(registryDir);
  const entry = JSON.parse(readFileSync(entryPath, "utf8")) as {
    skill_id: string;
    version: string;
    digest: string;
    profile_digest?: string;
    package_digest?: string;
    signed_manifest?: unknown;
  };
  const payload =
    "runx.registry.signed_manifest.v1\n" +
    `skill_id=${entry.skill_id}\n` +
    `version=${entry.version}\n` +
    `digest=${entry.digest}\n` +
    `profile_digest=${entry.profile_digest ?? ""}\n` +
    `package_digest=${entry.package_digest ?? ""}\n` +
    `signer_id=${signingKey.signerId}\n` +
    `key_id=${signingKey.keyId}\n`;
  entry.signed_manifest = {
    schema: "runx.registry.signed_manifest.v1",
    skill_id: entry.skill_id,
    version: entry.version,
    digest: entry.digest,
    ...(entry.profile_digest ? { profile_digest: entry.profile_digest } : {}),
    ...(entry.package_digest ? { package_digest: entry.package_digest } : {}),
    signer: {
      id: signingKey.signerId,
      key_id: signingKey.keyId,
    },
    signature: {
      alg: "ed25519",
      value: `base64:${sign(null, Buffer.from(payload), signingKey.privateKey).toString("base64")}`,
    },
  };
  writeFileSync(entryPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

function findSingleRegistryEntry(root: string): string {
  const matches: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const entryPath = path.join(dir, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
      } else if (entryPath.endsWith(".json")) {
        matches.push(entryPath);
      }
    }
  };
  walk(root);
  if (matches.length !== 1) {
    throw new Error(`expected one registry fixture entry, found ${matches.length}`);
  }
  return matches[0];
}

async function readRegistryVersion(
  registryDir: string,
  skillId: string,
  version: string,
): Promise<Record<string, unknown>> {
  const [owner, name] = skillId.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid registry skill id: ${skillId}`);
  }
  return JSON.parse(
    await readFile(
      path.join(registryDir, encodeURIComponent(owner), encodeURIComponent(name), `${encodeURIComponent(version)}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

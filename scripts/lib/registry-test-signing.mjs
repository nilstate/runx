import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SIGNED_MANIFEST_SCHEMA = "runx.registry.signed_manifest.v1";

export function createRegistryTestSigningKey({
  keyId = "runx-test-registry-ed25519",
  signerId = "runx-test-registry",
} = {}) {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  return {
    keyId,
    signerId,
    publicKeyBase64: Buffer.from(publicKeyDer).subarray(-32).toString("base64"),
    privateKey: keyPair.privateKey,
  };
}

export function signSingleRegistryVersion(registryDirectory, signingKey) {
  const versionPath = findSingleRegistryVersion(registryDirectory);
  const version = JSON.parse(readFileSync(versionPath, "utf8"));
  const payload = signedManifestPayload(version, signingKey);
  version.signed_manifest = {
    schema: SIGNED_MANIFEST_SCHEMA,
    skill_id: requiredString(version, "skill_id"),
    version: requiredString(version, "version"),
    digest: requiredString(version, "digest"),
    ...(optionalString(version, "profile_digest")
      ? { profile_digest: version.profile_digest }
      : {}),
    ...(optionalString(version, "package_digest")
      ? { package_digest: version.package_digest }
      : {}),
    signer: {
      id: signingKey.signerId,
      key_id: signingKey.keyId,
    },
    signature: {
      alg: "ed25519",
      value: `base64:${sign(
        null,
        Buffer.from(payload),
        signingKey.privateKey,
      ).toString("base64url")}`,
    },
  };
  writeFileSync(versionPath, `${JSON.stringify(version, null, 2)}\n`, "utf8");
  return versionPath;
}

function signedManifestPayload(version, signingKey) {
  return [
    SIGNED_MANIFEST_SCHEMA,
    `skill_id=${requiredString(version, "skill_id")}`,
    `version=${requiredString(version, "version")}`,
    `digest=${requiredString(version, "digest")}`,
    `profile_digest=${optionalString(version, "profile_digest")}`,
    `package_digest=${optionalString(version, "package_digest")}`,
    `signer_id=${signingKey.signerId}`,
    `key_id=${signingKey.keyId}`,
    "",
  ].join("\n");
}

function findSingleRegistryVersion(root) {
  const matches = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
      } else if (entryPath.endsWith(".json")) {
        matches.push(entryPath);
      }
    }
  };
  walk(root);
  if (matches.length !== 1) {
    throw new Error(`expected one registry version, found ${matches.length}`);
  }
  return matches[0];
}

function requiredString(object, field) {
  const value = optionalString(object, field);
  if (!value) throw new Error(`registry version is missing ${field}`);
  return value;
}

function optionalString(object, field) {
  const value = object?.[field];
  return typeof value === "string" ? value : "";
}

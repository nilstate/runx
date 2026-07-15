#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const cargoTargetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(workspaceRoot, process.env.CARGO_TARGET_DIR)
  : path.join(workspaceRoot, "crates", "target");
const rustKernelBin = path.join(
  cargoTargetDir,
  "debug",
  process.platform === "win32" ? "runx.exe" : "runx",
);
const dogfoodEnv = {
  ...process.env,
  RUNX_KERNEL_EVAL_BIN: rustKernelBin,
  RUNX_RECEIPT_SIGN_KID: process.env.RUNX_RECEIPT_SIGN_KID ?? "runx-dogfood-test-key",
  RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:
    process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64 ?? "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
  RUNX_RECEIPT_SIGN_ISSUER_TYPE: process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE ?? "hosted",
};
const registryResolverOnly = process.argv.includes("--registry-resolver");

if (registryResolverOnly) {
  runRegistryResolverDogfood();
  process.exit(0);
}

const steps = [
  {
    label: "build rust kernel eval binary",
    command: cargo,
    args: ["build", "--quiet", "--manifest-path", "crates/Cargo.toml", "-p", "runx-cli", "--bin", "runx"],
  },
  {
    label: "prove rust payment runtime",
    command: cargo,
    args: ["test", "--quiet", "--manifest-path", "crates/Cargo.toml", "-p", "runx-runtime", "--test", "payment_execution"],
  },
  {
    label: "prove rust Stripe SPT payment runtime",
    command: cargo,
    args: ["test", "--quiet", "--manifest-path", "crates/Cargo.toml", "-p", "runx-runtime", "--test", "stripe_spt_payment"],
  },
  {
    label: "prove native x402 mock dogfood CLI",
    command: cargo,
    args: ["test", "--quiet", "--manifest-path", "crates/Cargo.toml", "-p", "runx-cli", "--test", "x402_native_dogfood"],
  },
  {
    label: "build workspace packages",
    command: pnpm,
    args: ["build"],
  },
  {
    label: "run workspace doctor",
    command: rustKernelBin,
    args: ["doctor", "--json"],
  },
  {
    label: "prove payment skill profiles",
    command: pnpm,
    args: ["exec", "vitest", "run", "tests/payment-skill-profile-validation.test.ts"],
  },
  {
    label: "prove official skills with a fresh caller",
    command: pnpm,
    args: ["exec", "vitest", "run", "tests/external-skill-proving-ground.test.ts"],
  },
];

for (const step of steps) {
  process.stdout.write(`\n[dogfood] ${step.label}\n`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    shell: false,
    cwd: workspaceRoot,
    env: dogfoodEnv,
  });
  if (result.status === 0) {
    continue;
  }
  process.exit(result.status ?? 1);
}

function runRegistryResolverDogfood() {
  runStep({
    label: "build native runx binary",
    command: cargo,
    args: ["build", "--quiet", "--manifest-path", "crates/Cargo.toml", "-p", "runx-cli", "--bin", "runx"],
  });

  const root = mkdtempSync(path.join(os.tmpdir(), "runx-registry-dogfood-"));
  try {
    const registryDir = path.join(root, "registry");
    const skillDir = path.join(root, "echo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillDirPath(skillDir, "SKILL.md"), "---\nname: echo\n---\n# Echo\n", "utf8");
    writeFileSync(
      skillDirPath(skillDir, "X.yaml"),
      "skill: echo\nrunners:\n  default:\n    type: agent\n    default: true\n",
      "utf8",
    );

    const signingKey = testManifestSigningKey();
    const env = {
      ...dogfoodEnv,
      RUNX_HOME: path.join(root, "home"),
      RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID: signingKey.keyId,
      RUNX_REGISTRY_MANIFEST_TRUST_KEY_BASE64: signingKey.publicKeyBase64,
      RUNX_REGISTRY_MANIFEST_TRUST_OWNER: "acme",
    };

    runStep({
      label: "publish signed local registry skill",
      command: rustKernelBin,
      args: [
        "registry",
        "publish",
        skillDir,
        "--registry-dir",
        registryDir,
        "--owner",
        "acme",
        "--version",
        "1.0.0",
        "--json",
      ],
      env,
    });
    signPublishedRegistryEntry(registryDir, signingKey);

    const result = spawnSync(
      rustKernelBin,
      [
        "skill",
        "acme/echo@1.0.0",
        "--registry",
        registryDir,
        "--json",
        "--non-interactive",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        cwd: workspaceRoot,
        env,
        encoding: "utf8",
      },
    );
    if (result.status !== 2) {
      process.stderr.write(result.stderr || result.stdout);
      throw new Error(`native registry skill dogfood exited ${result.status}, expected 2`);
    }
    const output = JSON.parse(result.stdout);
    const skillDirectory = output.requests?.[0]?.invocation?.envelope?.execution_location?.skill_directory;
    if (!skillDirectory || !String(skillDirectory).includes("registry-skills")) {
      throw new Error(`native registry resolver did not report a registry cache path: ${skillDirectory}`);
    }
    if (!statSync(path.join(skillDirectory, "SKILL.md")).isFile()) {
      throw new Error(`native registry resolver did not materialize ${skillDirectory}/SKILL.md`);
    }
    process.stdout.write(`[dogfood] native registry skill resolved to ${skillDirectory}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runStep(step) {
  process.stdout.write(`\n[dogfood] ${step.label}\n`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    shell: false,
    cwd: workspaceRoot,
    env: step.env ?? dogfoodEnv,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function skillDirPath(skillDir, file) {
  return path.join(skillDir, file);
}

function testManifestSigningKey() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  return {
    keyId: "runx-dogfood-registry-ed25519",
    signerId: "runx-dogfood-registry",
    publicKeyBase64: Buffer.from(publicKeyDer).subarray(-32).toString("base64"),
    privateKey: keyPair.privateKey,
  };
}

function signPublishedRegistryEntry(registryDir, signingKey) {
  const entryPath = findSingleRegistryEntry(registryDir);
  const entry = JSON.parse(readFileSync(entryPath, "utf8"));
  const payload =
    "runx.registry.signed_manifest.v1\n" +
    `skill_id=${entry.skill_id}\n` +
    `version=${entry.version}\n` +
    `digest=${entry.digest}\n` +
    `profile_digest=${entry.profile_digest ?? ""}\n` +
    `signer_id=${signingKey.signerId}\n` +
    `key_id=${signingKey.keyId}\n`;
  entry.signed_manifest = {
    schema: "runx.registry.signed_manifest.v1",
    skill_id: entry.skill_id,
    version: entry.version,
    digest: entry.digest,
    ...(entry.profile_digest ? { profile_digest: entry.profile_digest } : {}),
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

function findSingleRegistryEntry(root) {
  const matches = [];
  const walk = (dir) => {
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

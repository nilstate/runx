import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DEMO_SEED_B64 = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
const VERIFY = path.resolve("tools/verify/verify.mjs");
const EXAMPLE_VERIFY = path.resolve("examples/governed-spend/verify.mjs");

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runx-verify-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("governed-spend receipt verifier", () => {
  it("walks a signed receipt ancestry tree offline", () => {
    const child = seal(receipt("child", { lineage: { parent: placeholderRef("root") } }));
    const root = seal(receipt("root", {
      lineage: {
        children: [receiptRef(child.id, child.digest)],
      },
    }));
    child.lineage.parent = receiptRef(root.id);
    const resealedChild = seal(child);
    root.lineage.children = [receiptRef(resealedChild.id, resealedChild.digest)];
    const resealedRoot = seal(root);

    writeReceipt(resealedRoot);
    writeReceipt(resealedChild);

    const jwksPath = writeJwks();
    const output = execFileSync("node", [
      VERIFY,
      receiptPath(resealedRoot.id),
      "--walk-ancestry",
      "--jwks",
      jwksPath,
    ], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    expect(output).toContain("VERIFIED: runx signed this receipt tree");
    expect(output).toContain("lineage child 0 locator matches child digest");
  });

  it("fails when a lineage child locator does not match the child digest", () => {
    const child = seal(receipt("child"));
    const root = seal(receipt("root", {
      lineage: {
        children: [receiptRef(child.id, "sha256:bad")],
      },
    }));
    writeReceipt(root);
    writeReceipt(child);

    expect(() => execFileSync("node", [VERIFY, receiptPath(root.id), "--walk-ancestry"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow();
  });

  it("ignores stale graph-state snapshots when top-level receipts exist", () => {
    const child = seal(receipt("child", { lineage: { parent: placeholderRef("root") } }));
    const root = seal(receipt("root", {
      lineage: {
        children: [receiptRef(child.id, child.digest)],
      },
    }));
    const staleChild = structuredClone(child);
    child.lineage.parent = receiptRef(root.id);
    const resealedChild = seal(child);
    root.lineage.children = [receiptRef(resealedChild.id, resealedChild.digest)];
    const resealedRoot = seal(root);

    writeReceipt(resealedRoot);
    writeReceipt(resealedChild);
    const runsDir = path.join(tempDir, "runs");
    fs.mkdirSync(runsDir);
    fs.writeFileSync(path.join(runsDir, "run.graph-state.json"), JSON.stringify({
      schema: "runx.graph_skill_state.v1",
      checkpoint: {
        steps: [{ receipt: staleChild }],
      },
    }));

    const output = execFileSync("node", [VERIFY, receiptPath(resealedRoot.id), "--walk-ancestry"], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    expect(output).toContain("VERIFIED: runx signed this receipt tree");
    expect(output).toContain("lineage child 0 locator matches child digest");
  });

  it("keeps the governed-spend verifier path as a wrapper", () => {
    const root = seal(receipt("root"));
    writeReceipt(root);

    const output = execFileSync("node", [EXAMPLE_VERIFY, receiptPath(root.id)], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    expect(output).toContain("VERIFIED: runx signed exactly this receipt content");
  });
});

function receipt(label: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: "runx.receipt.v1",
    id: `placeholder-${label}`,
    created_at: "2026-06-05T00:00:00Z",
    canonicalization: "runx.receipt.c14n.v1",
    issuer: {
      type: "hosted",
      kid: "runx-demo-key",
      public_key_sha256: publicKeyHash(),
    },
    signature: {
      alg: "Ed25519",
      value: "base64:pending",
    },
    digest: "sha256:pending",
    idempotency: {
      intent_key: `sha256:intent-${label}`,
      trigger_fingerprint: `sha256:trigger-${label}`,
      content_hash: `sha256:content-${label}`,
    },
    subject: {
      kind: "skill",
      ref: { type: "harness", uri: `runx:harness:${label}` },
      commitments: [],
    },
    authority: {
      actor_ref: { type: "principal", uri: "runx:principal:test" },
      grant_refs: [],
      scope_refs: [],
      authority_proof_refs: [],
      attenuation: {},
      terms: [],
      enforcement: {
        profile_hash: `sha256:profile-${label}`,
        redaction_refs: [],
        setup_refs: [],
        teardown_refs: [],
      },
    },
    signals: [],
    decisions: [],
    acts: [],
    seal: {
      disposition: "closed",
      reason_code: "ok",
      summary: `${label} sealed`,
      closed_at: "2026-06-05T00:00:00Z",
      last_observed_at: "2026-06-05T00:00:00Z",
      criteria: [],
    },
    ...overrides,
  };
}

function seal(input: any) {
  const sealed = structuredClone(input);
  sealed.id = sha256(canon(identityBody(sealed)));
  sealed.digest = sha256(canon(receiptBody(sealed)));
  sealed.signature.value = `base64:${crypto.sign(null, Buffer.from(sealed.digest), privateKey()).toString("base64url")}`;
  return sealed;
}

function writeReceipt(r: any) {
  fs.writeFileSync(receiptPath(r.id), `${JSON.stringify(r)}\n`);
}

function writeJwks() {
  const jwksPath = path.join(tempDir, "jwks.json");
  fs.writeFileSync(jwksPath, `${JSON.stringify({
    keys: [{
      kty: "OKP",
      crv: "Ed25519",
      kid: "runx-demo-key",
      alg: "EdDSA",
      use: "sig",
      x: publicKeyRaw().toString("base64url"),
    }],
  })}\n`);
  return jwksPath;
}

function receiptPath(id: string) {
  return path.join(tempDir, `${id}.json`);
}

function receiptRef(id: string, locator?: string) {
  return { type: "receipt", uri: `runx:receipt:${id}`, ...(locator ? { locator } : {}) };
}

function placeholderRef(label: string) {
  return { type: "receipt", uri: `runx:receipt:placeholder-${label}` };
}

function receiptBody(r: any) {
  const body = { ...r };
  delete body.signature;
  delete body.digest;
  delete body.metadata;
  return body;
}

function identityBody(r: any) {
  const body = receiptBody(r);
  delete body.id;
  delete body.lineage;
  return body;
}

function canon(value: any): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(",")}}`;
}

function sha256(text: string) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function privateKey() {
  const seed = Buffer.from(DEMO_SEED_B64, "base64");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function publicKeyHash() {
  const raw = publicKeyRaw();
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function publicKeyRaw(): Buffer {
  const publicKey = crypto.createPublicKey(privateKey().export({ format: "pem", type: "pkcs8" }));
  return Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
}

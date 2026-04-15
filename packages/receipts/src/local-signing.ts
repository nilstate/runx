import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LocalKeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly kid: string;
  readonly publicKeySha256: string;
}

export interface LocalIssuer {
  readonly type: "local";
  readonly kid: string;
  readonly public_key_sha256: string;
}

export interface LocalSignature {
  readonly alg: "Ed25519";
  readonly value: string;
}

export async function loadOrCreateLocalKey(runxHome = defaultRunxHome()): Promise<LocalKeyPair> {
  const keyDir = path.join(runxHome, "keys");
  const privateKeyPath = path.join(keyDir, "local-ed25519-private.pem");
  const publicKeyPath = path.join(keyDir, "local-ed25519-public.pem");

  const loaded = await tryLoadKeyPair(privateKeyPath, publicKeyPath);
  if (loaded) {
    return loaded;
  }

  try {
    await mkdir(keyDir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    await Promise.all([
      writeFile(privateKeyPath, privatePem, { flag: "wx", mode: 0o600 }),
      writeFile(publicKeyPath, publicPem, { flag: "wx", mode: 0o644 }),
    ]);
    return keyPairFromPem(privatePem, publicPem);
  } catch (writeError: unknown) {
    if (isNodeError(writeError) && writeError.code === "EEXIST") {
      const retried = await tryLoadKeyPair(privateKeyPath, publicKeyPath);
      if (retried) {
        return retried;
      }
    }
    throw new Error(
      `runx signing key creation failed at ${privateKeyPath}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
    );
  }
}

export async function loadLocalPublicKey(
  runxHome = defaultRunxHome(),
): Promise<Pick<LocalKeyPair, "publicKey" | "publicKeySha256"> | undefined> {
  const publicKeyPath = path.join(runxHome, "keys", "local-ed25519-public.pem");
  try {
    const publicPem = await readFile(publicKeyPath, "utf8");
    const publicKey = createPublicKey(publicPem);
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    return {
      publicKey,
      publicKeySha256: createHash("sha256").update(publicDer).digest("hex"),
    };
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

export function localIssuer(keyPair: Pick<LocalKeyPair, "kid" | "publicKeySha256">): LocalIssuer {
  return {
    type: "local",
    kid: keyPair.kid,
    public_key_sha256: keyPair.publicKeySha256,
  };
}

export function signPayloadString(payload: string, privateKey: KeyObject): LocalSignature {
  return {
    alg: "Ed25519",
    value: Buffer.from(sign(null, Buffer.from(payload), privateKey)).toString("base64url"),
  };
}

export function verifyPayloadString(payload: string, signature: LocalSignature, publicKey: KeyObject): boolean {
  return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature.value, "base64url"));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function keyPairFromPem(privatePem: string, publicPem: string): LocalKeyPair {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeySha256 = createHash("sha256").update(publicDer).digest("hex");

  return {
    privateKey,
    publicKey,
    kid: `local_${publicKeySha256.slice(0, 16)}`,
    publicKeySha256,
  };
}

async function tryLoadKeyPair(privatePath: string, publicPath: string, retries = 2): Promise<LocalKeyPair | null> {
  try {
    const [privatePem, publicPem] = await Promise.all([readFile(privatePath, "utf8"), readFile(publicPath, "utf8")]);

    if (process.platform !== "win32") {
      const info = await stat(privatePath);
      const mode = info.mode & 0o777;
      if (mode !== 0o600) {
        process.stderr.write(`warning: ${privatePath} has permissions ${mode.toString(8)}, expected 600\n`);
      }
    }

    return keyPairFromPem(privatePem, publicPem);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return tryLoadKeyPair(privatePath, publicPath, retries - 1);
      }
      return null;
    }
    throw new Error(
      `runx signing key unreadable at ${privatePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function defaultRunxHome(): string {
  return process.env.RUNX_HOME ?? path.join(os.homedir(), ".runx");
}

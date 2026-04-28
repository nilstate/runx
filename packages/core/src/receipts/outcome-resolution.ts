import crypto from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateOutcomeResolutionContract } from "@runxhq/contracts";

import { errorMessage, isNotFound } from "../util/types.js";

export type OutcomeState = "pending" | "complete" | "expired";

import {
  loadLocalPublicKey,
  loadOrCreateLocalKey,
  localIssuer,
  signPayloadString,
  stableStringify,
  verifyPayloadString,
  type LocalIssuer,
  type LocalSignature,
} from "./local-signing.js";

export interface ReceiptOutcome {
  readonly code?: string;
  readonly summary?: string;
  readonly observed_at?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface OutcomeResolutionVerification {
  readonly status: "verified" | "unverified" | "invalid";
  readonly reason?: string;
}

export interface ReceiptOutcomeResolution {
  readonly schema_version: "runx.receipt.outcome-resolution.v1";
  readonly id: string;
  readonly receipt_id: string;
  readonly outcome_state: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly source?: string;
  readonly created_at: string;
  readonly issuer: LocalIssuer;
  readonly signature: LocalSignature;
}

export interface VerifiedReceiptOutcomeResolution {
  readonly resolution: ReceiptOutcomeResolution;
  readonly verification: OutcomeResolutionVerification;
}

export interface WriteReceiptOutcomeResolutionOptions {
  readonly receiptDir: string;
  readonly runxHome?: string;
  readonly receiptId: string;
  readonly outcomeState: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly source?: string;
  readonly createdAt?: string;
  readonly resolutionId?: string;
}

export async function writeReceiptOutcomeResolution(
  options: WriteReceiptOutcomeResolutionOptions,
): Promise<ReceiptOutcomeResolution> {
  assertReceiptLikeId(options.receiptId);
  const keyPair = await loadOrCreateLocalKey(options.runxHome);
  const resolution = buildReceiptOutcomeResolution(options, keyPair);
  const directory = outcomeResolutionDirectory(options.receiptDir);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${resolution.id}.json`), `${JSON.stringify(resolution, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return resolution;
}

async function readReceiptOutcomeResolution(
  receiptDir: string,
  resolutionId: string,
): Promise<ReceiptOutcomeResolution> {
  assertOutcomeResolutionId(resolutionId);
  const resolutionPath = path.join(outcomeResolutionDirectory(receiptDir), `${resolutionId}.json`);
  const contents = await readFile(resolutionPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${resolutionPath} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  return validateOutcomeResolutionContract(parsed, resolutionPath) as ReceiptOutcomeResolution;
}

export async function readVerifiedReceiptOutcomeResolution(
  receiptDir: string,
  resolutionId: string,
  runxHome: string,
): Promise<VerifiedReceiptOutcomeResolution> {
  const resolution = await readReceiptOutcomeResolution(receiptDir, resolutionId);
  return {
    resolution,
    verification: await verifyReceiptOutcomeResolutionFromLocalKey(resolution, runxHome),
  };
}

async function listReceiptOutcomeResolutions(
  receiptDir: string,
  receiptId?: string,
): Promise<readonly ReceiptOutcomeResolution[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(outcomeResolutionDirectory(receiptDir));
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const resolutions = await Promise.all(
    entries
      .filter((entry) => /^or_[A-Za-z0-9_-]+\.json$/.test(entry))
      .map(async (entry) => readReceiptOutcomeResolution(receiptDir, entry.slice(0, -".json".length))),
  );
  return resolutions
    .filter((resolution) => !receiptId || resolution.receipt_id === receiptId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function listVerifiedReceiptOutcomeResolutions(
  receiptDir: string,
  runxHome: string,
  receiptId?: string,
): Promise<readonly VerifiedReceiptOutcomeResolution[]> {
  const resolutions = await listReceiptOutcomeResolutions(receiptDir, receiptId);
  return await Promise.all(
    resolutions.map(async (resolution) => ({
      resolution,
      verification: await verifyReceiptOutcomeResolutionFromLocalKey(resolution, runxHome),
    })),
  );
}

export async function latestVerifiedReceiptOutcomeResolution(
  receiptDir: string,
  receiptId: string,
  runxHome: string,
): Promise<VerifiedReceiptOutcomeResolution | undefined> {
  const resolutions = await listVerifiedReceiptOutcomeResolutions(receiptDir, runxHome, receiptId);
  return resolutions[0];
}

export function buildReceiptOutcomeResolution(
  options: Omit<WriteReceiptOutcomeResolutionOptions, "receiptDir" | "runxHome">,
  keyPair: Awaited<ReturnType<typeof loadOrCreateLocalKey>>,
): ReceiptOutcomeResolution {
  assertReceiptLikeId(options.receiptId);
  const signedPayload = {
    schema_version: "runx.receipt.outcome-resolution.v1" as const,
    id: options.resolutionId ?? uniqueOutcomeResolutionId(),
    receipt_id: options.receiptId,
    outcome_state: options.outcomeState,
    outcome: options.outcome,
    source: options.source,
    created_at: options.createdAt ?? new Date().toISOString(),
  };
  return {
    ...signedPayload,
    issuer: localIssuer(keyPair),
    signature: signPayloadString(stableStringify({ ...signedPayload, issuer: localIssuer(keyPair) }), keyPair.privateKey),
  };
}

export function verifyReceiptOutcomeResolution(
  resolution: ReceiptOutcomeResolution,
  publicKey: Awaited<ReturnType<typeof loadLocalPublicKey>> extends infer T
    ? T extends { publicKey: infer P }
      ? P
      : never
    : never,
): boolean {
  const { signature, ...signedPayload } = resolution;
  return verifyPayloadString(stableStringify(signedPayload), signature, publicKey);
}

function outcomeResolutionDirectory(receiptDir: string): string {
  return path.join(receiptDir, "outcome-resolutions");
}

function uniqueOutcomeResolutionId(): string {
  return `or_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function assertReceiptLikeId(id: string): void {
  if (!/^(rx|gx)_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid receipt id '${id}'.`);
  }
}

function assertOutcomeResolutionId(id: string): void {
  if (!/^or_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid outcome resolution id '${id}'.`);
  }
}

async function verifyReceiptOutcomeResolutionFromLocalKey(
  resolution: ReceiptOutcomeResolution,
  runxHome: string,
): Promise<OutcomeResolutionVerification> {
  if (resolution.schema_version !== "runx.receipt.outcome-resolution.v1" || resolution.signature?.alg !== "Ed25519") {
    return {
      status: "unverified",
      reason: "unsupported_outcome_resolution_version_or_signature_algorithm",
    };
  }

  const publicKey = await loadLocalPublicKey(runxHome);
  if (!publicKey) {
    return {
      status: "unverified",
      reason: "local_public_key_missing",
    };
  }

  if (resolution.issuer.public_key_sha256 !== publicKey.publicKeySha256) {
    return {
      status: "unverified",
      reason: "local_public_key_mismatch",
    };
  }

  try {
    return verifyReceiptOutcomeResolution(resolution, publicKey.publicKey)
      ? { status: "verified" }
      : { status: "invalid", reason: "signature_mismatch" };
  } catch {
    return { status: "invalid", reason: "signature_mismatch" };
  }
}

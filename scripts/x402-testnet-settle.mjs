#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Prefixed, signedDemoReceipt } from "./lib/demo-receipts.mjs";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const REQUEST_SCHEMA = "runx.external_signer.request.v1";
const RESPONSE_SCHEMA = "runx.external_signer.response.v1";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--help" || command === "-h") {
  usage(0);
}

if (command === "--inspect") {
  const moneyMovementId = args[1]?.trim();
  if (!moneyMovementId) {
    fail("missing money_movement_id for --inspect");
  }
  inspect(moneyMovementId);
} else if (command === "--demo") {
  await demo(parseDemoOptions(args.slice(1)));
} else {
  usage(1);
}

function inspect(moneyMovementId) {
  const status = process.env.RUNX_X402_INSPECT_STATUS?.trim() || "unresolved";
  switch (status) {
    case "settled":
      inspectSettled(moneyMovementId);
      break;
    case "not_charged":
      write({
        schema: "runx.x402.inspect.v1",
        status: "not_charged",
        money_movement_id: moneyMovementId,
        reason: process.env.RUNX_X402_INSPECT_REASON || "rail reported no charge",
      });
      break;
    case "unresolved":
      write({
        schema: "runx.x402.inspect.v1",
        status: "unresolved",
        money_movement_id: moneyMovementId,
        reason:
          process.env.RUNX_X402_INSPECT_REASON ||
          "set RUNX_X402_INSPECT_STATUS to settled or not_charged, or run --demo with a live facilitator",
      });
      process.exitCode = 2;
      break;
    default:
      fail(`unsupported RUNX_X402_INSPECT_STATUS '${status}'`);
  }
}

async function demo(options) {
  const requestedMode = envOr("RUNX_X402_DEMO_MODE", "auto");
  if (requestedMode !== "auto" && requestedMode !== "mock" && requestedMode !== "live") {
    fail("RUNX_X402_DEMO_MODE must be auto, mock, or live");
  }
  const liveReady = Boolean(envOr("RUNX_X402_FACILITATOR", "") && envOr("RUNX_X402_SIGNER", ""));
  if (requestedMode === "live" && !liveReady) {
    fail("live mode requires RUNX_X402_FACILITATOR and RUNX_X402_SIGNER");
  }
  const mode =
    requestedMode === "mock" ? "mock" : requestedMode === "live" || liveReady ? "live" : "mock";
  const receiptDir = options.receiptDir || mkdtempSync(path.join(os.tmpdir(), "runx-x402-demo-"));
  mkdirSync(receiptDir, { recursive: true });
  const settlement = mode === "mock" ? mockSettlement() : await liveSettlement();
  const refusal = governedRefusal(receiptDir);
  const receiptArtifacts = writeDemoReceipts(receiptDir, settlement, refusal);
  const report = {
    schema: "runx.x402.demo.v1",
    mode,
    operator_keyed: mode === "live",
    receipt_dir: receiptDir,
    settlement,
    refusal,
    receipts: receiptArtifacts,
    reconcile_command:
      "(cd ../cloud && pnpm payment:reconcile-settlements -- --payment-rail x402 --lookup-command \"node ../oss/scripts/x402-testnet-settle.mjs --inspect\" --older-than 0s)",
  };
  writeFileSync(path.join(receiptDir, "x402-demo-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  write(report);
}

async function liveSettlement() {
  const facilitator = requiredEnv("RUNX_X402_FACILITATOR").replace(/\/+$/, "");
  const signer = requiredEnv("RUNX_X402_SIGNER");
  const admissionToken = admissionTokenFromEnv();
  const template = templateFromEnv(admissionToken);
  const templateDigest = sha256Prefixed(JSON.stringify(template));
  const signerRequest = {
    schema: REQUEST_SCHEMA,
    admission_token: admissionToken,
    template,
    template_digest: templateDigest,
  };
  const signed = await postJson(signer, signerRequest);
  validateSignerResponse(signed, templateDigest);
  const payment = {
    payment_signature: signed.signature,
    template_digest: templateDigest,
    money_movement_id: admissionToken.money_movement_id,
  };
  const verified = await postJson(`${facilitator}/verify`, payment);
  if (verified.status !== "verified") {
    fail(`facilitator verify refused: ${verified.message || verified.status || "unknown"}`);
  }
  const settled = await postJson(`${facilitator}/settle`, payment);
  if (settled.status !== "settled" || typeof settled.tx_hash !== "string" || !TX_HASH.test(settled.tx_hash)) {
    fail("facilitator settle must return { status: 'settled', tx_hash: '0x...' }");
  }
  return settlementReport({
    admissionToken,
    templateDigest,
    txHash: settled.tx_hash,
    signerAddress: signed.signer_address,
    facilitator,
    log: settled.log ?? null,
  });
}

function mockSettlement() {
  const admissionToken = admissionTokenFromEnv({
    moneyMovementId: process.env.RUNX_X402_MONEY_MOVEMENT_ID || "mmid_x402_mock_demo",
  });
  const template = templateFromEnv(admissionToken, {
    chainId: 84532,
    tokenContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verifyingContract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    from: "0x1111111111111111111111111111111111111111",
    payTo: "0x2222222222222222222222222222222222222222",
  });
  const txHash =
    process.env.RUNX_X402_TX_HASH ||
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  if (!TX_HASH.test(txHash)) {
    fail("RUNX_X402_TX_HASH must be a 32-byte 0x-prefixed transaction hash");
  }
  return settlementReport({
    admissionToken,
    templateDigest: sha256Prefixed(JSON.stringify(template)),
    txHash,
    signerAddress: template.from,
    facilitator: "mock://x402-facilitator",
    log: { mode: "mock" },
  });
}

function settlementReport(input) {
  return {
    status: "settled",
    rail: "x402",
    money_movement_id: input.admissionToken.money_movement_id,
    rail_reference: input.txHash,
    tx_hash: input.txHash,
    signer_address: input.signerAddress,
    template_digest: input.templateDigest,
    facilitator: input.facilitator,
    settlement_proof: {
      payment_admission_id: input.admissionToken.payment_admission_id,
      money_movement_id: input.admissionToken.money_movement_id,
      kernel_token_digest: input.admissionToken.kernel_token_digest,
      proof_locator: input.txHash,
      proof_status: "settled",
    },
    log: input.log,
  };
}

function governedRefusal(receiptDir) {
  const maxPerCall = numberEnv("RUNX_X402_MAX_PER_CALL_UNITS", 100);
  const attempted = numberEnv("RUNX_X402_DEMO_REFUSAL_AMOUNT_MINOR", maxPerCall + 25);
  const refused = attempted > maxPerCall;
  const harness = runGovernedRefusalHarness(receiptDir);
  return {
    status: refused ? "refused" : "allowed",
    reason_code: refused ? "cap_exceeded" : "within_cap",
    attempted_amount_minor: attempted,
    max_per_call_units: maxPerCall,
    rail_call_performed: false,
    signer_call_performed: false,
    harness,
  };
}

function writeDemoReceipts(receiptDir, settlement, refusal) {
  const railReceipt = signedDemoReceipt({
    name: "x402-testnet-settle",
    disposition: "sealed",
    reasonCode: "x402_settled",
    subject: {
      rail: "x402",
      money_movement_id: settlement.money_movement_id,
      tx_hash: settlement.tx_hash,
      rail_reference: settlement.rail_reference,
      proof_status: settlement.settlement_proof.proof_status,
    },
  });
  const refusalReceipt = signedDemoReceipt({
    name: "x402-testnet-settle",
    disposition: "refused",
    reasonCode: refusal.reason_code,
    subject: {
      rail: "x402",
      attempted_amount_minor: refusal.attempted_amount_minor,
      max_per_call_units: refusal.max_per_call_units,
      rail_call_performed: refusal.rail_call_performed,
      signer_call_performed: refusal.signer_call_performed,
    },
  });
  const settlementPath = path.join(receiptDir, "x402-settlement.receipt.json");
  const refusalPath = path.join(receiptDir, "x402-refusal.receipt.json");
  writeFileSync(settlementPath, `${JSON.stringify(railReceipt, null, 2)}\n`);
  writeFileSync(refusalPath, `${JSON.stringify(refusalReceipt, null, 2)}\n`);
  return {
    settlement: settlementPath,
    refusal: refusalPath,
    verify_settlement: `node tools/verify/verify.mjs ${settlementPath}`,
    verify_refusal: `node tools/verify/verify.mjs ${refusalPath}`,
  };
}

function runGovernedRefusalHarness(receiptDir) {
  const runx = process.env.RUNX_BIN || defaultRunxBinary();
  if (!runx) {
    return {
      status: "not_run",
      reason: "runx binary not found; set RUNX_BIN to capture the governed refusal receipt",
    };
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outPath = path.join(receiptDir, "governed-refusal.out.json");
  const errPath = path.join(receiptDir, "governed-refusal.err.txt");
  const result = spawnSync(
    runx,
    [
      "harness",
      "examples/governed-spend/skills/overspend-refused",
      "--json",
      "--receipt-dir",
      path.join(receiptDir, "governed-refusal-receipts"),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNX_RECEIPT_SIGN_KID: process.env.RUNX_RECEIPT_SIGN_KID || "runx-demo-key",
        RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:
          process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64 ||
          "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
        RUNX_RECEIPT_SIGN_ISSUER_TYPE: process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE || "hosted",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  writeFileSync(outPath, result.stdout || "");
  writeFileSync(errPath, result.stderr || "");
  return {
    status: result.status === 0 ? "sealed_refusal" : "runtime_refusal",
    exit_code: result.status,
    stdout: outPath,
    stderr: errPath,
    receipt_dir: path.join(receiptDir, "governed-refusal-receipts"),
  };
}

function inspectSettled(moneyMovementId) {
  const railReference =
    process.env.RUNX_X402_TX_HASH?.trim() ||
    process.env.RUNX_X402_RAIL_REFERENCE?.trim();
  if (!railReference || !TX_HASH.test(railReference)) {
    fail("RUNX_X402_TX_HASH must be a 32-byte 0x-prefixed transaction hash when status is settled");
  }
  write({
    schema: "runx.x402.inspect.v1",
    status: "settled",
    money_movement_id: moneyMovementId,
    tx_hash: railReference,
    rail_reference: railReference,
    settlement_proof: settlementProof(moneyMovementId, railReference),
    kernel_token: null,
  });
}

function settlementProof(moneyMovementId, railReference) {
  return pruneUndefined({
    payment_admission_id:
      process.env.RUNX_X402_PAYMENT_ADMISSION_ID ||
      process.env.RUNX_PAYMENT_ADMISSION_ID,
    money_movement_id:
      process.env.RUNX_X402_MONEY_MOVEMENT_ID ||
      process.env.RUNX_PAYMENT_MONEY_MOVEMENT_ID ||
      moneyMovementId,
    kernel_token_digest:
      process.env.RUNX_X402_KERNEL_TOKEN_DIGEST ||
      process.env.RUNX_PAYMENT_KERNEL_TOKEN_DIGEST,
    proof_locator: railReference,
    proof_status: "settled",
  });
}

function admissionTokenFromEnv(overrides = {}) {
  const amountMinor = numberEnv("RUNX_X402_AMOUNT_MINOR", 125);
  const moneyMovementId = overrides.moneyMovementId || requiredOrDefault("RUNX_X402_MONEY_MOVEMENT_ID", "mmid_x402_demo");
  return {
    purpose: "runx.payment_admission.v1",
    audience: "rail_settlement",
    principal: requiredOrDefault("RUNX_X402_PRINCIPAL", "principal_demo"),
    act: requiredOrDefault("RUNX_X402_ACT", "act_x402_demo"),
    rail: "x402",
    amount_minor: amountMinor,
    currency: requiredOrDefault("RUNX_X402_CURRENCY", "USD"),
    counterparty: requiredOrDefault("RUNX_X402_PAY_TO", "0x2222222222222222222222222222222222222222"),
    run_id: requiredOrDefault("RUNX_X402_RUN_ID", "run_x402_demo"),
    authority_digest: requiredOrDefault("RUNX_X402_AUTHORITY_DIGEST", "sha256:authority-demo"),
    expires_at: requiredOrDefault("RUNX_X402_EXPIRES_AT", "2026-06-01T00:05:00Z"),
    money_movement_id: moneyMovementId,
    payment_admission_id: requiredOrDefault("RUNX_X402_PAYMENT_ADMISSION_ID", "sha256:payment-admission-demo"),
    kernel_token_digest: requiredOrDefault("RUNX_X402_KERNEL_TOKEN_DIGEST", "sha256:kernel-token-demo"),
    kid: requiredOrDefault("RUNX_X402_KID", "kid-x402-demo"),
    sig: requiredOrDefault("RUNX_X402_SIG", "base64:demo-signature"),
  };
}

function templateFromEnv(admissionToken, defaults = {}) {
  const chainId = numberEnv("RUNX_X402_CHAIN_ID", defaults.chainId);
  const tokenContract = requiredOrDefault("RUNX_X402_TOKEN_CONTRACT", defaults.tokenContract);
  const verifyingContract = requiredOrDefault("RUNX_X402_VERIFYING_CONTRACT", defaults.verifyingContract);
  const from = requiredOrDefault("RUNX_X402_FROM", defaults.from);
  const payTo = requiredOrDefault("RUNX_X402_PAY_TO", defaults.payTo || admissionToken.counterparty);
  for (const [name, value] of [
    ["RUNX_X402_TOKEN_CONTRACT", tokenContract],
    ["RUNX_X402_VERIFYING_CONTRACT", verifyingContract],
    ["RUNX_X402_FROM", from],
    ["RUNX_X402_PAY_TO", payTo],
  ]) {
    if (!ADDRESS.test(value)) {
      fail(`${name} must be a 20-byte 0x-prefixed address`);
    }
  }
  return {
    chain_id: chainId,
    token_contract: tokenContract,
    verifying_contract: verifyingContract,
    from,
    to: payTo,
    value: admissionToken.amount_minor,
    valid_after: requiredOrDefault("RUNX_X402_VALID_AFTER", "2026-06-01T00:00:00Z"),
    valid_before: requiredOrDefault("RUNX_X402_VALID_BEFORE", admissionToken.expires_at),
    nonce: admissionToken.money_movement_id,
    currency: admissionToken.currency,
    amount_minor: admissionToken.amount_minor,
    counterparty: payTo,
    run_id: admissionToken.run_id,
    authority_digest: admissionToken.authority_digest,
    money_movement_id: admissionToken.money_movement_id,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`POST ${url} returned non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok && parsed.status !== "refused") {
    fail(`POST ${url} returned HTTP ${response.status}: ${parsed.message || text.slice(0, 200)}`);
  }
  return parsed;
}

function validateSignerResponse(response, expectedDigest) {
  if (response.schema !== RESPONSE_SCHEMA) {
    fail(`external signer response schema mismatch: ${response.schema}`);
  }
  if (response.status !== "signed") {
    fail(`external signer refused: ${response.code || "unknown"} ${response.message || ""}`.trim());
  }
  if (response.template_digest !== expectedDigest) {
    fail("external signer returned a different template_digest");
  }
  if (typeof response.signer_address !== "string" || !ADDRESS.test(response.signer_address)) {
    fail("external signer returned invalid signer_address");
  }
  if (typeof response.signature !== "string" || !SIGNATURE.test(response.signature)) {
    fail("external signer returned invalid 65-byte EVM signature");
  }
}

function parseDemoOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--receipt-dir") {
      options.receiptDir = argv[index + 1]?.trim();
      if (!options.receiptDir) fail("--receipt-dir requires a value");
      index += 1;
      continue;
    }
    throw new Error(`Unknown --demo argument: ${arg}`);
  }
  return options;
}

function defaultRunxBinary() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [
    path.join(repoRoot, "crates", "target", "debug", "runx"),
    path.join(repoRoot, "crates", "target", "release", "runx"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) {
      fail(`${name} is required`);
    }
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function requiredOrDefault(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function envOr(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function pruneUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""),
  );
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(exitCode) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(
    [
      "Usage:",
      "  node scripts/x402-testnet-settle.mjs --inspect <money_movement_id>",
      "  RUNX_X402_FACILITATOR=<url> RUNX_X402_SIGNER=<url> node scripts/x402-testnet-settle.mjs --demo [--receipt-dir <dir>]",
      "  RUNX_X402_DEMO_MODE=mock node scripts/x402-testnet-settle.mjs --demo [--receipt-dir <dir>]",
      "  RUNX_X402_DEMO_MODE=auto node scripts/x402-testnet-settle.mjs --demo [--receipt-dir <dir>]",
      "",
      "This is the Runx signer/facilitator receipt seam. For upstream HTTP 402 protocol conformance, run:",
      "  node scripts/x402-upstream-conformance.mjs --check",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

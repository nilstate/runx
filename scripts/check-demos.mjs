#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const cases = [
  {
    name: "payments-recorded",
    command: [node, "scripts/payments-demo.mjs", "--record"],
    env: {},
    receipts: ["payments-demo-paid.receipt.json", "payments-demo-refusal.receipt.json"],
  },
  {
    name: "x402-mock",
    command: [node, "scripts/x402-testnet-settle.mjs", "--demo"],
    env: { RUNX_X402_DEMO_MODE: "mock" },
    receipts: ["x402-settlement.receipt.json", "x402-refusal.receipt.json"],
  },
  {
    name: "stripe-spt-mock",
    command: [node, "scripts/stripe-spt-charge.mjs", "--demo"],
    env: {
      RUNX_STRIPE_DEMO_MODE: "mock",
      STRIPE_WEBHOOK_SECRET: "whsec_local_demo_check",
    },
    receipts: ["stripe-spt-settlement.receipt.json", "stripe-spt-refusal.receipt.json"],
  },
];

for (const demo of cases) {
  const receiptDir = mkdtempSync(path.join(os.tmpdir(), `runx-${demo.name}-`));
  run(demo.name, [...demo.command, "--receipt-dir", receiptDir], demo.env);
  for (const receipt of demo.receipts) {
    run(
      `${demo.name}:${receipt}`,
      [node, "tools/verify/verify.mjs", path.join(receiptDir, receipt)],
      {},
    );
  }
  console.log(`[demos:check] pass ${demo.name} (${receiptDir})`);
}

console.log("[demos:check] all demo receipts verified");

function run(label, command, env) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return;
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.stderr.write(`[demos:check] fail ${label} exit=${result.status}\n`);
  process.exit(result.status || 1);
}

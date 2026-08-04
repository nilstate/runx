#!/usr/bin/env bash
#
# x402 governed-spend receipt demo.
#
# Default mode is deterministic mock. Set RUNX_X402_FACILITATOR and
# RUNX_X402_SIGNER in the calling shell, plus the signer/template fields required
# by scripts/x402-testnet-settle.mjs, to run a real Base Sepolia settlement over
# the Runx signer/facilitator seam. For upstream HTTP 402 protocol conformance,
# use scripts/x402-upstream-conformance.mjs.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OSS="$(cd "$HERE/../.." && pwd)"
RDIR="${RUNX_X402_RECEIPT_DIR:-$(mktemp -d 2>/dev/null || echo /tmp/runx-x402-demo)}"

mkdir -p "$RDIR"
cd "$OSS"

echo "runx x402 governed-spend demo"
echo "receipts: $RDIR"
echo "mode: ${RUNX_X402_DEMO_MODE:-auto}"
echo

node scripts/x402-testnet-settle.mjs --demo --receipt-dir "$RDIR" >"$RDIR/x402-demo-report.stdout.json"
cat "$RDIR/x402-demo-report.stdout.json"

echo
node tools/verify/verify.mjs "$RDIR/x402-settlement.receipt.json"
echo
node tools/verify/verify.mjs "$RDIR/x402-refusal.receipt.json"

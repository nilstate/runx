#!/usr/bin/env bash
#
# Stripe SPT governed-spend demo.
#
# Default mode is deterministic mock. Set STRIPE_SECRET_KEY and
# STRIPE_WEBHOOK_SECRET in the calling shell to run a real Stripe test-mode
# charge. This script never stores or prints those secrets.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OSS="$(cd "$HERE/../.." && pwd)"
RDIR="${RUNX_STRIPE_RECEIPT_DIR:-$(mktemp -d 2>/dev/null || echo /tmp/runx-stripe-spt-demo)}"

mkdir -p "$RDIR"
cd "$OSS"

echo "runx Stripe SPT governed-spend demo"
echo "receipts: $RDIR"
echo "mode: ${RUNX_STRIPE_DEMO_MODE:-auto}"
echo

node scripts/stripe-spt-charge.mjs --demo --receipt-dir "$RDIR" >"$RDIR/stripe-spt-demo-report.stdout.json"
cat "$RDIR/stripe-spt-demo-report.stdout.json"

echo
node tools/verify/verify.mjs "$RDIR/stripe-spt-settlement.receipt.json"
echo
node tools/verify/verify.mjs "$RDIR/stripe-spt-refusal.receipt.json"

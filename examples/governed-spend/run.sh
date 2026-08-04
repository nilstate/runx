#!/usr/bin/env bash
#
# runx governed-spend demo.
#
# One policy. Any rail. A prompt-injected agent tries to overspend, and runx
# refuses it before any provider is touched, identically across x402, MPP, and
# Stripe. No keys, no signup, no network. Everything here runs on shipped runx
# code via the inline harness.
#
# Usage:  ./run.sh
# Override the binary with RUNX_BIN=/path/to/runx ./run.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OSS="$(cd "$HERE/../.." && pwd)"            # examples/governed-spend -> oss

# Locate the runx binary: an explicit RUNX_BIN, else a repo build, else PATH.
RUNX="${RUNX_BIN:-}"
if [ -z "$RUNX" ]; then
  for cand in "$OSS/crates/target/debug/runx" "$OSS/crates/target/release/runx"; do
    [ -x "$cand" ] && RUNX="$cand" && break
  done
fi
[ -z "$RUNX" ] && command -v runx >/dev/null 2>&1 && RUNX="runx"
if [ -z "$RUNX" ]; then
  echo "runx binary not found. Build it with: (cd $OSS/crates && cargo build -p runx-cli) or set RUNX_BIN." >&2
  exit 1
fi

# A demo-only receipt-signing identity. runx mandates signed receipts; this is a
# throwaway test key, never a production secret.
export RUNX_RECEIPT_SIGN_KID="${RUNX_RECEIPT_SIGN_KID:-runx-demo-key}"
export RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64="${RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:-QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=}"
export RUNX_RECEIPT_SIGN_ISSUER_TYPE="${RUNX_RECEIPT_SIGN_ISSUER_TYPE:-hosted}"

RDIR="$(mktemp -d 2>/dev/null || echo /tmp/runx-deny-demo)"
mkdir -p "$RDIR"
cd "$OSS"

bar()  { printf '%s\n' "------------------------------------------------------------"; }
field() { python3 -c "import sys,json; d=json.load(open('$1')); print(d.get('$2',''))" 2>/dev/null; }

echo
echo "runx governed-spend demo"
echo "binary: $RUNX"
echo "receipts: $RDIR"
bar

# ---------------------------------------------------------------------------
# 1. ALLOW: one bounded authority, three rails, all sealing a receipt.
# ---------------------------------------------------------------------------
echo "1) ALLOW  -- the same governance over three providers"
echo "   A bounded payment authority quotes -> reserves -> fulfills on each rail."
for rail in x402 mpp stripe; do
  d="$RDIR/allow-$rail"; mkdir -p "$d"
  out="$("$RUNX" harness "skills/${rail}-pay" --json --receipt-dir "$d" 2>/dev/null)"
  status="$(printf '%s' "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null)"
  rid="$(printf '%s' "$out" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("receipt_ids") or [];print(r[0] if r else "")' 2>/dev/null)"
  printf "   PAID   rail=%-7s harness=%-7s receipt=%s\n" "$rail" "$status" "${rid:0:50}"
done
bar

# ---------------------------------------------------------------------------
# 2. DENY: a prompt-injected agent tries to overspend. runx refuses at the rail
#    gate, before any provider call. (The harness exits non-zero on the block;
#    that non-zero IS the refusal.)
# ---------------------------------------------------------------------------
echo "2) DENY   -- a compromised agent tries to spend 1.25 against a 1.00 cap"
echo "   The reserve step grants a child authority capped at 100 minor/call."
echo "   The injected agent tries to fulfill 125. runx blocks at the rail gate."
"$RUNX" harness examples/governed-spend/skills/overspend-refused --json \
  --receipt-dir "$RDIR/deny" >"$RDIR/deny.out" 2>"$RDIR/deny.err"
deny_code=$?
reason="$(python3 -c '
import json,sys
try:
    d=json.load(open("'"$RDIR"'/deny.out"))
    errs=d.get("assertion_errors") or []
    print(errs[0] if errs else (open("'"$RDIR"'/deny.err").read().strip()))
except Exception:
    print(open("'"$RDIR"'/deny.err").read().strip())
' 2>/dev/null)"
if [ "$deny_code" -ne 0 ]; then
  echo "   REFUSED before rail (governance denied the spend):"
  echo "     $reason"
  echo "   No x402 rail call was made. Your wallet/signer was never invoked."
else
  echo "   UNEXPECTED: the over-budget spend was not refused. Check the demo skill." >&2
fi
bar

# ---------------------------------------------------------------------------
# 3. The signed refusal receipt. runx seals a tamper-evident record for a
#    refused spend, exactly as it does for a paid one. This projection is
#    regenerated and verified on every CI run (fixtures:harness:check).
# ---------------------------------------------------------------------------
echo "3) RECEIPT -- every refusal is sealed, not just every payment"
python3 -c '
import json
d=json.load(open("fixtures/ledger-projections/x402-pay-ledger-governed-refusal.json"))
r=d.get("refusal",{}); a=d.get("accrual",{})
print("   disposition        :", d.get("disposition"))
print("   reason_code        :", r.get("reason_code"))
print("   refused_stage      :", r.get("refused_stage"))
print("   rail_call_performed:", r.get("rail_call_performed"))
print("   amount accrued     :", a.get("amount_minor"), a.get("currency"))
print("   source_receipt     :", (d.get("source_receipt_id") or "")[:54])
' 2>/dev/null
bar
echo "one policy, any rail; the spend is refused before the rail is touched."
echo "runx holds no wallet and no spend credential and called no rail. It signs the receipt"
echo "with its own key, so anyone can verify it independently: node tools/verify/verify.mjs <receipt>"
echo

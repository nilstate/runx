#!/usr/bin/env sh
# GitHub MCP hero demo: governed read succeeds; out-of-scope write is refused
# before the MCP mutation tool runs. No external network is used.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
OSS="$(cd "$HERE/../.." && pwd)"
RUNX="${RUNX_BIN:-$OSS/crates/target/debug/runx}"
[ -x "$RUNX" ] || RUNX="$(command -v runx || true)"
[ -n "$RUNX" ] || { echo "runx binary not found; set RUNX_BIN." >&2; exit 1; }

export RUNX_RECEIPT_SIGN_KID="${RUNX_RECEIPT_SIGN_KID:-runx-demo-key}"
export RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64="${RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:-QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=}"
export RUNX_RECEIPT_SIGN_ISSUER_TYPE="${RUNX_RECEIPT_SIGN_ISSUER_TYPE:-hosted}"

RDIR="$(mktemp -d 2>/dev/null || echo /tmp/runx-github-mcp-demo)"
"$RUNX" harness "$HERE" --receipt-dir "$RDIR" --json

DENIAL_RECEIPT="$(
  node - "$RDIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const queue = [root];
while (queue.length > 0) {
  const current = queue.shift();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) {
      queue.push(file);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        receipt?.seal?.disposition === "blocked" &&
        receipt?.seal?.reason_code === "authority_denied"
      ) {
        console.log(file);
        process.exit(0);
      }
    } catch {
      // Ignore non-receipt JSON files in the receipt directory.
    }
  }
}
process.exit(1);
NODE
)"

[ -n "$DENIAL_RECEIPT" ] || {
  echo "blocked authority_denied receipt not found under $RDIR" >&2
  exit 1
}

node "$OSS/tools/verify/verify.mjs" "$DENIAL_RECEIPT"

echo "------------------------------------------------------------"
echo "receipts: $RDIR"
echo "offline-verified denial receipt: $DENIAL_RECEIPT"

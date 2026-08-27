#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNX="$ROOT/crates/target/debug/runx"

echo "[dogfood:native] build runx and JavaScript worker"
cargo build --manifest-path "$ROOT/crates/Cargo.toml" -p runx-cli -p runx-js-worker --bins

echo "[dogfood:native] skill"
RUNX_HOME="$ROOT/.runx/native-dogfood-home" \
RUNX_RECEIPT_DIR="$ROOT/.runx/native-dogfood-receipts" \
"$RUNX" skill "$ROOT/examples/hello-world" --message "hello from native dogfood" --json >/dev/null

echo "[dogfood:native] harness"
"$RUNX" harness "$ROOT/examples/hello-graph/harness.yaml" --json >/dev/null

echo "[dogfood:native] policy"
"$RUNX" policy inspect "$ROOT/fixtures/operational-policy/minimal-single-repo.json" --json >/dev/null

echo "[dogfood:native] ok"

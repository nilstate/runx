# CLI Feature Parity Matrix

This directory captures the canonical native Rust CLI/runtime surface. The
matrix is generated from `scripts/generate-cli-feature-parity.ts` and checked
against `crates/runx-cli/src/router.rs`.

Required exit-code coverage: `"exitCodes": [0, 1, 2, 64]`.

## Files

- `commands.json`: command, alias, flag, exit-code, output, receipt, and
  side-effect coverage.
- `runtime-surfaces.json`: non-help runtime surfaces that must not disappear
  during a Rust rebuild.
- `cases/oracle.json`: executable or validation-only oracle cases.

## Parity Rules

- JSON output and receipt behavior are schema-exact.
- Human output is semantic and may be normalized for timestamps, paths,
  receipt ids, and platform-specific wording.
- Live providers are replaced by deterministic mocks, fixtures, or local
  protocol servers.
- Native CLI candidates must pass this matrix before packaging.

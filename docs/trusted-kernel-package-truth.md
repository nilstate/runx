# Trusted Kernel Package Truth

Status: current OSS package-authority summary.

The repo-root document is a superseded migration record. The active ownership
boundary is [TypeScript Interop Boundary](./ts-interop-boundary.md); this
document summarizes its Rust package implications.

## Rust Cutover Rule

Rust is canonical for advertised native local CLI behavior, graph execution,
harness and dogfood execution, receipt sealing and verification, policy and
registry configuration, generic authority admission, and effect admission.
TypeScript packages may wrap those paths for distribution, but they do not own
the local behavior.

Rust crates that are still in parity-only mode remain conformance evidence
until a separate cutover spec changes a consumer and passes the relevant gate.

Local Rust kernel parity is checked with `pnpm rust:check`, which runs Cargo
formatting, Clippy, workspace tests, crate dependency guards, `cargo-deny`,
and the `runx-core` public API snapshot. The native Rust workspace is also a
blocking CI and release surface: formatting, all-feature Clippy, workspace
tests, doctests, dependency policy, and the public API snapshot must pass.

Kernel parity fixtures live under `fixtures/kernel/`. They are generated from
the TypeScript implementation and act as conformance evidence for the Rust
port. Fixture refreshes must be deliberate: update the TypeScript oracle,
regenerate the fixture JSON, and review the semantic diff before accepting a
Rust behavior change.

`crates/runx-core` currently provides Rust state-machine parity and Rust
policy parity against the checked-in fixture set. Rust policy is authoritative
where the native runtime or CLI uses it for local admission, authority, and
configuration decisions. Remaining TypeScript consumers keep their own sunset
specs; they should not be extended as a second source of truth for local
execution.

Policy executable-name normalization is host-independent for fixture parity:
backslashes are treated as path separators on every host. This keeps strict
CLI-tool inline-code admission consistent across POSIX and Windows runners;
for example, `C:\Tools\node.exe -e ...` normalizes to `node` and is denied
under the strict inline-code policy.

The original pure-kernel Rust parity surface, before the native runtime
cutover, was:

- Rust-owned state-machine kernel inputs
- retired TypeScript policy helpers now owned by Rust
- graph-scope, retry, connected-auth, local-admission, and grant-policy helpers

Parser, receipts, runtime, adapters, and CLI cutover are separate specs.
For any still-dual command, full CLI/runtime cutover still requires the
`fixtures/cli-parity` feature matrix and one-to-one parity evidence; kernel
parity alone is not a CLI or runtime cutover gate.

The Rust CLI cutover gate rejects candidate package or binary surfaces that
still expose JavaScript fallback hooks, retired receipt shapes, alias modes, or
hidden references to deleted TypeScript runtime packages where static
inspection can see them. Passing the guard means the package surface delegates
to Rust cleanly; it does not authorize new command behavior by itself.

## Rust Dependency Policy

`crates/deny.toml` is the Rust workspace supply-chain boundary for the parity
track. It checks all feature graphs and currently has no package-specific
license exceptions.

The current tiers are:

- Pure crates: `runx-contracts`, `runx-core`, `runx-parser`, `runx-receipts`,
  and `runx-sdk` may not depend on async runtimes, HTTP clients/servers, MCP
  framework crates, or alternate YAML backends.
- Runtime and adapter crates: `runx-runtime` may use side-effect-tier
  dependencies only behind owning feature flags. The current approved
  exceptions are `reqwest` + `rustls` for adapter-owned HTTPS, `tokio` for
  MCP/process async supervision, and `rmcp` for MCP protocol handling. These
  dependencies must not move into pure crates or default features. `runx-cli`
  consumes runtime surfaces; it must not grow its own parallel HTTP, MCP, or
  process-supervision stack. New adapter-side exceptions remain
  spec-reviewed, package-scoped, and documented here before the deny entry is
  relaxed.
- YAML parsing: `serde_norway` is the current parser backend. `serde_yml` and
  `serde_yaml` are not approved Rust rewrite dependencies.

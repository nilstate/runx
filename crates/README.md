# runx Rust Crates

This workspace contains the Rust packages that back the `runx` distribution:
contracts, kernel decisions, parser, receipts, the native runtime, the CLI
binary, and the blocking SDK. Architectural authority lives in
[`oss/docs/rust-kernel-architecture.md`](../docs/rust-kernel-architecture.md);
sequencing lives in [`plans/rust-takeover.md`](../../plans/rust-takeover.md).

## Commands

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo package --workspace --allow-dirty
node ../scripts/check-rust-kernel-parity.mjs
node ../scripts/check-rust-crate-graph.mjs
node ../scripts/check-rust-core-style.mjs
```

The workspace lints (see [`Cargo.toml`](Cargo.toml)) deny `unsafe_code`,
`unwrap_used`, `expect_used`, `panic`, `dbg_macro`, `print_stdout`,
`print_stderr`, `todo`, `unimplemented`, and `wildcard_imports` across every
crate. Adapter-tier dependencies (async runtimes, HTTP clients, MCP protocol
crates) require an explicit spec before they may be added to `deny.toml`.

## Layout

- `runx-cli`: native `runx` binary. Hand-rolled dispatcher across `harness`,
  `connect`, `config`, `policy`, `kernel`, `doctor`, `list`, `history`, `mcp`,
  `tool`, `registry`, `skill`, plus scaffold/router plumbing. Activation
  versus the npm CLI is recorded by the completed
  [`rust-cli-rust-cutover`](../.scafld/specs/archive/2026-05/rust-cli-rust-cutover.md)
  spec.
- `runx-contracts`: pure public contracts for JSON, host protocol, receipts,
  registry/tool records, act assignment, harness spine, generic authority and
  effect finality, target-repo runner planning, and the post-merge observer.
- `runx-core`: pure decisions. State-machine parity and policy parity
  (admission, sandbox, authority proof, public-work, retry, graph-step scope,
  generic authority subset).
- `runx-parser`: pure YAML → AST → IR parity for graphs, skills, runners, tool
  manifests, and skill installs. Raw object subtrees use
  `runx_contracts::JsonValue`.
- `runx-receipts`: pure receipt model, canonical hashing, and tree
  verification with an adversarial unit matrix.
- `runx-runtime`: impure runtime. Owns filesystem, subprocess, sandbox
  enforcement, journals, registry clients, harness replay, doctor,
  dev loop, scaffold, generic authority gating, and the adapter set. Adapter
  families are opt-in features: `cli-tool`, `mcp`, `mcp-http-server`, `a2a`,
  `agent`, `catalog`, `external-adapter`, and `http`; `a2a` is
  contract-defined but not enabled in `runx-cli`.
  The `async-http` feature owns runtime HTTP with reqwest over rustls, disables
  redirect following, and uses bounded request/connect timeouts. `cli-tool`
  enables `async-http`; defaults keep the runtime dependency-light.
- `runx-sdk`: blocking CLI-backed Rust SDK v0. Depends on `runx-contracts`
  only; explicit non-dep on `runx-core` and `runx-runtime`.

Pure crates (`runx-contracts`, `runx-core`, `runx-parser`, `runx-receipts`,
and the v0 `runx-sdk`) carry no async, HTTP, or process-spawn dependencies.
The runtime crate owns those.

For kernel parity, run `pnpm rust:check` from `oss/` or
`node ../scripts/check-rust-kernel-parity.mjs` from `oss/crates/`. Install
optional tools with `cargo install cargo-deny` and
`cargo install cargo-public-api --version 0.51.0`, plus
`rustup toolchain install nightly --profile minimal`.

Commit the single workspace lockfile at `crates/Cargo.lock`; the workspace
contains a binary and publishable libraries.

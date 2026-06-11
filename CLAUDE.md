# runx OSS Claude Contract

Read `AGENTS.md` first when working through a scafld spec. For direct code
cleanup, follow this file plus `CONVENTIONS.md`.

## Architecture

Rust owns the trusted local runtime path:

- `runx-contracts` owns public contract types and schema emission.
- `runx-core` owns pure state-machine and policy decisions.
- `runx-parser` owns pure skill, graph, runner, and tool manifest parsing.
- `runx-receipts` owns canonical receipt hashing, signatures, and tree proof.
- `runx-runtime` owns impure local execution, adapters, sandbox planning,
  harness replay, journals, registry clients, payment gates, MCP, and receipts.
- `runx-cli` is the native command shell over `runx-runtime`.

TypeScript packages are wrappers, authoring tools, generated contract
validators/types, client helpers, host adapters, and product integration glue.
They must not regain trusted local execution fallback behavior.

## Commands

Use the narrowest useful check while iterating:

```bash
pnpm typecheck
pnpm rust:style
pnpm rust:crate-graph
pnpm verify:fast
```

For Rust-focused checks:

```bash
cargo fmt --manifest-path crates/Cargo.toml --all --check
cargo check --manifest-path crates/Cargo.toml --workspace --all-targets
cargo test --manifest-path crates/Cargo.toml -p runx-receipts
```

Avoid running multiple heavy Rust gates in parallel; this workspace has had
false timeouts when the eval binary is starved.

## Spec Workflow

Use scafld for non-trivial scoped work:

```bash
scafld plan <task-id> --title "Title"
scafld harden <task-id>
scafld approve <task-id>
scafld build <task-id>
scafld review <task-id> --provider claude
scafld complete <task-id>
```

`--provider local` is smoke-test only and cannot satisfy completion.

## Boundaries

- Do not touch another active spec unless the user explicitly assigns it.
- Do not add compatibility aliases, fallback runtime paths, or `.v2` contract
  ids for governed wire shapes.
- Do not duplicate runtime logic in TypeScript when the Rust runtime owns the
  path.
- Keep pure crates free of filesystem, network, subprocess, async runtime, and
  adapter concerns.
- Treat fixtures as parity evidence. Regenerate only when the semantic change
  is intentional and reviewed.
- For stateful hosted apps, keep OSS contracts and skills generic: use
  `runx.effect.transition.v1` with `effect_family` and `operation`; do not add
  product-specific authority families, packet namespaces, or Rust branches.

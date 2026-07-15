# How We Test

Runx has two local test lanes: a fast loop for package-adjacent work and a full
workspace suite for release confidence.

Rust runtime work has four explicit gates:

| Gate | Purpose | Command shape |
| --- | --- | --- |
| Local fast | Tight edit loop for nearby package/runtime changes. | `pnpm verify:fast` or a focused `cargo test --manifest-path crates/Cargo.toml -p <crate> ...` |
| CI fast | Deterministic semantic and boundary checks that should run on every review. | `pnpm boundary:check`, `pnpm typecheck`, focused Rust contract/runtime tests |
| Heavy | Perf, fanout, MCP, external-process, and oracle checks that are useful before release or risky runtime changes. | `pnpm stress:runtime:*`, `pnpm perf:runtime:check -- --baseline <path>` |
| Soak | Long-running replay/stress loops that should be invoked intentionally, never hidden inside the default workspace test. | Repeated stress commands under an external runner with captured JSON output |

Do not hide heavy or soak work inside `cargo test --workspace` or `pnpm test`.
The normal loop should fail fast; replay and stress gates should produce
machine-readable output that can be archived with the spec or CI run.

## Fast Loop

Use this while editing core runtime, harness, parser, policy, or nearby tests:

```bash
pnpm test:fast
```

`test:fast` uses `vitest.fast.config.ts`. It includes package tests plus
coverage for surviving TypeScript package boundaries.

For canonical local runtime behavior, prefer the Rust lane directly. Payment,
authority, receipt, harness, dogfood, registry, and policy-config changes need
Rust coverage or a TS-free Rust CLI fixture:

```bash
cargo test --manifest-path crates/Cargo.toml -p runx-pay --test integration
cargo test --manifest-path crates/Cargo.toml -p runx-cli --test integration -- x402_native_dogfood
```

For one file:

```bash
pnpm vitest run tests/examples/hello-world.test.ts
```

## Full Suite

Use this before review or when changing CLI packaging, dist output, package
exports, or cross-package TypeScript wrapper behavior:

```bash
pnpm test
```

`pnpm test` runs `scripts/test-workspace.mjs`. With no explicit target, it runs
the workspace suite except `tests/cli-package.test.ts`, then runs
`tests/cli-package.test.ts` in a second pass with:

```bash
RUNX_VITEST_BATCH=cli-package
```

That ordering is intentional. `cli-package.test.ts` rebuilds and inspects
package output, so isolating it avoids races with tests that import from the
same dist trees.

To run the CLI package test directly:

```bash
RUNX_VITEST_BATCH=cli-package pnpm vitest run tests/cli-package.test.ts
```

## Fixtures

Use checked-in fixtures when a behavior should remain stable:

- `fixtures/skills/` for reusable skill packages
- `fixtures/graphs/` for graph execution shapes
- `fixtures/harness/` for harness-level contracts
- `examples/` for public docs examples that should also be executable

Prefer small fixtures with one purpose. If an example appears in docs, add a
test or harness so the docs fail loudly when the runtime shape changes.

Harness replay is owned by Rust. The fixture registry lives in
`runx_runtime::harness::list_cases()`, and the
`runx-harness-fixture-oracles` binary consumes that same registry for checks,
regeneration, and summary output:

```bash
pnpm fixtures:harness:check
pnpm fixtures:harness:summary
```

The summary path emits one JSON record per case with status, elapsed time,
receipt id, receipt digest, and failure classification.

## Runtime Stress

Adapter and fanout stress gates are explicit scripts:

```bash
pnpm stress:runtime:mcp
pnpm stress:runtime:cli-tool
pnpm stress:runtime:external-adapter
pnpm stress:runtime:fanout
```

These commands exercise MCP stdio/server wiring, CLI-tool process supervision,
external adapter cancellation/error boundaries, and fanout ordering/concurrency.
They are heavy gates, not the default local loop.

## Adding Tests

Use package-local tests for package internals and `tests/` for cross-package
wrapper behavior. Trusted local skill, graph, harness, receipt, policy,
authority, registry, config, and payment behavior needs a Rust test or a
TS-free Rust CLI fixture. TypeScript tests may wrap those paths, but they
should not be the only proof.

For docs examples, keep the test focused on the public command or runtime path
the docs promise. The hello-world and hello-graph tests are the reference shape.

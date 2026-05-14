# Getting Started

This walkthrough proves the local runx path with one small skill. It uses the
checked-in `examples/hello-world` package so the commands stay tied to the repo.

## Prerequisites

- Node.js 20 or newer
- pnpm 10 or newer

Install and build from the OSS workspace:

```bash
cd oss
pnpm install
pnpm build
```

## Run The Example

Run the skill directly through the CLI:

```bash
pnpm exec runx skill examples/hello-world \
  --message "hello from docs" \
  --non-interactive \
  --json
```

The JSON response should report `status: "success"` and include a receipt id.

## Inspect The Receipt

Receipts are written under `.runx/receipts` unless `RUNX_RECEIPT_DIR` is set.
Use the id from the previous command:

```bash
pnpm exec runx inspect <receipt-id>
```

The inspection should show a verified `skill_execution` receipt. That receipt
is the durable evidence that runx executed the skill, recorded the input shape,
and captured the output without relying on prose claims.

## Next

- Use `runx new docs-demo` for local standalone skill scaffolding.
- Use `npm create @runxhq/skill@latest docs-demo` when starting from npm.
- Compose the example into a graph with [Skill To Graph](./skill-to-graph.md).
- See [API Surface](./api-surface.md) for public package exports.

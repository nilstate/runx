# Examples

Runnable reference skills that demonstrate each runx front. These are examples,
not catalog entries: `runx list skills|graphs|tools` scans `skills/`, `graphs/`,
and `tools/`, so the examples here are intentionally absent from that catalog.
Run them directly instead.

For a curated list of runnable proof demos and offline receipt verification, see
`docs/demos.md`.

Most need a receipt-signing identity (runx mandates signed receipts). A demo-only
identity:

```sh
export RUNX_RECEIPT_SIGN_KID=runx-demo-key
export RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=
export RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted
```

## Featured demos

The curated proof set is also machine-checked in
`../docs/demo-inventory.json`.

| Example | Front | Run |
| --- | --- | --- |
| `hello-world` | cli-tool (top-level runner) | `runx harness examples/hello-world` |
| `github-mcp-hero` | mcp (governed GitHub read plus refused write) | `sh examples/github-mcp-hero/run.sh` |
| `http-graph` | http (governed local fixture call) | `sh examples/http-graph/run.sh` |
| `openapi-graph` + `openapi-tool` | OpenAPI via external-adapter (an OpenAPI operation executed and sealed) | `sh examples/openapi-graph/run.sh` |
| `nws-weather-openapi` + `nws-weather-points` | http against a real OpenAPI-described public provider | `sh examples/nws-weather-openapi/run.sh` |
| `governed-spend` | payment authority, deterministic x402/Stripe receipt demos, and offline verification | `pnpm demos:check` |
| `loop-orchestration` | outer loop over governed runx turns, with receipts, refusal, and agent context preview | `sh examples/loop-orchestration/run.sh` |

## Runnable previews

These are useful local proofs, but they are not the featured first-window demo
set.

| Example | Front | Run |
| --- | --- | --- |
| `managed-agent` | agent (host-drives default; yields `needs_agent` to the calling agent) | `runx harness examples/managed-agent` |
| `external-adapter-graph` + `external-adapter-tool` | external-adapter (graph-step source; a governed subprocess adapter) | `runx harness examples/external-adapter-graph` |
| `byo-http-graph` + `byo-http-tool` | BYO local credential over the governed HTTP front | `sh examples/byo-http-graph/run.sh` (credentialed local fixture read) |
| `hello-graph` | graph harness baseline | `runx harness examples/hello-graph/harness.yaml` |
| `http-tool-catalog` | HTTP tool catalog fixture | `sh examples/http-tool-catalog/run.sh` |
| `thread-outbox-provider-graph` + `thread-outbox-provider-{push,fetch}` | thread-outbox-provider (graph-step source; fixture provider publication/readback) | `runx harness examples/thread-outbox-provider-graph` |
| `post-merge-publish/final-outcome.yaml` + `post-merge-final-outcome-publisher` | thread-outbox-provider final provider-state publication | `runx harness examples/post-merge-publish/final-outcome.yaml` |

## Fixture support

These directories are intentionally not user-facing demos by themselves:
`adapter-kit`, `byo-http-tool`, `external-adapter-tool`, `host-protocol`,
`http-tool`, `nws-weather-points`, `openapi-tool`, `orchestrator-webhooks`,
`post-merge-final-outcome-publisher`, `thread-outbox-provider-fetch`,
`thread-outbox-provider-fixture`, and
`thread-outbox-provider-push`.

`external-adapter` and `thread-outbox-provider` are graph-step sources, not
top-level runners, so their examples are driven by graphs. Graph input values
reach a step with the `$input.<name>` form (for example
`message: "$input.message"`).

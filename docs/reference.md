# runx reference

Architecture and contributor reference for the runx OSS repo: the CLI surface,
the trusted Rust local runtime, generated contracts, extension protocols, SDKs,
harness, local receipts, registry, official skills, and packaging. For the
overview and quickstart, start at the [README](../README.md).

The npm CLI package is `@runxhq/cli` and exposes the `runx` binary.

## Your First Skill In 5 Minutes

Start with the checked-in hello-world skill:

```bash
cd oss
cargo build --manifest-path crates/Cargo.toml -p runx-cli
export RUNX_RECEIPT_DIR="$(mktemp -d)"
crates/target/debug/runx skill examples/hello-world \
  --message "hello from docs" \
  --non-interactive \
  --json
```

When no production signer environment is configured, local `runx skill` and
inline `runx harness` runs seal local-development receipts. Publishing and
hosted verification require real authority.

Then inspect the emitted receipt. The full walkthrough is in
[getting-started.md](getting-started.md), and the next step is
[skill-to-graph.md](skill-to-graph.md).
For governed code changes, see [issue-to-pr.md](issue-to-pr.md).

## Zero-Funded Payment Dogfood

Run the local payment dogfood lane without a funded wallet, hosted account, or
provider keys:

```bash
pnpm x402:dogfood:local
```

This proves runx payment authority, refusal, receipt signing, offline receipt
verification, and the documented x402 upstream/x402-rs/CDP/Stripe SPT preflight
shape. It does not claim real x402 settlement or a real Stripe charge; live
conformance lanes require dedicated funded testnet wallets or provider test
credentials. No-secret preflight reports use `can_run: false` and `missing_env`
to name live blockers without printing secret values. See
[docs/demos.md](docs/demos.md#payment-demo-gate) for the full split between
local dogfood and live protocol conformance.

## Requirements

Native CLI:

- Rust 1.85+
- The native Rust CLI path must stay useful without Node, pnpm, tsx, or
  TypeScript packages installed.

Workspace and npm wrapper:

- Node.js 20+
- pnpm 10+

## Install For Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm verify:fast
pnpm rust:check
```

Contributor setup, test selection, and commit sign-off rules are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Local CLI

For a live creator workflow, link the global `runx` binary to this checkout once:

```bash
pnpm --dir oss cli:link-global
```

Then invoke the linked `runx` binary from anywhere. Use explicit paths outside
a runx workspace; bare skill names resolve from the current workspace's
`skills/` directory.

```bash
runx --help
runx skill /path/to/runx/oss/fixtures/skills/echo --message hello --json
cd /path/to/runx/oss
runx skill ./skills/design-skill --objective "build sourcey docs skill" --json
```

Recommended flows:

```bash
runx init
runx init -g --prefetch official
runx new docs-demo
runx list skills
runx registry search sourcey --json
runx skill sourcey/sourcey@1.0.0 --registry https://runx.example.test --project . --json
runx add sourcey/sourcey@1.0.0 --registry https://runx.example.test --to ./skills --json
runx skill issue-to-pr --fixture /path/to/repo --task-id task-123
runx resume <run-id> answers.json
runx history <receipt-id> --json
runx history
runx mcp serve ./fixtures/skills/echo
runx skill ./skills/design-skill --objective "build github review skill"
runx harness ./fixtures/harness/echo-skill.yaml
runx config set agent.provider openai
runx config set agent.model gpt-5.1
runx config set agent.api_key "$OPENAI_API_KEY"
```

With `agent.provider`, `agent.model`, and `agent.api_key` configured, the CLI
can now resolve managed agent work directly. Deterministic tools, approvals,
and required human inputs keep their existing local behavior.

The global link points at `oss/packages/cli` in this checkout. Rebuild with
`pnpm --dir oss build`; do not reinstall.

## Package Topology

Rust owns the trusted local runtime path. The Rust crate graph is the enforced
boundary map:

- `runx-contracts`: Rust-owned public contract types and schema emission.
- `runx-core`: pure state-machine and policy decisions.
- `runx-parser`: pure skill, graph, runner, and tool manifest parsing.
- `runx-receipts`: canonical receipt model, hashing, signatures, and tree
  verification.
- `runx-runtime`: impure local runtime, adapters, sandbox planning, harness
  replay, journals, registry clients, payment gates, MCP, and execution.
- `runx-cli`: native `runx` binary over the runtime.
- `runx-sdk`: blocking CLI-backed SDK over stable contracts.

The TypeScript package graph is the client, authoring, wrapper, and generated
contract layer:

- `@runxhq/contracts`: generated validators and TypeScript types over the
  Rust-owned schema artifacts.
- `@runxhq/cli`: npm distribution wrapper and client presentation around the
  native CLI.
- `@runxhq/authoring`, `@runxhq/host-adapters`, and `@runxhq/langchain`:
  authoring, host presentation, and bridge packages over language-neutral
  contracts.

For the generated package export index, see [docs/api-surface.md](docs/api-surface.md).

`runx-runtime` is the canonical local runtime. It owns local skill, graph,
harness, receipt, history, policy, authority, payment, sandbox admission and
metadata, MCP, built-in adapter execution, and external execution-adapter
supervision for the native CLI path. OS sandbox enforcement remains a separate
runtime hardening lane and must not be assumed from sandbox declarations alone.

TypeScript remains for generated contracts, CLI/client wrappers,
cloud/product integrations, host adapters, authoring tooling, and helper SDKs
over language-neutral protocols. Host adapters can shape host responses over
the runx host protocol; they do not own local execution. External execution
adapter authors target manifests and wire protocols, so they do not need Rust,
`runx-core`, `runx-runtime`, or a fork of the core repository. Source-event
ingress, hosted runtime binding, catalog/read-model access, and thread/outbox
provider adapters are separate protocol lanes, not reasons to broaden the
execution-adapter protocol into a second runtime.

Command-surface ownership:

| Surface | Canonical owner | TypeScript role |
| --- | --- | --- |
| `runx skill` local execution | `runx-runtime::execution` via `runx-cli` | npm launcher/client wrapper |
| `runx harness <fixture.yaml>` | Rust harness replay | tests and wrapper views |
| receipts and history | Rust receipt store and journal | display/client views |
| policy, authority, payment, x402 | Rust core/runtime policy | published type mirrors and product UX |
| governed data operations | skill graphs plus provider adapters | generated types, helper SDKs, provider glue |
| external execution-adapter protocol | `runx-runtime` supervisor | generated types, helper SDKs, host/client wrappers |
| non-execution extension protocols | lane-specific Rust/cloud owners | generated types, helper SDKs, provider glue |
| marketplace and docs tooling | TypeScript/scafld until separately cut over | canonical for authoring UX |

Stateful product work should use the governed data-plane shape in
[docs/governed-data-plane.md](docs/governed-data-plane.md): domain skills own
meaning, while provider adapters execute bounded reads, append-only event
writes, and projection reads.

The generic graph tool ref for provider choice is `data.source`. It reads the
step's `data_source_ref`, resolves it through `RUNX_DATA_SOURCES` or
`.runx/data-sources.json`, injects the non-secret binding metadata into the
adapter input, and invokes the configured adapter. Unbound `local://...` refs
default to bundled durable SQLite; `store_id` opts into the bundled JSON fixture
adapter for deterministic harnesses.

### Local Sandbox Posture

`cli-tool` skills declare sandbox intent in `SKILL.md`: profile, cwd policy,
env allowlist, network intent, and writable paths. Receipts record both the
declared policy and the actual local enforcement mode.

The current OSS runtime is `declared-policy-only` for local sandbox isolation:
runx applies admission, cwd, environment shaping, input delivery, and receipt
metadata, but it does not enforce filesystem, network, process-tree, or resource
isolation with OS primitives. Receipts mark filesystem and network isolation as
`not-enforced-local`.

Set `sandbox.require_enforcement: true` in a skill, or
`RUNX_SANDBOX_REQUIRE_ENFORCEMENT=true` in the environment, when a run must fail
unless a future OS-level sandbox enforcer is available. In the current OSS
runtime, that setting fails closed.

## Capability Packs

Runx is the generic execution engine. Product workflows stay outside the runx
CLI and ship as local skills, runners, and tools in the consuming repo.

The intended extension model is:

- `runx` owns generic runtime, thread, outbox, receipt, and handoff machinery
- service repos own their product workflows as local capability packs
- operators execute those workflows through normal skill invocation
- CLI, API, and GitHub-comment triggers all normalize into the same capability
  execution envelope, while the thread stays the review/control object

Sourcey is the reference shape for this model: from inside the Sourcey repo,
`runx skill ./skills/outreach status --issue ...` resolves the local
`skills/outreach` capability pack. `outreach` is not a privileged engine
command, and there is no privileged `runx docs ...` path inside the engine.

`issue-to-pr` follows the same boundary. runx owns the generic source-thread to
scafld to PR machinery; service repos own Slack, Sentry, owner assignment, and
publish policy. See [docs/issue-to-pr.md](docs/issue-to-pr.md).

## Standalone Skill Packages

`runx new <name>` scaffolds a native cli-tool skill (SKILL.md + X.yaml +
run.mjs, zero npm deps, no build step):

```bash
runx new docs-demo
```

To cold-start without installing runx first, run `npx @runxhq/cli new docs-demo`;
it downloads the launcher and runs the same native scaffold.

Community skills should be authored and published as standalone packages created
this way. The main `runx` repo is the first-party lane for official skills and
runtime code, not the community package catalog.

Registry search and install now normalize public trust into three tiers:
`first_party`, `verified`, and `community`. Richer provenance and attestation
metadata still travels with the registry row, but the user-facing install/search
surface stays readable.

Use [skill-catalog.md](skill-catalog.md) for the maintained category list,
catalog search flow, and duplicate-check standard before proposing a new
first-party skill.

## Skill And X Model

Executable skills split authored skill content from execution profiles. `X.yaml`
is the runx execution profile file; the short name is public compatibility for
existing skill packages, but docs and code should describe it as the execution
profile:

```text
skills/sourcey/
  SKILL.md
  X.yaml
```

Direct execution accepts the package directory or `SKILL.md` inside it. Flat
`foo.md` skill files are no longer a supported execution surface.

Execution profiles use a strict YAML subset: no anchors, aliases, merge keys,
custom tags, multi-document markers, duplicate mapping keys, or unknown profile
fields. Keep capability and receipt mappings explicit in the runner that uses
them.

Public catalog packages must keep examples in standalone fixtures, not inline
manifest harness blocks. The package should contain only the files the skill
uses at execution time: `SKILL.md`, `X.yaml`, deterministic runner files,
schemas, fixtures, and narrowly scoped `context/` or `references/`. Do not add
README/changelog/setup docs, generated state, logs, screenshots, private
provider config, or broad project plans inside a public skill. The public docs
for the package belong in `SKILL.md`; external guides belong under `docs/`.

See `../docs/skill-profile-model.md` for resolution rules, publication modes, trust tiers, MCP export, and composite skill behavior.

See `../docs/evolution-model.md` for the evolve lane, the skill/tool boundary,
and the canonical composite execution geometry.

## Tool Authoring

First-party tools are authored from source in:

```text
tools/<namespace>/<tool>/
  src/index.ts
  fixtures/*.yaml
  manifest.json
  run.mjs
```

`src/index.ts` is the source of truth and uses `defineTool()` from
`@runxhq/authoring`. `manifest.json` and `run.mjs` are generated runtime
artifacts:

```bash
runx tool build --all --json
runx dev --lane deterministic --json
runx dev --lane repo-integration --json
```

`run.mjs` is intentionally checked in as the thin runtime shim that imports the
authored source. Do not hand-edit generated `manifest.json` or `run.mjs`.

## Official Packages

The official catalog is explicit about why each package is public:

- canonical governed skills: `charge`, `dispute-respond`, `evolve`,
  `improve-skill`, `least-privilege`, `overlay`,
  `policy-author`, `audit-receipt`, `refund`, `ops-desk`, `send-as`, `spend`,
  `weather-forecast`
- branded provider skills: `nitrosend`, `nws-weather-forecast`, `stripe-pay`,
  `x402-pay`
- context skills: `brand-voice`, `taste-profile`

Other bundled packages stay in the same `SKILL.md` + `X.yaml` shape, but are
internal by default. Internal packages must declare why they remain bundled:
`graph-stage`, `runtime-path`, `harness-fixture`, or `context`. Owned graph
stages live below their public skill at `skills/<skill>/graph/<stage>/X.yaml`,
not as root catalog packages.

For first-party skill proposal work, the core builder bar is explicit:
proposal packets should name the real pain being solved, explain fit against
the current runx catalog, surface maintainer decisions cleanly, and avoid
builder residue or placeholder targets.

See `docs/operator-console.md` for the manager-dashboard model that lets agents
operate projects, workspaces, products, or accounts through the same governed
lanes as the UI.

Each ships as a portable `SKILL.md` plus a colocated execution profile at
`skills/<skill>/X.yaml` when it exposes deterministic runners or inline harness
coverage. Upstream skills that runx does not own keep their execution profiles
under `bindings/<owner>/<skill>/X.yaml` with adjacent `binding.json`
governance metadata. Bare skill names resolve only to local workspace skills or
locked first-party official shorthand. Third-party registry execution uses the
explicit `owner/name@version` form, optionally with `--registry` and
`--digest`, and only trusted signed registry packages are materialized into the
runnable cache. Official skills are registry-backed and cached locally on first
acquisition. The npm CLI package no longer needs to ship the official runtime
skill bodies for normal execution.

Agent graphs can also demand-load skills as context instead of executing them.
Put reusable judgement, operating procedure, or capability skills in the local
registry, then reference them from an `agent-task` step with `context_skills`:

```yaml
context_skills:
  - ../taste-profile
  - registry:runx/taste-profile@1.0.0
```

The runtime injects each referenced `SKILL.md` as a generic
`runx.skill.context` artifact in the agent invocation `current_context`. Local
path refs resolve relative to the graph; registry refs require
`RUNX_REGISTRY_DIR` and are read from the local registry, not fetched remotely at
execution time. Explicit local/file registry sources are treated as user-owned
local material: they are digest-checked, but they do not require hosted registry
signatures. Context skills are bounded, digest-labeled, and presented to managed
agents as untrusted advisory data.

Graph steps can execute local-registry skills too:

```yaml
steps:
  - id: build_docs
    skill: registry:runx/sourcey
    runner: sourcey
```

This uses the same explicit local-registry rule: set `RUNX_REGISTRY_DIR`, sync or
publish the skill into that registry first, and treat `.runx/registry-step-skills`
as generated runtime cache rather than source.

Any runnable skill package can also be exposed locally as an MCP tool with:

```bash
runx mcp serve ./skills/sourcey
```

That MCP surface is a thin facade over the normal runx kernel path, so receipts,
policy, approvals, and resolution requests still behave the same way.

## Receipts

Local receipts are append-only JSON files under `.runx/receipts` unless `RUNX_RECEIPT_DIR` is set. `runx history` verifies receipt signatures and surfaces `verified`, `unverified`, or `invalid` status.

Publish a local receipt to the hosted notary with:

```bash
runx publish ./.runx/receipts/<receipt-id>.json
```

`runx publish` posts the full sealed receipt to `POST /v1/receipts/notarize`
with `publish: true`, then prints the public `/r` link and content hash returned
by the notary. Configure the hosted API with `RUNX_PUBLIC_API_BASE_URL` (default
`https://api.runx.ai`) and authenticate with `RUNX_PUBLIC_API_TOKEN` or `--token`
(or run `runx login`).

For local hosted dogfood only, point at a loopback API and opt into the private
network escape explicitly:

```bash
runx publish ./.runx/receipts/<receipt-id>.json \
  --api-base-url http://127.0.0.1:47882 \
  --token dev-token \
  --allow-local-api
```

## Workspace Policy

Projects can opt into stricter local `cli-tool` admission with
`.runx/config.json`:

```json
{
  "policy": {
    "strict_cli_tool_inline_code": true
  }
}
```

When enabled, local execution rejects known inline interpreter and shell eval
forms such as `node -e`, `python -c`, and `bash -lc`. Move the program into a
checked-in script file and invoke that file instead.

## Trainable Exports

Trainable export is currently a TypeScript-maintained projection command. It can
project verified receipt lineage into newline-delimited training rows without
mutating the original receipts, but it is not yet part of the native Rust CLI
surface:

```bash
runx export-receipts --trainable
runx export-receipts --trainable --receipt-dir ./.runx/receipts --status complete --source cli-tool
```

Rows are emitted as JSONL and follow the public training contract published at:

- `https://runx.ai/spec/training/trainable-receipt-row.schema.json`

The export keeps receipt identity, verified outcome resolution, ledger
artifacts, and runner provenance together so downstream training and eval
systems can consume governed lineage instead of raw prompt logs.

## Harness

`runx harness` currently supports standalone fixture YAML files in the native
Rust CLI:

```bash
runx harness ./fixtures/harness/echo-skill.yaml --json
```

Do not advertise `runx harness <skill-dir|SKILL.md>` until the Rust CLI expands
inline `X.yaml` harness cases natively.

## Doctor And Dogfood

For the core first-party skill lane, run:

```bash
pnpm dogfood:core-skills
```

This remains a TypeScript wrapper lane. The native Rust proof for local
orchestration is the Rust CLI/runtime test and fixture suite; wrapper dogfood is
useful only after the same behavior is proven without Node, pnpm, or tsx.

For the default structural verification lane during refactors, run:

```bash
pnpm verify:fast
```

That lane keeps the cheap workspace checks together: OSS typecheck plus the
fast package test surface with the current structural budget and boundary
coverage.

## Build And Pack

```bash
pnpm --dir oss build
pnpm --dir oss test tests/cli-package.test.ts
cd oss/packages/cli
npm pack --dry-run --json
```

The package must include `dist/index.js` and `dist/index.d.ts`, and `dist/index.js` must be executable.

## Boundary Rules

- `oss/` must not import from `cloud/`.
- State-machine and policy packages remain pure.
- Rust owns trusted local runtime/execution, including sandbox, receipts,
  policy, authority, payment, harness, built-in adapters, and external
  execution-adapter supervision.
- TypeScript runtime-local and adapters packages must not be fallback
  executors for trusted local behavior.
- External execution adapters own their side effects behind language-neutral
  protocols and manifests; non-execution extension lanes have their own
  protocol contracts.
- External extension authors must not need Rust, a `runx-core` or
  `runx-runtime` dependency, or a core repository fork.
- CLI, SDK, IDE plugin, host adapter, and MCP entrypoints delegate to runner
  contracts or external protocols instead of duplicating the engine.

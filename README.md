# runx OSS

Public open-source boundary for the runx CLI, trusted kernel, adapters, SDK, harness, local receipts, registry CE, marketplace adapters, official skills, and IDE plugin shells.

The npm CLI package is `@runxhq/cli` and exposes the `runx` binary.

## Requirements

- Node.js 20+
- pnpm 10+
- No native runtime dependency is required for the CLI path.

## Install For Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm verify:fast
```

## Local CLI

For a live creator workflow, link the global `runx` binary to this checkout once:

```bash
pnpm --dir oss cli:link-global
```

Then invoke `runx` from anywhere:

```bash
runx --help
runx ./oss/fixtures/skills/echo --message hello --json
runx design-skill --objective "build sourcey docs skill" --json
```

Recommended flows:

```bash
runx init
runx init -g --prefetch official
runx new docs-demo
npm create @runxhq/skill@latest docs-demo
runx search sourcey
runx sourcey --project .
runx evolve
runx issue-to-pr --fixture /path/to/repo --task-id task-123
runx resume <run-id>
runx inspect <receipt-id>
runx history
runx add sourcey/sourcey@1.0.0 --to ./skills
runx mcp serve ./fixtures/skills/echo
runx design-skill --objective "build github review skill"
runx harness ./fixtures/harness/echo-skill.yaml
runx config set agent.provider openai
runx config set agent.model gpt-5.1
runx config set agent.api_key "$OPENAI_API_KEY"
```

With `agent.provider`, `agent.model`, and `agent.api_key` configured, the CLI
can now resolve `agent` and `agent-step` cognitive work directly. Deterministic
tools, approvals, and required human inputs keep their existing local behavior.

The global link points at `oss/packages/cli` in this checkout. Rebuild with
`pnpm --dir oss build`; do not reinstall.

### Local Sandbox Enforcement

`cli-tool` skills declare sandbox intent in `SKILL.md`: profile, cwd policy,
env allowlist, network intent, and writable paths. Receipts record both the
declared policy and the actual local enforcement mode.

On Linux with `bubblewrap` (`bwrap`) available, non-unrestricted profiles run
under a mount/network namespace and receipts show `bubblewrap` enforcement. On
macOS or Linux without `bwrap`, the same profiles can run in a
`declared-policy-only` mode for local development: runx still applies admission,
cwd, env, and writable-path checks, but the receipt marks filesystem and network
isolation as `not-enforced-local`.

Set `sandbox.require_enforcement: true` in a skill, or
`RUNX_SANDBOX_REQUIRE_ENFORCEMENT=true` in the environment, when a run must fail
unless OS-level sandbox enforcement is available.

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
`runx outreach --runner status --issue ...` resolves the local
`skills/outreach` capability pack. `outreach` is not a privileged engine
command, and there is no privileged `runx docs ...` path inside the engine.

## Standalone Skill Packages

`runx new <name>` is the canonical standalone package scaffold:

```bash
runx new docs-demo
```

For cold-start adoption, the thin alias is:

```bash
npm create @runxhq/skill@latest docs-demo
```

Both entrypoints go through the same scaffolder. Community skills should be
authored and published as standalone packages created this way. The main `runx`
repo is the first-party lane for official skills and runtime code, not the
community package catalog.

Registry search and install now normalize public trust into three tiers:
`first_party`, `verified`, and `community`. Richer provenance and attestation
metadata still travels with the registry row, but the user-facing install/search
surface stays readable.

## Skill And X Model

Executable skills now split authored skill content from execution profiles:

```text
skills/sourcey/
  SKILL.md
  X.yaml
```

Direct execution accepts the package directory or `SKILL.md` inside it. Flat
`foo.md` skill files are no longer a supported execution surface.

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
pnpm exec tsx packages/cli/src/index.ts tool build --all --json
pnpm exec tsx packages/cli/src/index.ts dev --lane deterministic --json
pnpm exec tsx packages/cli/src/index.ts dev --lane repo-integration --json
```

`run.mjs` is intentionally checked in as the thin runtime shim that imports the
authored source. Do not hand-edit generated `manifest.json` or `run.mjs`.

## Official Packages

The official catalog has two public kinds:

- skills: `request-triage`, `issue-triage`, `research`, `draft-content`,
  `vuln-scan`, `scafld`, `sourcey`, `moltbook`
- skill graphs: `issue-to-pr`, `release`, `content-pipeline`,
  `deep-research-brief`, `ecosystem-vuln-scan`, `ecosystem-brief`,
  `skill-lab`, `skill-testing`

Builder and operator packages stay in the same `SKILL.md` + `X.yaml` shape,
but default to private visibility. That internal set currently includes
`work-plan`, `design-skill`, `prior-art`, `write-harness`,
`review-receipt`, `review-skill`, `improve-skill`, `reflect-digest`, and
`evolve`.

For first-party skill proposal work, the core builder bar is explicit:
proposal packets should name the real pain being solved, explain fit against
the current runx catalog, surface maintainer decisions cleanly, and avoid
builder residue or placeholder targets.

Each ships as a portable `SKILL.md` plus a colocated execution profile at
`skills/<skill>/X.yaml` when it exposes deterministic runners or inline harness
coverage. Upstream skills that runx does not own keep their execution profiles
under `bindings/<owner>/<skill>/X.yaml` with adjacent `binding.json`
governance metadata. Official skills are registry-backed and cached locally on
first acquisition. The npm CLI package no longer needs to ship the official
runtime skill bodies for normal execution.

Any runnable skill package can also be exposed locally as an MCP tool with:

```bash
runx mcp serve ./skills/sourcey
```

That MCP surface is a thin facade over the normal runx kernel path, so receipts,
policy, approvals, and resolution requests still behave the same way.

## Receipts

Local receipts are append-only JSON files under `.runx/receipts` unless `RUNX_RECEIPT_DIR` is set. `runx inspect` and `runx history` verify receipt signatures and surface `verified`, `unverified`, or `invalid` status.

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

The OSS CLI can project verified receipt lineage into newline-delimited training
rows without mutating the original receipts:

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

`runx harness` supports both existing standalone fixture YAML files and inline
harness cases declared in the execution profile:

```bash
runx harness ./fixtures/harness/echo-skill.yaml --json
runx harness ./skills/evolve --json
```

Inline harness keeps representative cases beside the skill package. Standalone
fixture YAML remains supported for larger shared or cross-package scenarios.

## Doctor And Dogfood

For the core first-party skill lane, run:

```bash
pnpm dogfood:core-skills
```

This rebuilds the workspace packages, runs `runx doctor --json`, and proves the
official skills reach a clean fresh-caller boundary with the current adapter
bundle.

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
- Executor dispatches adapters but does not write receipts.
- Adapters own side effects.
- CLI, SDK, IDE plugin, and MCP entrypoints delegate to runner contracts instead of duplicating the engine.

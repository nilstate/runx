# runx OSS

Public open-source boundary for the runx CLI, trusted kernel, adapters, SDK, harness, local receipts, registry CE, marketplace adapters, official skills, and IDE plugin shells.

The npm CLI package is `@runxai/cli` and exposes the `runx` binary.

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
runx objective-to-skill --objective "build sourcey docs skill" --json
```

Recommended flows:

```bash
runx search sourcey
runx sourcey --project .
runx evolve
runx bug-to-pr --fixture /path/to/repo --task-id task-123
runx resume <run-id>
runx inspect <receipt-id>
runx history
runx add 0state/sourcey@1.0.0 --to ./skills
runx objective-to-skill --objective "build github review skill"
runx harness ./fixtures/harness/echo-skill.yaml
runx config set agent.provider openai
runx config set agent.model gpt-5.4
runx config set agent.api_key "$OPENAI_API_KEY"
```

The global link points at `oss/packages/cli` in this checkout. Rebuild with
`pnpm --dir oss build`; do not reinstall.

## Skill And X Model

Executable skills now use one enforced package shape:

```text
skills/sourcey/
  SKILL.md
  x.yaml
```

Direct execution accepts the package directory or `SKILL.md` inside it. Flat
`foo.md` skill files are no longer a supported execution surface.

See `../docs/skill-x-model.md` for resolution rules, runner trust levels, and composite skill behavior.

See `../docs/evolution-model.md` for the evolve lane, the skill/tool boundary,
and the canonical composite execution geometry.

## Flagship Skills

The bundled catalog is skill-first. Public entrypoints are capabilities such as:

- `sourcey`
- `evolve`
- `issue-to-pr`
- `bug-to-pr` as a compatibility alias over `issue-to-pr`
- `objective-to-skill`
- `improve-skill`
- `harness-author`
- `receipt-review`

Each ships as a package with `SKILL.md` plus `x.yaml` when it exposes runnable
bindings or inline harness coverage.

## Receipts

Local receipts are append-only JSON files under `.runx/receipts` unless `RUNX_RECEIPT_DIR` is set. `runx inspect` and `runx history` verify receipt signatures and surface `verified`, `unverified`, or `invalid` status.

## Harness

`runx harness` supports both existing standalone fixture YAML files and
package-local inline harness cases declared in `x.yaml`:

```bash
runx harness ./fixtures/harness/echo-skill.yaml --json
runx harness ./skills/evolve --json
runx harness ./skills/evolve/x.yaml --json
```

Inline harness keeps representative cases beside the skill package. Standalone
fixture YAML remains supported for larger shared or cross-package scenarios.

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

# discord-notify

Runx authoring package: composable skills governed by typed contracts.

## Layout

- `SKILL.md`: Anthropic-standard skill description. Read by humans and agents.
- `X.yaml`: runx execution profile layered on top of `SKILL.md`.
- `src/packets/`: typed packet contracts authored with TypeBox.
- `tools/`: deterministic implementation units authored with `defineTool`.
- `fixtures/`: examples and tests across deterministic, agent, and repo-integration lanes.

## Authoring Loop

```bash
pnpm install
pnpm build
pnpm runx:list
pnpm runx:doctor
pnpm runx:dev
```

Edit `tools/docs/echo/src/index.ts`, then run `runx tool build --all` to regenerate `manifest.json` and `run.mjs`. Add fixtures in `tools/<namespace>/<name>/fixtures/` to lock behaviour.

Packet IDs are immutable. Schema changes mean a new packet ID, not an in-place edit.

## Bootstrap

- Canonical: `runx new discord-notify`
- Cold start: `npm create @runxhq/skill@latest discord-notify`

## Publish

The scaffold includes `.github/workflows/publish.yml`, which publishes with npm provenance from GitHub Actions. Before publishing, update `package.json` metadata for your repo and package.

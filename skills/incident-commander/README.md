# Incident Commander

Bounded, deterministic incident command packet composer.

## Inputs

- `signals[]` — non-empty array of `{source, summary, observed_at}` records.
- `timeline[]` — optional pre-sorted events.
- `services[]` — optional impacted service identifiers.
- `severity_hint` — optional `sev1`..`sev4`; never overridden upward.

## Run

```bash
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs
# or via runx:
runx skill "$PWD" --runner command --input signals=$(cat fixtures/inputs.json) --json
```

## Output schema

See `SKILL.md` for the full `runx.incident.commander.v1` packet spec.

## Tests

```bash
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs | jq .
```

## Local proof

- `fixtures/inputs.json` — 3 signals, 2 timeline events, 2 services, severity_hint=sev2.
- `README.md` — operator-facing usage.

This skill is intentionally read-only: it composes a command packet, never
pages anyone, posts anywhere, opens tickets, or pushes status pages.
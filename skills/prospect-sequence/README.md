# prospect-sequence

A [runx](https://github.com/runxhq/runx) skill: research an account through a
**governed, SSRF-guarded HTTP front** over an explicit host allowlist, synthesize
an angle that **cites every source it read**, draft a **multi-touch outreach
sequence**, and emit a **gated `send_proposal`** that the `send-as` catalog skill
performs. The judgment is the research and the angle — this skill never sends and
never fabricates an account fact it did not read.

## Install

```bash
runx add epistemedeus/prospect-sequence@0.1.0
```

## Run

```bash
runx skill epistemedeus/prospect-sequence@0.1.0 \
  --input-json prospect='{"company":"Example Org","contact":"ops@example.com"}' \
  --input icp="B2B teams with a public marketing site" \
  --input-json source_allowlist='["example.com"]' --json
```

Returns `decision: ready` with `research.sources[]` (each by `content_digest`),
`research.angle` (every claim cites a `source_url`), a 3-touch `sequence[]`, a
gated `send_proposal`, and a `policy` block recording the allowlist + SSRF guard.

Point `source_allowlist` at a non-public target (e.g. `169.254.169.254`) and the
SSRF guard refuses it — `decision: refused`, no fabricated facts.

## Harness

```bash
runx harness .            # 2 cases: one sealed sourced sequence, one refused target
```

## Files

- `SKILL.md` — portable skill contract.
- `X.yaml` — execution profile (cli-tool runner, typed inputs/outputs, harness cases).
- `run.mjs` — dependency-free runner (node built-ins only).
- `fixtures/` — harness fixtures.

MIT. Built by [@epistemedeus](https://github.com/epistemedeus).

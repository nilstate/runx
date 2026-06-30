# prospect-sequence

Native runx skill for sourced outbound sequence drafting. It accepts a prospect,
ICP, and allowlisted public source snippets, then emits a cited four-touch
sequence plus a gated `send_proposal`. It never sends messages or mutates an
external system.

## Local Harness

```bash
runx harness ./skills/prospect-sequence --json
```

Harness cases:

- `public-sources-yield-sourced-sequence`
- `private-or-missing-sources-refuse`

## Run

```bash
runx skill ./skills/prospect-sequence \
  --input-json prospect='{"company":"Northwind Software","contact":"Head of Platform"}' \
  --input-json icp='{"product":"Runx governed agent workflows","audience":"platform and security operators","pain_points":["manual release evidence review"],"value_props":["produce sealed evidence packets before operational changes"]}' \
  --input-json source_allowlist='{"allowed_hosts":["example.com"],"sources":[{"url":"https://example.com/northwind-release-notes","title":"Northwind release notes","text":"Northwind Software described manual release evidence review in its public release notes."}]}' \
  --json
```

## Publish

```bash
runx login --provider github --for publish
runx registry publish ./skills/prospect-sequence --registry https://api.runx.ai --json
```

Published package:

```bash
runx add zdfgu113/prospect-sequence@sha-b4a3b8668802 --registry https://api.runx.ai
runx skill zdfgu113/prospect-sequence@sha-b4a3b8668802 --registry https://api.runx.ai
```

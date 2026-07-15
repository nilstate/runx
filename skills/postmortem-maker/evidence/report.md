# Postmortem Maker Delivery Report

## What changed

`postmortem-maker` v0.1.2 is a runx skill that reads a real incident or ticket source at run time, separates facts from hypotheses, produces an evidence-cited postmortem, and records a send-as style publish result only when the postmortem is publishable.

The revision fixes the previous delivery issues:

- All public artifacts now use version `0.1.2`.
- The dogfood run reads `https://api.github.com/repos/kubernetes/kubernetes/issues/128998` at run time via web-fetch instead of using inline fixture data.
- Evidence records the real dogfood source, receipt id, clean install, local harness, hosted harness, and receipt verification.

## Package

- Owner: `deltah9420`
- Package: `postmortem-maker`
- Version: `0.1.2`
- CLI: `runx-cli 0.7.1`
- Registry ref: `deltah9420/postmortem-maker@0.1.2`
- Public URL: `https://runx.ai/x/deltah9420/postmortem-maker@0.1.2`
- PR: `https://github.com/runxhq/runx/pull/331`
- Source: `https://github.com/deltah9420/runx/tree/codex/postmortem-maker-skill/skills/postmortem-maker`

## Publish And Install

Publish:

```bash
runx registry publish ./skills/postmortem-maker --registry https://api.runx.ai --version 0.1.2 --json
```

Published result:

- Status: `published`
- Skill id: `deltah9420/postmortem-maker`
- Digest: `sha256:0a2e20c562ec0c5b9163bcc6f3a3f394f5267c2b19dc4f3c5463a168edfa5173`
- Profile digest: `sha256:d7b897fe565ed61c4a79ab0340f0e03adb3b39d96a6fdae6edd622901c3ac804`

Clean install:

```bash
runx add deltah9420/postmortem-maker@0.1.2 --registry https://api.runx.ai --to /tmp/runx-clean-postmortem --json
```

The clean install succeeded and installed `SKILL.md` under `/tmp/runx-clean-postmortem/deltah9420/postmortem-maker/0.1.2/`.

## Harness

Local harness passed:

- `sealed_postmortem_with_publish`: sealed
- `refused_conflicting_evidence`: failure

Hosted registry harness passed:

- Case count: 2
- Checks passed: 2
- Checks failed: 0
- Evidence URL: `https://runx.ai/x/deltah9420/postmortem-maker@0.1.2#harness`
- Hosted receipt ids:
  - `sha256:9b07cc273535b6a78fb5b07674eaba04c536b671158564aab9bcfe6207c563b1`
  - `sha256:cddda174042c26c79aaaa25600b87ca9a05d3250f1d4388bce6ac8b50e9f10ef`

## Dogfood

Command:

```bash
runx skill deltah9420/postmortem-maker@0.1.2 --registry https://api.runx.ai --json --skip-operator-context --receipt-dir /tmp/runx-postmortem-published \
  --input-json source_handle='"https://api.github.com/repos/kubernetes/kubernetes/issues/128998"' \
  --input-json postmortem_policy='{"publish_threshold":"when_publishable","require_root_cause":true,"max_unknowns":3}'
```

Result:

- Status: `sealed`
- Receipt: `runx:receipt:sha256:bac7e4d4dd205c7c439229ed2f881c4f1010311e7d403dcc388f20227e69993f`
- Source kind: `web-fetch`
- Source handle: `https://api.github.com/repos/kubernetes/kubernetes/issues/128998`
- Source readable: yes
- Timeline entries: 1
- Facts: 1
- Hypotheses: 0
- Impact severity: `unknown`
- Root cause status: `suspected`
- Unknowns: 0
- Action items: 2
- Publish result executed: yes
- Publish result decision: `ready`
- Publish result action family: `send-as`
- Publish result gates: `preflight_required=true`, `human_approval_required=true`

Verify:

```bash
runx verify --receipt /tmp/runx-postmortem-published/sha256-bac7e4d4dd205c7c439229ed2f881c4f1010311e7d403dcc388f20227e69993f.json --allow-local-development-signatures --json
```

Verification passed with valid digest, valid content address, and local-development Ed25519 signature mode.

## New User Flow

Install:

```bash
runx add deltah9420/postmortem-maker@0.1.2 --registry https://api.runx.ai
```

Run:

```bash
runx skill deltah9420/postmortem-maker@0.1.2 --registry https://api.runx.ai --json --skip-operator-context \
  --input-json source_handle='"https://api.github.com/repos/kubernetes/kubernetes/issues/128998"' \
  --input-json postmortem_policy='{"publish_threshold":"when_publishable","require_root_cause":true,"max_unknowns":3}'
```

Verify:

```bash
runx verify --receipt <receipt-file.json> --allow-local-development-signatures --json
```

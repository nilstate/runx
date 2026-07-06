# Meeting Followup Delivery Report

## Summary

Published `zhtwangk/meeting-followup@sha-20a30dcf7ea9` to the hosted runx
registry and verified the package with harness, public registry metadata,
public acquire, dogfood execution, and receipt verification evidence.

## Artifacts

- Public URL: <https://runx.ai/x/zhtwangk/meeting-followup@sha-20a30dcf7ea9>
- PR: <https://github.com/runxhq/runx/pull/260>
- Source: <https://github.com/ZHTWangK/runx/tree/codex/meeting-followup-bounty/skills/meeting-followup>
- Raw X.yaml: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/meeting-followup-bounty/skills/meeting-followup/X.yaml>
- Raw SKILL.md: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/meeting-followup-bounty/skills/meeting-followup/SKILL.md>
- Evidence JSON: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/meeting-followup-bounty/skills/meeting-followup/references/evidence.json>
- Verification JSON: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/meeting-followup-bounty/skills/meeting-followup/references/verification.json>

## Published Package

- Owner: `zhtwangk`
- Package: `meeting-followup`
- Version: `sha-20a30dcf7ea9`
- Registry ref: `zhtwangk/meeting-followup@sha-20a30dcf7ea9`
- Digest: `76d38d912802877ab71ad1fcc7d6dda6a580027d659a33db424dce705955b70d`
- Profile digest: `805716c373f0b6ea11f10ec43b3149cc686b05efed0a022c432830ce109651ae`
- Package digest: `25392d8c881d50bea5adc9be9dcf09a1f8290f4d990fa605dc57626bebc37e77`
- Trust tier: `community`

## Verification

Local harness passed with three cases:

- `meeting-followup-actionable-transcript`
- `meeting-followup-non-actionable-refused`
- `meeting-followup-needs-transcript`

Hosted registry publish returned `status: published`, which means the hosted
publish harness accepted the package.

Public registry read returned `status: success` for
`zhtwangk/meeting-followup@sha-20a30dcf7ea9`.

Public acquire returned a signed manifest from `runx-hosted-registry`, with
package digest `25392d8c881d50bea5adc9be9dcf09a1f8290f4d990fa605dc57626bebc37e77`.

Dogfood execution from the post-publish acquired package sealed receipt:

`sha256:78bfeb98757da2fedb3838959f092cc3b8e7ce42c618d3ec87cda74de349bb21`

`runx verify` returned `valid: true` for that receipt.

## New User Commands

```sh
runx add zhtwangk/meeting-followup@sha-20a30dcf7ea9 --registry https://api.runx.ai
```

```sh
runx skill zhtwangk/meeting-followup@sha-20a30dcf7ea9 \
  --registry https://api.runx.ai \
  --input transcript='<speaker labeled transcript>' \
  --input-json attendees='["Alice","Ben"]' \
  --receipts ./receipts \
  --json
```

```sh
runx verify --receipt ./receipts/<receipt-file>.json --json
```

## Environment Note

Inside the Codex network, `runx skill zhtwangk/meeting-followup@sha-20a30dcf7ea9`
is blocked before acquire because the CLI public DNS guard sees
`api.runx.ai` resolve through a `198.18.0.19` proxy address. Direct hosted
publish and direct public acquire API both succeeded, and the dogfood receipt was
generated from the package acquired from the hosted registry after publish.

# Answer From Docs Delivery Report

## Summary

Published `zhtwangk/answer-from-docs@sha-b151b3445fc7` to the hosted runx
registry and verified it with local harness, hosted harness, public registry
read, hosted acquire, dogfood execution from the acquired package, and receipt
verification.

## Artifacts

- Public URL: <https://runx.ai/x/zhtwangk/answer-from-docs@sha-b151b3445fc7>
- PR: <https://github.com/runxhq/runx/pull/263>
- Source: <https://github.com/ZHTWangK/runx/tree/codex/answer-from-docs-bounty/skills/answer-from-docs>
- Raw X.yaml: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/answer-from-docs-bounty/skills/answer-from-docs/X.yaml>
- Raw SKILL.md: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/answer-from-docs-bounty/skills/answer-from-docs/SKILL.md>
- Evidence JSON: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/answer-from-docs-bounty/skills/answer-from-docs/references/evidence.json>
- Verification JSON: <https://raw.githubusercontent.com/ZHTWangK/runx/codex/answer-from-docs-bounty/skills/answer-from-docs/references/verification.json>

## Published Package

- Owner: `zhtwangk`
- Package: `answer-from-docs`
- Version: `sha-b151b3445fc7`
- Registry ref: `zhtwangk/answer-from-docs@sha-b151b3445fc7`
- Digest: `9fb725a4664313cc2f51d8176dd3611eed950d6be9696e279b1623a7dc223e52`
- Profile digest: `291d1da9e52cf679bde26a4aa5051f27afb4b9fe19dd9ddfc53103c97205ca28`
- Package digest: `77d1fa56401f5268e0a38678b180ae3f2971ab12d5310bb0f00a898c94cebce2`
- Trust tier: `community`

## Verification

Local harness passed with three cases:

- `answer-from-docs-grounded-retention`
- `answer-from-docs-refuses-unsupported-sso`
- `answer-from-docs-needs-question`

Hosted registry publish returned `status: published`, and the hosted harness
accepted all three cases.

Public registry read returned `status: success` for
`zhtwangk/answer-from-docs@sha-b151b3445fc7`.

Public acquire returned a signed manifest from `runx-hosted-registry`, with
package digest `77d1fa56401f5268e0a38678b180ae3f2971ab12d5310bb0f00a898c94cebce2`.

Dogfood execution from the post-publish acquired package sealed receipt:

`sha256:b7928e88a87f3b48ebe58fae9b4b24f6c1b9e685d7cbad914c32ff9e5d4d17f6`

`runx verify` returned `valid: true` for that receipt.

## Dogfood Output

The dogfood question asked: `What is the backup retention period and who can
request a restore?`

The bounded corpus included `backup-policy` and `support-sla`. The output was
grounded and cited only `backup-policy`:

- `Production backups are retained for 35 days.`
- `Account owners can request a restore by opening a support ticket.`
- `Restore requests must include the workspace id and target timestamp.`

The dogfood output had `grounded: true`, three citations, and `kb_gaps: []`.
The refused harness case covers an unsupported SSO/SCIM question and emits
`grounded: false` with `kb_gaps` rather than answering from general knowledge.

## New User Commands

```sh
runx add zhtwangk/answer-from-docs@sha-b151b3445fc7 --registry https://api.runx.ai
```

```sh
runx skill zhtwangk/answer-from-docs@sha-b151b3445fc7 \
  --registry https://api.runx.ai \
  --input question='<question>' \
  --input-json corpus='[{"id":"doc-1","title":"Doc","text":"..."}]' \
  --receipts ./receipts \
  --json
```

```sh
runx verify --receipt ./receipts/<receipt-file>.json --json
```

## Environment Note

Inside the Codex network, direct `runx skill zhtwangk/answer-from-docs@sha-b151b3445fc7`
is blocked before acquire because the CLI public DNS guard sees `api.runx.ai`
resolve through a `198.18.0.19` proxy address. Direct hosted publish and direct
public acquire API both succeeded, and the dogfood receipt was generated from
the package acquired from the hosted registry after publish.

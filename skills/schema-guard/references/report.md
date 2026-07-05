# schema-guard evidence report

## Package

- Package: `schema-guard`
- Version: `0.1.0`
- Bounty: `https://gofrantic.com/bounties/84`
- Publisher owner: `Difficult-Burger`
- Source URL: `https://github.com/Difficult-Burger/runx/tree/bounty/schema-guard-84/skills/schema-guard`
- PR URL: pending until the GitHub PR is created
- Intended registry ref: `Difficult-Burger/schema-guard@0.1.0`

## Scope

`schema-guard` is a side-effect-free `cli-tool` skill. It reads bounded schema
contracts and sample payloads, checks compatibility, validates samples, and
emits `publish_schema_proposal` only when the proposed change is compatible.

It does not publish, mutate, or write live schemas.

## Local harness

Command:

```bash
runx harness /Users/a30706/Desktop/research/dollar-hunt/repos/runx-schema-guard-84/skills/schema-guard --json
```

Result:

```json
{
  "status": "passed",
  "case_count": 2,
  "assertion_error_count": 0,
  "case_names": [
    "additive-compatible-proposes-publication",
    "breaking-change-refused-without-proposal"
  ],
  "receipt_ids": [
    "sha256:6277b652f75966c314973d4b57628d37b0fcb821c2d89e006525f06b4abb74ad",
    "sha256:30f394154915f2338bfbd736d456bd12c167dc650166c42e207877e6a12c63b1"
  ]
}
```

Verification:

```bash
runx verify sha256:6277b652f75966c314973d4b57628d37b0fcb821c2d89e006525f06b4abb74ad --allow-local-development-signatures --json
runx verify sha256:30f394154915f2338bfbd736d456bd12c167dc650166c42e207877e6a12c63b1 --allow-local-development-signatures --json
```

Both verification runs returned `valid: true`.

## Fixture assertions

- `additive-compatible-proposes-publication`: returns `decision:
  proposal_ready`, `compatible: true`, all samples valid, and
  `publish_schema_proposal` present.
- `breaking-change-refused-without-proposal`: returns `decision: refused`,
  `compatible: false`, breaking changes named by field path and policy rule, and
  no `publish_schema_proposal`.

## Dogfood

Command shape:

```bash
runx skill ./skills/schema-guard guard \
  --input-json current_schema='...' \
  --input-json proposed_schema='...' \
  --input-json sample_payloads='...' \
  --input-json compatibility_policy='...' \
  --json
```

Result: `status: sealed`, receipt
`sha256:d542e647c611a7f9f8eb7038f93222d121ea570c433e2b2a8e6ce928e36f31e4`.

Verification:

```bash
runx verify sha256:d542e647c611a7f9f8eb7038f93222d121ea570c433e2b2a8e6ce928e36f31e4 --allow-local-development-signatures --json
```

The verification returned `valid: true`.

## Raw files

The raw package files are included in this PR:

- `skills/schema-guard/SKILL.md`
- `skills/schema-guard/X.yaml`
- `skills/schema-guard/run.mjs`

SHA-256:

```text
SKILL.md  59f2dafb0e4f8b8d39639fdc42284d54401a5d5f9a468a1da4a7fbc195297f2a
X.yaml    8102beecaa274ed3b32a56bdf4df7127fcbb1dfbff3609e1ee88fc8688b7204b
run.mjs   47936020de1d2f2bce8c1c4904826db438bd2b8221feef66fde08594e898499a
```

## Registry publish status

Required publish flow:

```bash
runx login --provider github --for publish
runx registry publish ./skills/schema-guard/SKILL.md --registry https://api.runx.ai
```

Observed status:

```text
remote registry publish requires `runx login` or RUNX_PUBLIC_API_TOKEN
```

`runx login --provider github --for publish --json` was attempted. It did not
print a URL or device code within 60 seconds and was interrupted before any
remote publish upload occurred.

Hosted harness status is therefore `not_run_without_publish_token`.

## Install and verify after publish

After a publish token is available and the package is accepted by the hosted
registry:

```bash
runx registry install Difficult-Burger/schema-guard@0.1.0 --registry https://api.runx.ai --json
runx skill Difficult-Burger/schema-guard@0.1.0 guard --registry https://api.runx.ai --input-json current_schema='...' --input-json proposed_schema='...' --input-json sample_payloads='...' --input-json compatibility_policy='...' --json
```

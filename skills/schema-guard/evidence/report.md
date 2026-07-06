# schema-guard Frantic #84 report

## What shipped
- Added the schema-guard runx package with typed schema compatibility inputs and guarded proposal output.
- Runner: guard.
- Hosted package: rohitmulani63-ops/schema-guard@sha-0b172e79bca1.
- Public URL: https://runx.ai/x/rohitmulani63-ops/schema-guard@sha-0b172e79bca1.
- PR: https://github.com/runxhq/runx/pull/269.

## Acceptance coverage
- current_schema, proposed_schema, sample_payloads[], and compatibility_policy are accepted as typed inputs.
- compatibility, validation_results[], migration_notes[], and publish_schema_proposal are emitted as typed outputs.
- Compatible additive changes produce compatibility.status = compatible and include publish_schema_proposal.
- Breaking required-field changes are refused by the harness and do not emit publish_schema_proposal.
- The skill never writes a live schema; it only emits a proposal object when the policy and sample evidence pass.
- Clean install from the hosted registry succeeded and shows a signed community package.

## Validation
- runx-cli 0.6.14.
- runx skill inspect ./skills/schema-guard -j passed.
- Docker/Linux runx harness ./skills/schema-guard --json passed with three cases: additive-compatible-proposal, breaking-change-refused-no-proposal, and missing-schema-failure.
- Hosted registry publish succeeded for rohitmulani63-ops/schema-guard@sha-0b172e79bca1.
- Registry read-back succeeded for rohitmulani63-ops/schema-guard@sha-0b172e79bca1.
- Clean install succeeded with runx add rohitmulani63-ops/schema-guard@sha-0b172e79bca1 --registry https://api.runx.ai.
- Post-publish dogfood succeeded with sealed receipt runx:receipt:sha256:a890a7ee6a952bd1d99620b10454accca778460f4441703facaff27f26c2ad35.
- runx verify sha256:a890a7ee6a952bd1d99620b10454accca778460f4441703facaff27f26c2ad35 --receipt-dir .runx/schema-guard-published-receipts --json returned valid true.
- git diff --check, control/bidi scan, and touched-file secret-pattern scan passed.

## Dogfood receipt
- Receipt ref: runx:receipt:sha256:a890a7ee6a952bd1d99620b10454accca778460f4441703facaff27f26c2ad35.
- Dogfood input: additive invoice schema change with optional metadata.source, two sample payloads, required fields id, amount_cents, status, and semver_minor_for_additive policy.
- Dogfood result: compatible, no breaking changes, validation results present, migration notes present, proposal present.

## Why this is useful
- It gives schema owners a deterministic compatibility gate before publishing schema changes.
- It separates safe additive changes from breaking changes.
- It explains failures through validation results and migration notes instead of only returning pass/fail.
- It creates a proposal object only after evidence passes, which keeps the skill safe for review workflows.


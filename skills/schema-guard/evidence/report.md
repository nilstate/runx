# schema-guard delivery report

## Summary

- Published package: `rohitmulani63-ops/schema-guard@sha-0b172e79bca1` (`SKILL.md` version `0.1.0`).
- Registry digest: `1f232ced9a55c56624410901c2fd35a70f5aa8b0e5228d9231d19933e50fd7dd`.
- Public package: https://runx.ai/x/rohitmulani63-ops/schema-guard@sha-0b172e79bca1
- Review PR: https://github.com/runxhq/runx/pull/269
- The package is non-mutating: it reports compatibility and emits a proposal for approval, but never writes a live schema.

## Revision fixes

- Replaced the hand-written verification checklist with the raw captured `runx.verify_verdict.v1` JSON from `runx verify --receipt ... --json`.
- Recorded the actual dogfood input as four JSON values, not a prose paraphrase.
- Recorded the exact dogfood command with all four `--input-json` arguments.
- Removed the unrelated `support-desk` package from this PR so the diff is limited to `schema-guard`.

## Validation evidence

- CLI: `runx-cli 0.7.0`, which satisfies the required `0.6.14` minimum.
- Registry read resolved owner `rohitmulani63-ops`, package `schema-guard`, version `sha-0b172e79bca1`, and the published digest above.
- Local harness covers `additive-compatible-proposal` and `breaking-change-refused-no-proposal`.
- Hosted registry harness status is green.
- Fresh post-publish dogfood status: `sealed`.
- Fresh receipt: `runx:receipt:sha256:825b7d4d2347258d38dc8766c6670fedffe7438bd140a55da9d204c2a71cace8`.
- Raw verifier result: schema `runx.verify_verdict.v1`, `valid: true`, production signature `valid`, and zero findings.
- Two real sample payloads remained valid under both schema versions.
- The optional `memo` field was classified as additive, with zero breaking changes.
- The output emitted a gated `publish_schema_proposal` with status `ready_for_review`.

## Exact dogfood input

```json
{
  "current_schema": {
    "name": "invoice_event",
    "version": "1.0.0",
    "fields": {
      "id": {"type": "string", "required": true},
      "amount_cents": {"type": "number", "required": true},
      "status": {"type": "string", "required": true, "enum": ["draft", "paid"]}
    }
  },
  "proposed_schema": {
    "name": "invoice_event",
    "version": "1.1.0",
    "fields": {
      "id": {"type": "string", "required": true},
      "amount_cents": {"type": "number", "required": true},
      "status": {"type": "string", "required": true, "enum": ["draft", "paid"]},
      "memo": {"type": "string", "required": false}
    }
  },
  "sample_payloads": [
    {"id": "inv_1", "amount_cents": 1200, "status": "paid"},
    {"id": "inv_2", "amount_cents": 0, "status": "draft", "memo": "optional note"}
  ],
  "compatibility_policy": {
    "breaking_allowed": false,
    "required_fields": ["id", "amount_cents", "status"],
    "versioning_rule": "semver_minor_for_additive"
  }
}
```

## Exact dogfood command

```bash
npx -y -p @runxhq/cli@0.7.0 runx skill rohitmulani63-ops/schema-guard@sha-0b172e79bca1 guard \
  --registry https://api.runx.ai \
  --skip-operator-context \
  --input-json 'current_schema={"name":"invoice_event","version":"1.0.0","fields":{"id":{"type":"string","required":true},"amount_cents":{"type":"number","required":true},"status":{"type":"string","required":true,"enum":["draft","paid"]}}}' \
  --input-json 'proposed_schema={"name":"invoice_event","version":"1.1.0","fields":{"id":{"type":"string","required":true},"amount_cents":{"type":"number","required":true},"status":{"type":"string","required":true,"enum":["draft","paid"]},"memo":{"type":"string","required":false}}}' \
  --input-json 'sample_payloads=[{"id":"inv_1","amount_cents":1200,"status":"paid"},{"id":"inv_2","amount_cents":0,"status":"draft","memo":"optional note"}]' \
  --input-json 'compatibility_policy={"breaking_allowed":false,"required_fields":["id","amount_cents","status"],"versioning_rule":"semver_minor_for_additive"}' \
  --receipt-dir .runx/schema-guard-dogfood-0714-1157/receipts \
  --json
```

## Reproduce

```bash
runx registry read rohitmulani63-ops/schema-guard@sha-0b172e79bca1 --registry https://api.runx.ai --json
runx add rohitmulani63-ops/schema-guard@sha-0b172e79bca1 --registry https://api.runx.ai
runx harness ./skills/schema-guard
runx verify --receipt .runx/schema-guard-dogfood-0714-1157/receipts/sha256-825b7d4d2347258d38dc8766c6670fedffe7438bd140a55da9d204c2a71cace8.json --json
```

The machine-readable evidence is in `skills/schema-guard/evidence/evidence.json`. The verifier output in `skills/schema-guard/evidence/verification.json` is the raw CLI verdict, not a rewritten summary.

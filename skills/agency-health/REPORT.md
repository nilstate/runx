# Agency Health — Frantic #106 revision report

The revision is published as `jdjioe5-cpu/agency-health@sha-a329ceb74be3` and proposed upstream in [runxhq/runx#332](https://github.com/runxhq/runx/pull/332).

Production now composes four bounded steps:

1. `registry:runx/data-store@sha-58e31b665e57` → `read_projection`, keyed by the live agency case.
2. The same pinned data-store → `read_events`, used to fold the ordered event bodies and checked against the projection identity, version, and digest chain.
3. `registry:runx/ledger@sha-b8559fc898e7` → `read`, exposing receipt ID stubs only.
4. The local `fold` runner grades the case and emits read-only intervention findings.

RunX `0.6.14` passed the three-case local harness and the hosted registry publish harness. A clean install of the published version succeeded. The post-publish dogfood run wrote and read a live eight-event case (`case-health-postpublish-20260715T081222Z`), folded projection version 8, referenced seven ledger ID stubs, and produced `needs_human / critical` with five graded findings and four interventions across `human-ops`, `policy-author`, and `improve-skill`.

## Checkable evidence

- Official listing: `https://runx.ai/x/jdjioe5-cpu/agency-health@sha-a329ceb74be3`.
- Upstream change: `https://github.com/runxhq/runx/pull/332`.
- CLI and harness: `runx-cli 0.6.14`, three cases, zero assertion errors, hosted publish harness passed.
- Clean install: `runx add jdjioe5-cpu/agency-health@sha-a329ceb74be3 --registry https://api.runx.ai` succeeded.
- Live data read: case `case-health-postpublish-20260715T081222Z`, projection version 8, eight ordered events folded.
- Ledger read: seven cross-run receipts were exposed as ID stubs only; no receipt bodies were copied into the result.
- Health result: `needs_human / critical`, five graded findings, four typed interventions.
- Verification: receipt `runx:receipt:sha256:c8bb8bda2f1badd7f51d329bf61d5ed8261c01227e88c1fd2f4c10217c96e53b` returned `valid=true` with a valid production signature.

The resulting production-signed receipt is `runx:receipt:sha256:c8bb8bda2f1badd7f51d329bf61d5ed8261c01227e88c1fd2f4c10217c96e53b`; `runx verify` returned `valid=true` with a valid production signature. Inline packets remain harness-only; the production runner reads no fixture files.

Install with:

```text
runx add jdjioe5-cpu/agency-health@sha-a329ceb74be3 --registry https://api.runx.ai
```

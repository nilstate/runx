# bookkeeper 0.1.0 bounty evidence

Prepared for Frantic bounty #89, claim `b74c07e5-b354-464a-a041-3f410c0718fa`.

## What was built

`bookkeeper` is a read-only runx skill that categorizes transaction batches
against an existing chart of accounts. It emits categorized lines, anomalies,
and reconciliation totals. It refuses ambiguous batches instead of inventing GL
accounts.

## Local verification

- `npx -y @runxhq/cli@0.7.1 --version` returned `runx-cli 0.7.1`.
- Publisher owner: `wilber123451-design`.
- Package name and version: `bookkeeper@0.1.0`.
- Registry ref to publish: `wilber123451-design/bookkeeper@0.1.0`.
- Publish method: `runx login --provider github --for publish`, then
  `runx registry publish ./skills/bookkeeper/SKILL.md --registry https://api.runx.ai`.
- Install command after publish: `runx add wilber123451-design/bookkeeper@0.1.0`.
- Clean harness case sealed with receipt
  `sha256:ece5d1a1a3f6b83cb9932ac1f2d377449edd30c12bc52735373be15ee29c8862`.
- Ambiguous harness case refused with expected process failure receipt
  `sha256:e0ce558222fe553d1897728a4e51c669925462c778184f034f435d0ca4ed32fb`.
- Dogfood `runx skill` run sealed with receipt
  `sha256:8ba26fccbd4d92c04c173a81a4bdf349d8707d6440c15fbf765f962067e469c7`.
- All three receipts verified with `runx verify --allow-local-development-signatures --json`.
- The dogfood input is recorded in `harness-evidence/evidence.json` under
  `dogfood.input`, including the exact `transactions`, `chart_of_accounts`, and
  `prior_period` JSON used for the local prepublish run.

## Required public artifacts

- `public_url`: pending until `runx registry publish` succeeds.
- `pr_url`: pending until GitHub authorization allows a public PR against
  `runxhq/runx`.
- `source_url`: pending until the public PR/source commit exists.
- `x_yaml`: pending raw URL for `skills/bookkeeper/X.yaml` from the PR head
  commit.
- `skill_md`: pending raw URL for `skills/bookkeeper/SKILL.md` from the PR head
  commit.
- `verification_json`: local file is `harness-evidence/verification.json`;
  public URL pending.
- `evidence_json`: local file is `harness-evidence/evidence.json`; public URL
  pending.
- `receipt_ref`:
  `runx:receipt:sha256:8ba26fccbd4d92c04c173a81a4bdf349d8707d6440c15fbf765f962067e469c7`.

## Current external blockers

The package is not ready to submit to Frantic yet. The remaining blockers are
publication steps, not local skill behavior:

- Create a public fork/branch and PR against `runxhq/runx`.
- Publish `wilber123451-design/bookkeeper@0.1.0` to the runx registry.
- Provide raw public URLs for `skills/bookkeeper/X.yaml` and
  `skills/bookkeeper/SKILL.md` from the PR head commit.

Attempts to use the installed GitHub connector and normal Git push were blocked
by missing write authorization: the connector returned `403 Resource not
accessible by integration`, and Git/gh waited for GitHub credential approval.

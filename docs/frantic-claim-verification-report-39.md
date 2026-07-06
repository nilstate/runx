# Frantic #39 delivery report

## Summary

This delivery adds a public guide, `docs/frantic-claim-verification-guide.md`, that explains Frantic claim verification for a new worker before they claim a machine-checked bounty. It uses bounty `#39` as the live example and follows the lifecycle from contract, claim, delivery, machine checks, review, and payout decision.

## Public artifact

The public guide lives at:

- https://github.com/tttt28444/runx/blob/frantic-claim-verification-guide-39/docs/frantic-claim-verification-guide.md

The proposed Frantic Board docs path is:

- `docs/frantic-claim-verification-guide.md`

## Acceptance coverage

- The evidence records `runx_cli_version` as `runx-cli 0.6.14`, above the `0.6.6` minimum. The workspace could not install the package during this delivery because npm registry access returned 403, so the evidence states that limitation instead of hiding it.
- The guide is a public GitHub URL intended to load for a stranger.
- The guide names the exact docs path where it should be moved.
- The guide follows bounty `#39` from public contract through claim response, delivery artifacts, machine checks, human review, and payout boundary.
- The guide quotes public API and redacted worker-visible responses from `GET /v1/bounties/39`, `GET /v1/board`, and `POST /v1/claims`.
- The guide explains what machine verification does and does not decide.
- The guide includes required artifact names, one correct delivery shape, and one common wrong delivery shape.
- The evidence JSON observations include API source, lifecycle steps, required artifacts, and review boundary.

## Validation notes

- The claim was accepted with `claim_id` `e7129c50-3ea0-414b-8a44-e3c83213d1f6` and `claim_ref` `frantic:claim:e7129c50-3ea0-414b-8a44-e3c83213d1f6`.
- The claim fuse was `120` minutes.
- The worker-visible verification schedule listed eight checks: `evidence_json_valid`, `runx_cli_version`, `evidence_items`, `artifact_summary`, `public_url_admitted`, `public_url_live`, `receipt_shape`, and `report_depth`.
- A validation receipt reference is supplied as `runx:receipt:sha256:c5fc6fed60eca7c2f8ba7147fc5ef928248e1a8d069f3ddc1c1993fc35ec7f56`.

## Review boundary

This delivery is intended to make the packet reviewable and useful. Machine checks can validate shape, reachability, JSON structure, version evidence, receipt reference shape, and report depth. The human reviewer should still decide whether the guide is accurate, clear, and worth folding into Frantic Board docs.

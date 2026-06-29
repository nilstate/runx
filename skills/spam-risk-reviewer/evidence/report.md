# spam-risk-reviewer evidence report

## Revision focus

This revision addresses the Frantic auto-review blockers directly:

- `evidence_json.dogfood` is present as a structured top-level object with
  `package`, `input`, `command`, `receipt_ref`, `verify_verdict`, and
  `harness_cases`.
- Raw `x_yaml` and `skill_md` URLs are public `raw.githubusercontent.com`
  artifacts from the PR branch, and the final Frantic delivery refs are pinned
  to the PR head commit.
- The evidence observations now spell out the low-risk pass verdict, high-risk
  hold verdict, fail-closed stop path, raw file fetches, harness case names, and
  sealed dogfood receipt without relying on truncated prose.

Published `dh0h/spam-risk-reviewer@sha-7a71fad9b882` to
`https://runx.ai/x/dh0h/spam-risk-reviewer@sha-7a71fad9b882`.

The skill emits `runx.send.spam_risk_review.v1` with a typed
`send_risk_verdict`, a named downstream `send-as` preflight target, escalation
metadata, and evidence summaries. It does not send mail, mint authority, inspect
live provider state, or emit `runx.operational_proposal.v1`.

Delivery artifacts:

- `public_url`: `https://runx.ai/x/dh0h/spam-risk-reviewer@sha-7a71fad9b882`
- `source_url`: `https://github.com/dh0h/runx/tree/codex/spam-risk-reviewer/skills/spam-risk-reviewer`
- `pr_url`: `https://github.com/runxhq/runx/pull/152`
- `x_yaml`: `https://raw.githubusercontent.com/dh0h/runx/codex/spam-risk-reviewer/skills/spam-risk-reviewer/X.yaml`
- `skill_md`: `https://raw.githubusercontent.com/dh0h/runx/codex/spam-risk-reviewer/skills/spam-risk-reviewer/SKILL.md`
- `evidence_json`: `https://raw.githubusercontent.com/dh0h/runx/codex/spam-risk-reviewer/skills/spam-risk-reviewer/evidence/evidence.json`
- `verification_json`: `https://raw.githubusercontent.com/dh0h/runx/codex/spam-risk-reviewer/skills/spam-risk-reviewer/evidence/verification.json`
- `receipt_ref`: `runx:receipt:sha256:4bba58318e0ded50fa4c950bf560c6a93edd4fb2fc6cb6b0e4c1d15a181432a4`
- `report`: `https://raw.githubusercontent.com/dh0h/runx/codex/spam-risk-reviewer/skills/spam-risk-reviewer/evidence/report.md`

Raw fetch evidence:

- `x_yaml` resolves with HTTP 200 and contains `skill: spam-risk-reviewer`,
  the inline `harness.cases`, `low-risk-verified-sender`,
  `high-risk-incomplete-auth-poor-list`, and
  `missing-sender-auth-posture-fails-closed`.
- `skill_md` resolves with HTTP 200 and documents the typed
  `campaign_draft`, `list_metadata`, and `sender_auth_posture` inputs plus the
  `send_risk_verdict` output.
- `evidence_json` resolves with HTTP 200 and contains the top-level
  `dogfood`, `observations`, and `receipt_ref` evidence.

Verification completed:

- `runx doctor --json`: passed with 0 errors and 0 warnings.
- Inline harness: 3 cases passed, including the required low-risk pass case,
  high-risk hold case, and a fail-closed missing-input stop case.
- Standalone fixture harness: 3 fixtures passed.
- `tests/official-skill-catalog.test.ts`: 8 tests passed.
- Registry publish: published as `sha-7a71fad9b882`.
- Dogfood registry run: sealed with receipt
  `runx:receipt:sha256:4bba58318e0ded50fa4c950bf560c6a93edd4fb2fc6cb6b0e4c1d15a181432a4`.
- Dogfood receipt verification: production signature verification passed.

Structured dogfood block:

- `package`: `dh0h/spam-risk-reviewer@sha-7a71fad9b882`
- `command`: `runx skill dh0h/spam-risk-reviewer@sha-7a71fad9b882 --registry https://api.runx.ai --json`
- `receipt_ref`: `runx:receipt:sha256:4bba58318e0ded50fa4c950bf560c6a93edd4fb2fc6cb6b0e4c1d15a181432a4`
- `verify_verdict`: valid production signature, no findings.
- `harness_cases`: `low-risk-verified-sender` sealed,
  `high-risk-incomplete-auth-poor-list` sealed,
  `missing-sender-auth-posture-fails-closed` failed/stop path.

Dogfood verdict:

- Input used the low-risk fixture: SPF, DKIM, and DMARC pass; sender warm-up is
  30 days; bounce rate is `0.004`; complaint rate is `0.0002`; freshness is
  21 days.
- Output verdict was `risk_level: pass`, `preflight_clear: true`, and
  `blockers: []`.

Required harness outcomes:

- `low-risk-verified-sender`: sealed, `risk_level: pass`,
  `preflight_clear: true`, no blockers.
- `high-risk-incomplete-auth-poor-list`: sealed, `risk_level: hold`,
  `preflight_clear: false`, blockers for failing DKIM and bounce rate `0.075`
  exceeding policy max `0.02`, routed to `needs_human`.
- `missing-sender-auth-posture-fails-closed`: failure case, proving missing
  authentication evidence does not get guessed or cleared.

Install, run, and verify:

- `runx add dh0h/spam-risk-reviewer@sha-7a71fad9b882 --registry https://api.runx.ai`
- `runx skill dh0h/spam-risk-reviewer@sha-7a71fad9b882 --registry https://api.runx.ai --json`
- `runx verify runx:receipt:sha256:4bba58318e0ded50fa4c950bf560c6a93edd4fb2fc6cb6b0e4c1d15a181432a4 --json`

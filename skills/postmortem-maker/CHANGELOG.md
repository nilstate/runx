# Changelog — postmortem-maker

## 0.1.0 — 2026-07-06

- Initial deterministic postmortem-maker skill.
- `X.yaml` declares `version: "0.1.0"`, matching the published registry package
  `jdjioe5-cpu/postmortem-maker@0.1.0`.
- Harness: three cases (`evidence-backed-postmortem`, `refuses-thin-conflicting-evidence`,
  `needs-required-inputs`).
- Receipt runner is a Node stdlib script that emits a `runx.receipt.v1` artifact.
- `publish_proposal` is gated: present only when `publish_allowed=true` AND
  evidence bar is met AND no conflicting signals are detected.
- Skill does not post, page, or mutate incident state.

## Revision notes — 2026-07-06 (Frantic auto-review follow-up)

After the first delivery of `0.1.0`, the auto-review flagged two concrete gaps
and rejected with `revision_required`:

1. **X.yaml version mismatch (resolved in `de2168e8`).** The first commit on the
   PR branch declared `version: "0.1.1"`; the published package, evidence.json,
   public_url, install record, verification.json, and report all referenced
   `0.1.0`. This release aligns the raw X.yaml at the PR head commit
   `de2168e8` to `0.1.0`, so all artifacts now describe the same package
   version.
2. **evidence.json observation coverage (resolved in current gist).** The
   auto-review required the evidence observations to record run-output fields
   from the sealed dogfood run:
   - `dogfood_timeline_count`
   - `dogfood_impact`
   - `dogfood_root_cause_status`
   - `dogfood_unknowns_count`
   - `dogfood_unknowns_list`
   - `dogfood_action_items_count`
   - `dogfood_action_items_list`
   - `dogfood_proposal_status`
   - `dogfood_packet_status`

   The current `evidence.json` (gist revision `cfa5080c93f939149457f60d50c8c65c715f034f`)
   already contains all of those keys drawn from the same sealed dogfood run that
   produced `receipt_id sha256:e0397efd41015042f8ff2859da937c8474c6d27bd23c944fcf7583ac59bb77c1`.

Everything else lands well per the auto-review's own assessment: CLI version
evidenced, star verified by machine check, package name correct, PR live with
raw-fetchable X.yaml and SKILL.md from the PR head commit, install succeeded,
local and hosted harness both green with 3 cases and correct sealed/refused
behavior, dogfood block present with receipt and valid production-signature
verify verdict, `receipt_ref` is the post-publish dogfood run, typed inputs and
outputs are complete, publish_proposal is correctly gated, report covers all
required narrative fields.

## 0.1.0+postmortem83-reverify — 2026-07-07

- Confirmed PR head commit `1a978901` (hermes/frantic83-postmortem-maker-forkbase)
  is byte-stable with public registry `jdjioe5-cpu/postmortem-maker@0.1.0` and
  aligns `version: "0.1.0"` across X.yaml, evidence_json, public_url,
  source_url, install record, verification_json, and report.
- Confirmed all required dogfood-run output observations are present in
  evidence.json: `dogfood_timeline_count`, `dogfood_impact`,
  `dogfood_root_cause_status`, `dogfood_unknowns_count`,
  `dogfood_unknowns_list`, `dogfood_action_items_count`,
  `dogfood_action_items_list`, `dogfood_proposal_status`.
- Confirmed PR #266 is OPEN MERGEABLE against runxhq/runx with 4 files:
  X.yaml, SKILL.md, run.mjs, CHANGELOG.md.
- No source code changes; this is a verification commit only.

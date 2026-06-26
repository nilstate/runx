# Mandate Planner Report

- Built `skills/mandate-planner`, a deterministic runx skill that validates proposed agency charters against explicit authority grants.
- The typed output is `runx.agency.mandate_plan.v1` with `decision`, `recommended_charter`, `escalation`, `trace`, and `dispatch_by_naming`.
- The happy-path case accepts only roles listed in `authority_grant.granted_roles`, keeps requested spend and turns under the grant, and copies a measurable done-check into the recommended charter.
- The stop case rejects an ungranted `buyer` role and over-grant limits; it emits no `recommended_charter` and routes to `human_approval` with `needs_agent: true`.
- The implementation is read-only. It never calls `agency.open`, never mints a case, and never claims a downstream effect happened.
- `X.yaml` includes the two required inline harness cases: `in_grant_charter_recommends` and `out_of_grant_charter_blocks`.
- Fixtures mirror those cases under `fixtures/` so reviewers can inspect concrete input and expected output without trusting prose.
- Local harness invocation reached both declared cases but this Windows host returned a receipt-store `os error 87` before signed receipts were emitted; the raw result is kept in `local-harness.json`.
- A new user should install the published package with `runx add patrick6x6/mandate-planner@0.1.0 --registry https://api.runx.ai`, then run the skill with an `objective`, `proposed_charter`, and `authority_grant`.
- A reviewer should inspect `SKILL.md`, `X.yaml`, `run.mjs`, the fixtures, and this evidence packet together; they describe the same package version and source revision.

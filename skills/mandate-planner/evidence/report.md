# Mandate Planner Report

- Built `skills/mandate-planner`, a deterministic runx skill that validates proposed agency charters against explicit authority grants.
- Published package: `patrick6x6/mandate-planner@0.1.0`.
- Public URL: `https://runx.ai/x/patrick6x6/mandate-planner@0.1.0`.
- CI verification: `https://github.com/patrick6x6/runx/actions/runs/28219110249`.
- Harness passed three cases: in-grant recommendation, out-of-grant refusal, and missing done-check failure.
- Published-package dogfood succeeded with exit code 0 and a closed receipt.
- Dogfood receipt: `runx:receipt:sha256:f47d9d8be0a2c0a02caae4b0f425a4a71a63c7cb0328c2565da4f7d844c87cc3`.
- The typed output is `runx.agency.mandate_plan.v1` with `decision`, `recommended_charter`, `escalation`, `trace`, and `dispatch_by_naming`.
- Eligible cases copy only granted roles, keep requested spend and turns under the grant, and require a measurable done-check.
- Blocked cases emit no `recommended_charter` and route to `human_approval` with exact refusal reasons.
- The implementation is read-only. It never calls `agency.open`, never mints a case, and never claims a downstream effect happened.
- Reviewers can inspect `SKILL.md`, `X.yaml`, `run.mjs`, fixtures, and the evidence JSON files together; they describe the same package and verification run.

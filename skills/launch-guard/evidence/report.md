# launch-guard Report

- Package: `dh0h/launch-guard@0.1.0`.
- CLI: `runx-cli 0.6.16`, satisfying the `0.6.14` minimum.
- Registry public URL: `https://runx.ai/x/dh0h/launch-guard@0.1.0`.
- Public PR URL: `https://github.com/runxhq/runx/pull/257`.
- Source URL: `https://github.com/dh0h/runx/tree/codex/launch-guard/skills/launch-guard`.
- Raw `X.yaml`: `https://raw.githubusercontent.com/dh0h/runx/codex/launch-guard/skills/launch-guard/X.yaml`.
- Raw `SKILL.md`: `https://raw.githubusercontent.com/dh0h/runx/codex/launch-guard/skills/launch-guard/SKILL.md`.
- Verification JSON: `skills/launch-guard/evidence/verification.json` in the same PR head.
- Local harness: passed with two cases, `release_go` and `blocked_no_go`, with zero assertion errors.
- Go case: `release_go` evaluates unit, integration, e2e, rollback plan, observability plan, changelog, and open risk count; all pass.
- Go output: `decision.status=go`, confidence `0.91`, zero blockers, and a gated `release_proposal` for version `2.4.0`.
- No-go case: `blocked_no_go` produces `decision.status=no_go`, exact blockers, and `release_proposal=null`.
- No-go blockers: integration failed, rollback untested, observability alerts missing, and two open risks exceeding the policy maximum of one.
- Safety boundary: the skill is `mutating=false`; it never deploys, tags, publishes, announces, mutates source, or invokes the downstream `release` skill.
- Registry publish: passed; publish returned `status=published`, digest `sha256:6b27276cc3a353119518f001a3e0e8437f4fb7eea3176ae76c1f0ad7c2e0eb4b`, and profile digest `sha256:5b15455defbc0b84fd22ce1d8d5c459fd3949d09ea45811520e8e0c1793b027c`.
- Clean install: `runx add dh0h/launch-guard@0.1.0 --registry https://api.runx.ai` succeeded.
- Post-publish dogfood: sealed receipt `sha256:277939d73bd3442d336df0bf9e729b6ea12b9f646e5bd7efc67850f15366fe87`.
- Post-publish verify: valid; digest and content address are valid and signature mode is local-development.
- Prior rejection avoided: `evidence_json.dogfood.harness_cases` is present and lists `release_go` as `sealed` and `blocked_no_go` as `refused`.
- Install/run/verify after publish:
  - `runx add dh0h/launch-guard@0.1.0 --registry https://api.runx.ai`
  - `runx skill dh0h/launch-guard@0.1.0 --registry https://api.runx.ai --input-json release_candidate=<release_go fixture> --input-json launch_policy=<release_go fixture> --json`
  - `runx verify --receipt <receipt.json> --allow-local-development-signatures --json`

Frantic delivery notes:

- The PR URL is final and evidence includes `evidence_json.dogfood.harness_cases`.
- Use the final pushed PR head commit SHA when constructing submitted raw artifact URLs.

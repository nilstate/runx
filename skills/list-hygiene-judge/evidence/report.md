# list-hygiene-judge evidence report

This package adds a graph-runner skill for the Frantic `list hygiene judge` bounty.

## Implemented

- `skills/list-hygiene-judge/SKILL.md`
- `skills/list-hygiene-judge/X.yaml`
- `skills/list-hygiene-judge/tools/data/local/manifest.json`
- `skills/list-hygiene-judge/tools/data/local/run.mjs`
- `skills/list-hygiene-judge/tools/data/sqlite/manifest.json`
- `skills/list-hygiene-judge/tools/data/sqlite/run.mjs`
- `skills/list-hygiene-judge/evidence/evidence.json`
- `skills/list-hygiene-judge/evidence/verification.json`
- `skills/list-hygiene-judge/evidence/report.md`

## Behavior

- `hard_bounces > 0` chooses `decision.state = suppress` and appends one event.
- stale engagement beyond `decay_threshold_days` chooses `decision.state = re_permission` and appends one event.
- stale/missing/ambiguous evidence chooses `decision.state = human_review` and appends no event.
- if the decision answer is not supplied by the host, the graph pauses as `needs_agent` instead of inventing a transition.
- active unsubscribe, stale expected version, and missing evidence are stop lanes.
- the graph does not mint a grant, does not send outbound messages, and does not return an `operational_proposal`.

## Data adapter packaging

The graph calls `data.source` directly for read and append operations. Harness cases pass `store_id`, so hosted validation resolves to the packaged `data.local` fixture adapter and does not require a system SQLite binary. The `data.sqlite` adapter is also packaged for durable local-source compatibility when callers omit `store_id`.

## Validation

- `runx --version`: `runx-cli 0.6.14`
- `git diff --check -- skills/list-hygiene-judge`: passed
- hidden/bidi/control-character scan: passed
- `runx harness ./skills/list-hygiene-judge`: passed on Docker Desktop Linux in hosted-like mode with packaged tools
- `runx registry publish ./skills/list-hygiene-judge/SKILL.md --registry https://api.runx.ai`: passed
- `runx registry read rohitmulani63-ops/list-hygiene-judge --registry https://api.runx.ai`: passed

Harness summary:

```json
{
  "status": "passed",
  "case_count": 4,
  "assertion_error_count": 0,
  "case_names": [
    "sealed_decay_re_permission",
    "sealed_hard_bounce_suppress",
    "stop_missing_or_stale_evidence",
    "needs_agent_missing_decision_answer"
  ],
  "receipt_ids": [
    "sha256:35eda8eb771914707c43fc325c472f644f943e734d6116f85b48e6a744eadd95",
    "sha256:39fc0157fa71a78216f2b975b1fd16d25bc8eaa3c697e1885686838bcad9044a",
    "sha256:dcf27a3693944d57288ceae4781279580d9b8ff91ffe005b41e050e6b001b51e"
  ]
}
```

Hosted registry:

```text
public_url=https://runx.ai/x/rohitmulani63-ops/list-hygiene-judge@sha-a3364df6aaa1
skill=rohitmulani63-ops/list-hygiene-judge
version=sha-a3364df6aaa1
digest=sha256:24fde586aaff95059c250c77a37aeaf41d0277902a99353d37a76ac8137c691b
run_command=runx skill rohitmulani63-ops/list-hygiene-judge@sha-a3364df6aaa1 --registry https://api.runx.ai
receipt_ref=runx:receipt:sha256:35eda8eb771914707c43fc325c472f644f943e734d6116f85b48e6a744eadd95
```

## Environment note

Native Windows receipt storage previously failed with `os error 87`, so final harness and hosted publish were run from Docker Desktop Linux. The Linux harness passes and includes the hosted registry stop-case requirement.
## Structured evidence for Frantic preflight

The evidence_json file now includes a substantive summary, eight structured observations, and a dogfood block. The dogfood receipt is runx:receipt:sha256:35eda8eb771914707c43fc325c472f644f943e734d6116f85b48e6a744eadd95 from the sealed_decay_re_permission harness case. It proves the graph can read the packaged list-hygiene fixture, decide a stale-contact re-permission transition, and append exactly one safe list_hygiene.transitioned event while keeping stop paths for stale or missing evidence.

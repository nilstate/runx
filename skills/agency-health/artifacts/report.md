# agency-health report (Frantic #106)

`agency-health` is a read-only runx skill that assembles a health bundle for one running
agency over a period. It folds that agency's case projection in version order, grades the
folded signals against declared norms, and seals a `health_verdict` plus typed
`intervention_findings`. It appends nothing, sends nothing, executes nothing, and consumes
no effect: its runner declares `allowed_tools: []` and read-only scopes only.

Every value in this report is copied from a captured artifact in this directory
(`registry-publish.json`, `registry-read.json`, `registry-install.json`,
`dogfood-receipt.json`, `dogfood-verify.json`, `runx-version.txt`, `evidence.json`,
`verification.json`). The upstream PR is runxhq/runx#289; raw URLs for
files present at the source commit are pinned to `e83ffee89933a48833dfb23f804d3052c6ee8d95`, and the
evidence artifacts added later are referenced on PR branch `feat/agency-health-fabler`.

## Published package

- CLI: `runx-cli 0.7.0` (`runx --version`), above the required `0.6.14` minimum. The same
  binary (`/usr/bin/runx`) ran the local harness, publish, registry read, clean install,
  post-publish dogfood, and verify.
- Publisher: `fablerlabs` (Fabler Labs, user, community trust tier).
- Package name: `agency-health`. Source version `0.1.0`; published version
  `sha-d4d7ffe272cb`.
- Registry ref: `fablerlabs/agency-health@sha-d4d7ffe272cb`.
- `public_url`: https://runx.ai/x/fablerlabs/agency-health@sha-d4d7ffe272cb
- `source_url`: https://github.com/fablerlabs/runx/tree/e83ffee89933a48833dfb23f804d3052c6ee8d95/skills/agency-health
- `pr_url`: https://github.com/runxhq/runx/pull/289
- Raw `x_yaml`: https://raw.githubusercontent.com/fablerlabs/runx/e83ffee89933a48833dfb23f804d3052c6ee8d95/skills/agency-health/X.yaml
- Raw `skill_md`: https://raw.githubusercontent.com/fablerlabs/runx/e83ffee89933a48833dfb23f804d3052c6ee8d95/skills/agency-health/SKILL.md
- `verification_json`: https://raw.githubusercontent.com/fablerlabs/runx/feat/agency-health-fabler/skills/agency-health/artifacts/verification.json
- Registry digest: `sha256:c7340bf9a06b465fbd5019b3a1e1ce7fe92ab8addfe6a5fb9aada69280d300c6`.
- Profile digest: `sha256:68795be1483ae362b1e47011469d04a131cda51c8b49dcec13b4c7ee02b85049`.
- Runner: `assess`.
- Publish method: `runx login --provider github --for publish`, then
  `runx registry publish ./skills/agency-health/SKILL.md --registry https://api.runx.ai --json`.
- Install command: `runx add fablerlabs/agency-health@sha-d4d7ffe272cb --registry https://api.runx.ai`.
- The publishing account `fablerlabs` stars `runxhq/runx` (`GET /user/starred/runxhq/runx`
  returned HTTP 204). Frantic re-checks this live through its own verifier; no star
  artifact is offered as a substitute.

## The two reads

The domain-keyed state read is the data-store `read_projection` (C2):
`registry:runx/data-store@0.1.2`, keyed on `agency_ref` (narrowed by optional `case_id`)
and folded in version order. It is the only read that yields case and turn state.

The cross-run aggregate read is the ledger `read` runner (C7):
`registry:runx/ledger@0.2.0`, referenced by receipt id-stub only, and used for audit-only
aggregates such as seal rate and refusal spikes.

The ledger can never stand in for the domain-keyed read, and this is source proof rather
than inference: upstream `skills/ledger/SKILL.md:41` says of the ledger's runners, *"Both
runners project to id-stubs only."* An id-stub is a receipt handle, not a domain-keyed
projection of a case. The ledger can corroborate that a run happened; it cannot say what
turn a case is on. Substituting it would mean inventing the very turn state this skill
refuses to invent.

## Verification

- Local harness (pre-publish and re-run): **passed, 3 cases, 0 assertion errors.**
- Hosted registry harness after publish: **passed.**
- `runx registry read fablerlabs/agency-health@sha-d4d7ffe272cb --registry https://api.runx.ai --json`
  resolves the published metadata and digests: **passed.**
- Clean `runx add` into an empty directory: **installed.**

Harness cases, with the status each seals or refuses at:

| case | status | result |
|---|---|---|
| `concerning-agency-sealed` | sealed | passed |
| `no-case-events-stop` | sealed | passed |
| `cap-widening-escalates-human-ops` | needs_agent | passed |

The two contract-named cases both seal. `no-case-events-stop` is a deterministic conflict
that *still seals*: with no readable case events over the period it returns
`decision: needs_more_evidence` and `health_verdict.status: unknown`, grades zero findings,
emits zero interventions, and closes the receipt on the refusal rather than erroring.

The third case is not filler — it is forced by the registry publish gate. The first publish
was rejected with `[skill_harness_incomplete]: Publish harness must include a stop/error
case such as needs_agent, policy_denied, failure, or escalated`. The reason is preserved
in the public `X.yaml`; the current `registry-publish.json` records the subsequent green
publish. Because both contract-named cases seal, a
publishable harness needs a third case, and publishing is itself an acceptance criterion.
`cap-widening-escalates-human-ops` exercises the escalation seam the contract already
defines: a 97-percent-cap agency whose only remedy *widens* a cap may never route as a
routine tighten, so the run blocks to the human ops lane.

## What the sealed case decided

For `agency:acme-support` over a `30d` period, against baseline
`{threshold_days_stuck: 3, cap_pressure_pct: 80, refusal_spike_rate: 0.15}`, the skill
returned `decision: ready` with `health_verdict.status: degraded`. It folded three cases
(`case:acme-support:1042` turns 1–4, `case:acme-support:1055` turns 1–2,
`case:acme-support:1061` turns 1–3) in version order and referenced ledger id-stubs
`sha256:9f21c7a4`, `sha256:2ab30de1`, and `sha256:77c9be05`.

The four graded findings:

| metric | value | assessment | norm |
|---|---|---|---|
| `seal_rate` | 0.71 | warning | ledger aggregate reports 24 of 34 cross-run receipts sealed; refusal rate 0.29 exceeds the 0.15 norm |
| `stuck_case_count` | 2 | warning | `1042` stalled at turn 4 for 9 days, `1061` at turn 3 for 5 days; both past the 3-day threshold |
| `cap_usage_pct` | 93 | critical | folded spend is at 93 percent of the charter cap, above the 80 percent norm |
| `escalation_backlog` | 3 | warning | 3 unclaimed versus charter maximum 0 and same-period pickup SLA; oldest is 9 days |

Three intervention findings were emitted, each naming its target lane and citing its
grounding `case_id`, turn, and ledger id-stub:

- **improve-skill** — stuck turns concentrated behind repeated refusals are a
  skill-behavior defect (grounded in `case:acme-support:1042` turn 4).
- **human_ops** — cap usage at 93 percent is graded critical and the plausible remedy
  *widens* a cap, so it escalates rather than routing as a routine tighten (grounded in
  `case:acme-support:1055` turn 2).
- **policy-author** — an escalation backlog is a routing-policy defect, and re-routing
  widens no cap or authority (grounded in `case:acme-support:1061` turn 3).

The handoff seam is dispatch-by-naming. This lane moves no money and grants no access, so
every intervention finding carries `ceiling: null` and `effect_bound: null` and is not a
proposal any rail can consume — it is a named finding pointed at a named lane, consumed
only when a downstream driver or operator issues a separate `policy-author` or
`improve-skill` run. The sealed run emitted 0 ceilings, 0 effect bounds, and issued 0 rail
runs.

Refusals: it refuses to grade a signal not grounded in the folded case projection or a
ledger id-stub aggregate; refuses to invent a cap or threshold it cannot read from the
agency charter snapshot or the supplied `health_baseline`; and never invents a turn state
the sealed event order does not show.

## Post-publish dogfood

The exact hosted registry package — not the local source tree and not the harness fixture
seal — was installed into an empty directory and run:

```
runx add fablerlabs/agency-health@sha-d4d7ffe272cb --registry https://api.runx.ai
runx skill fablerlabs/agency-health@sha-d4d7ffe272cb assess --registry https://api.runx.ai --json \
  --input data_source_ref=registry:runx/data-store@0.1.2 --input store_id=agency-ops-store \
  --input agency_ref=agency:acme-support --input period=30d \
  --input-json health_baseline='{"threshold_days_stuck":3,"cap_pressure_pct":80,"refusal_spike_rate":0.15}'
runx resume run_agent_task-agency-health-output fixtures/concerning-agency-sealed-answers.json --json
RUNX_RECEIPT_VERIFY_KID=fablerlabs-agency-health-dogfood \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=yBWvyjan3GW8pqIPTdumfRXzapsb1DVTRw0q/mn0aFY= \
  runx verify --receipt <receipt.json> --json
```

The clean-install run ledger records `resume_skill_ref` pointing into the
registry-resolved cache at `fablerlabs/agency-health/sha-d4d7ffe272cb`, with
`selected_runner: assess` — direct proof the registry package at this version is what ran.
The public PR includes `dogfood-run-ledger.jsonl`, the final receipt, and its independent
verification verdict, so this provenance does not rely on an unpublished local ledger or
on the receipt's harness-shaped subject alone. The run started at
`2026-07-13T03:09:01.675Z` and sealed at `2026-07-13T03:09:08.430Z`
(`disposition: closed`, `reason_code: agent_act_closed`).

`receipt_ref`: `runx:receipt:sha256:df734657784614da190b2427c21a30c65eebf12c7cb1759f803166b90c60b534`

`runx verify` returned **`valid: true`** with zero findings: digest `valid`, content address
`valid`, and Ed25519 signature `valid` in `production` mode under kid
`fablerlabs-agency-health-dogfood`. The receipt honestly identifies its issuer as `ci`, not
as the hosted notary. The public verification key is
`yBWvyjan3GW8pqIPTdumfRXzapsb1DVTRw0q/mn0aFY=`; the private seed is not published.
Lineage is `unverified` because a single receipt cannot prove a receipt tree. The raw
verdict is `artifacts/dogfood-verify.json`.

The separate hosted receipt-notary endpoint does not authorize the purpose-scoped publish
credential (it returns `Unauthorized`), so **no hosted notarization is claimed.** The signed
production-signed CI receipt, its public verification key, and its verdict are published at
`artifacts/dogfood-receipt.json` and `artifacts/dogfood-verify.json` so any reviewer can
re-verify them independently.

## How a new user installs, runs, and verifies without private context

```
runx add fablerlabs/agency-health@sha-d4d7ffe272cb --registry https://api.runx.ai
runx skill fablerlabs/agency-health@sha-d4d7ffe272cb assess --registry https://api.runx.ai --json
RUNX_RECEIPT_VERIFY_KID=fablerlabs-agency-health-dogfood \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=yBWvyjan3GW8pqIPTdumfRXzapsb1DVTRw0q/mn0aFY= \
  runx verify --receipt <receipt.json> --json
```

Supply the typed inputs `data_source_ref`, `store_id`, `agency_ref` and the optional
`period`, `case_id`, `health_baseline`; answer the agent-task boundary with the public
fixture `fixtures/concerning-agency-sealed-answers.json` to reproduce the sealed case.

**No private context is required.** Every input, answer fixture, receipt, and verdict needed
to reproduce this run is public in this PR. No private token, no private store, and no
operator-only link is needed to install, run, or verify the published receipt. Producing a
new production signature requires a new private seed; that seed is not part of this packet.

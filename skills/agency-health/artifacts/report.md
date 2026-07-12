# agency-health report (Frantic #106)

`agency-health` is a read-only runx skill that assembles a health bundle for one running
agency over a period. It folds that agency's case projection in version order, grades the
folded signals against declared norms, and seals a `health_verdict` plus typed
`intervention_findings`. It appends nothing, sends nothing, executes nothing, and consumes
no effect: its runner declares `allowed_tools: []` and read-only scopes only.

Every value in this report is copied from a captured artifact in this directory
(`registry-publish.json`, `registry-read.json`, `registry-install.json`,
`dogfood-receipt.json`, `dogfood-verify.json`, `runx-version.txt`, `evidence.json`,
`verification.json`). The upstream PR is runxhq/runx#288; raw URLs for
files present at the source commit are pinned to `62db2f95c7bb0f8a705bb7a440cca4d058acca74`, and the
three artifacts added by the evidence commit are referenced on PR branch `codex/agency-health-106`.

## Published package

- CLI: `runx-cli 0.7.0` (`runx --version`), above the required `0.6.14` minimum. The same
  binary (`/usr/bin/runx`) ran the local harness, publish, registry read, clean install,
  post-publish dogfood, and verify.
- Publisher: `fablerlabs` (Fabler Labs, user, community trust tier).
- Package name: `agency-health`. Source version `0.1.0`; published version
  `sha-599c8cab4e9c`.
- Registry ref: `fablerlabs/agency-health@sha-599c8cab4e9c`.
- `public_url`: https://runx.ai/x/fablerlabs/agency-health@sha-599c8cab4e9c
- `source_url`: https://github.com/fablerlabs/runx/tree/62db2f95c7bb0f8a705bb7a440cca4d058acca74/skills/agency-health
- `pr_url`: https://github.com/runxhq/runx/pull/288
- Raw `x_yaml`: https://raw.githubusercontent.com/fablerlabs/runx/62db2f95c7bb0f8a705bb7a440cca4d058acca74/skills/agency-health/X.yaml
- Raw `skill_md`: https://raw.githubusercontent.com/fablerlabs/runx/62db2f95c7bb0f8a705bb7a440cca4d058acca74/skills/agency-health/SKILL.md
- `verification_json`: https://raw.githubusercontent.com/fablerlabs/runx/codex/agency-health-106/skills/agency-health/artifacts/verification.json
- Registry digest: `sha256:2e3febbc8723a4b60729caeea738f6805aac7fbf5414324da7e823fe6940fa8f`.
- Profile digest: `sha256:869b9279ed764dff0b187b48c0f3be3310fc0db584a5cd32b800e776501f86ef`.
- Runner: `assess`.
- Publish method: `runx login --provider github --for publish`, then
  `runx registry publish ./skills/agency-health/SKILL.md --registry https://api.runx.ai --json`.
- Install command: `runx add fablerlabs/agency-health@sha-599c8cab4e9c --registry https://api.runx.ai`.
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
- `runx registry read fablerlabs/agency-health@sha-599c8cab4e9c --registry https://api.runx.ai --json`
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
case such as needs_agent, policy_denied, failure, or escalated`, and the rejection is
recorded verbatim in `registry-publish.json`. Because both contract-named cases seal, a
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
| `seal_rate` | 0.71 | warning | 24 of 34 folded turns sealed; implied refusal rate 0.29 exceeds the 0.15 norm |
| `stuck_case_count` | 2 | warning | `1042` stalled at turn 4 for 9 days, `1061` at turn 3 for 5 days; both past the 3-day threshold |
| `cap_usage_pct` | 93 | critical | folded spend is at 93 percent of the charter cap, above the 80 percent norm |
| `escalation_backlog` | 3 | warning | 3 escalations unclaimed at period close, the oldest 9 days old |

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
runx add fablerlabs/agency-health@sha-599c8cab4e9c --registry https://api.runx.ai
runx skill fablerlabs/agency-health@sha-599c8cab4e9c assess --registry https://api.runx.ai --json \
  --input data_source_ref=registry:runx/data-store@0.1.2 --input store_id=agency-ops-store \
  --input agency_ref=agency:acme-support --input period=30d \
  --input-json health_baseline='{"threshold_days_stuck":3,"cap_pressure_pct":80,"refusal_spike_rate":0.15}'
runx resume <run-id> fixtures/concerning-agency-sealed-answers.json --json
runx verify --receipt <receipt.json> --allow-local-development-signatures --json
```

The clean-install run ledger records `resume_skill_ref` pointing into the
registry-resolved cache at `fablerlabs/agency-health/sha-599c8cab4e9c`, with
`selected_runner: assess` — direct proof the registry package at this version is what ran.
The run started at `2026-07-12T17:50:30.480Z` and sealed at `2026-07-12T17:51:24.272Z`
(`disposition: closed`, `reason_code: agent_act_closed`). The run id is per-run and is not
carried inside the content-addressed receipt, so it is shown as `<run-id>`; a reviewer
re-running gets their own. The sealed receipt id is the stable, checkable artifact.

`receipt_ref`: `runx:receipt:sha256:96815c62d05f7e7237e3428aeeb4441c0da421fdcb3e4017f65b7baa4db0ba50`

`runx verify` returned **`valid: true`** with zero findings: digest `valid`, content address
`valid`, signature `valid` in `local-development` mode (kid `runtime-skeleton`), lineage
`unverified` because a single receipt cannot prove a receipt tree. The raw verdict is
`artifacts/dogfood-verify.json`.

The separate hosted receipt-notary endpoint does not authorize the purpose-scoped publish
credential (it returns `Unauthorized`), so **no hosted notarization is claimed.** The signed
receipt and its verification verdict are published in this PR at
`artifacts/dogfood-receipt.json` and `artifacts/dogfood-verify.json` so any reviewer can
re-verify them independently.

## How a new user installs, runs, and verifies without private context

```
runx add fablerlabs/agency-health@sha-599c8cab4e9c --registry https://api.runx.ai
runx skill fablerlabs/agency-health@sha-599c8cab4e9c assess --registry https://api.runx.ai --json
runx verify --receipt <receipt.json> --allow-local-development-signatures --json
```

Supply the typed inputs `data_source_ref`, `store_id`, `agency_ref` and the optional
`period`, `case_id`, `health_baseline`; answer the agent-task boundary with the public
fixture `fixtures/concerning-agency-sealed-answers.json` to reproduce the sealed case.

**No private context is required.** Every input, answer fixture, receipt, and verdict needed
to reproduce this run is public in this PR. No private token, no private store, and no
operator-only link is needed to install, run, or verify. No secrets appear in any artifact.

# Delivery Runbook — purchase-approval (Frantic #109)

## Status: OFFLINE CANDIDATE. **NOT delivery-ready.**

Every *local* acceptance line is satisfied and re-runnable. Every line that needs an
external action (GitHub star, registry publish, public PR, hosted harness,
post-publish dogfood receipt) is **not done**, and nothing in this package pretends
otherwise: those fields are blank in `artifacts/evidence.json` and
`artifacts/verification.json`.

Do not deliver this bounty until the external gates below are genuinely run and the
blank fields are filled from real command output.

---

## Acceptance matrix (#109, fetched live from `GET /v1/bounties/109`)

| # | Acceptance line | Status | Evidence |
|---|---|---|---|
| 1 | runx CLI ≥ 0.6.14; exact `runx --version` in evidence | ✅ local | `runx-cli 0.7.0`, recorded in both artifacts |
| 2 | Claimant GitHub account stars `runxhq/runx` | ❌ **external** | not done — requires a real star by the verified account |
| 3 | Exact package name `purchase-approval`; publish via `runx login --provider github --for publish` + `runx registry publish` | ❌ **external** | name is exact (`skill: purchase-approval`); **not published** |
| 4 | Public PR to `runxhq/runx` with X.yaml, SKILL.md, fixtures, harness evidence; raw URLs from PR head | ❌ **external** | package files exist in this layout; **no PR opened** |
| 5 | Registry package, PR head, source_url, x_yaml, skill_md, evidence, verification, receipt_ref, report all describe the same version/revision | ⚠️ pending | all local files say `0.1.0`; cannot be confirmed until 2–4 exist |
| 6 | Clean `runx add`; local harness green pre-publish; hosted harness green post-publish; post-publish dogfood receipt passes `runx verify`; recorded in `evidence_json.dogfood` | ⚠️ partial | **local harness passed**; `runx add` / hosted harness / post-publish receipt **not done** |
| 7 | One sealed in-policy case (approved + one bounded ceiling + sealed receipt) **and** one stop case that omits `caller.answers`, blocks to `needs_agent`, emits no ceiling, names the violation/overage | ✅ local | exactly 2 inline cases; see "Test evidence" |
| 8 | Typed inputs `purchase_request`, `procurement_policy`, `current_budget_balance`, requested budget-bounded scope; typed `decision{approved,reason}` + only-when-approved one bounded `runx.attenuation_request.v1` ceiling as data; never a mint, never `runx.operational_proposal.v1`; escalation when a human lane is needed | ✅ local | `runners.review.inputs` (4 typed inputs); packet `runx.purchase.approval.v1` |
| 9 | Handoff seam is the bounded ceiling → C3 mints/reserves/settles/seals; denial leaves nothing to consume; out-of-policy / currency mismatch / unclear authority escalates to a blocking human lane | ✅ local | stop lane emits **0** ceilings anywhere in the run; documented in SKILL.md + instructions |
| 10 | Refuses over-budget spend, refuses unlisted vendors, never invents a vendor, cap, or threshold | ✅ local | stop-lane refusal names the USD 1100 overage + unlisted vendor; `allowed_tools: []` means it *cannot* look one up |
| 11 | Evidence observations include decision + reason, ceiling amount/currency, refused reason with cited violation/overage, the two case names, the receipt id | ✅ local | `artifacts/evidence.json` (`decision_observations`, `refusal_observations`, `harness`) |
| 12 | Evidence + report cover CLI version, owner, name, version, registry ref, public_url, pr_url, source_url, raw x_yaml/skill_md, verification_json, publish method, install command, case names, hosted harness, dogfood command, receipt_ref, verify verdict, and how a new user installs/runs/verifies | ⚠️ partial | all *local* fields filled; all *external* fields deliberately **blank** |

**Verdict: 7 of 12 fully satisfied locally; 5 blocked on external gates (2, 3, 4, 6) or on those gates completing (5, 12).**

---

## Test evidence (re-runnable now, from this directory)

```
$ runx --version
runx-cli 0.7.0

$ runx harness . --json
{"status":"passed","case_count":2,"assertion_error_count":0,
 "case_names":["purchase-approval-in-policy-ceiling",
               "purchase-approval-stop-over-budget-needs-agent"],
 "receipt_ids":["sha256:447122c9564366c7ba7e9fdb6db9772b01615d2ac4ab1e1d91d4399f64ea2a64"]}
```

Receipt ids are **per-run**, not content-stable: re-running the harness produces a
different id. The reproducible assertions are `status: passed`, `case_count: 2`,
`assertion_error_count: 0`, and the two case names — not the id above.

Start/resume dogfood, in-policy lane (`fixtures/in-policy-input.json`):

```
start  -> {"status":"needs_agent","run_id":"run_review_f48e576897f9"}
resume -> {"status":"sealed",
           "receipt_id":"sha256:d78d0c325e71d3795e2141b10b710e2b05a2889088d0d2c67d516ca84416a9ff"}
           decision: approved=true, mode=approve_in_full
           ceilings: exactly 1 — runx.attenuation_request.v1, form=data,
                     75 USD, counterparty "Acme Corp",
                     scopes [spend.reserve, spend.settle, receipt.seal]
verify -> valid=true, digest=valid, content_address=valid,
          signature=valid (mode=local-development, kid=runtime-skeleton),
          lineage=unverified, findings=[]
```

Stop lane (`fixtures/over-budget-input.json`, USD 1500 vs USD 400 balance, vendor
`Shady Parts Co` not in `approved_vendors`):

```
start (answers omitted) -> {"status":"needs_agent","run_id":"run_review_3f23ca0e0a8b"}
resume (refusal answer) -> {"status":"sealed", receipt sha256:0920684d…}
           decision: approved=false, mode=deny
           ceilings: 0 — and 0 runx.attenuation_request.v1 objects anywhere in the run
           reason names: USD 1100 budget overage, cap breach, unlisted vendor
```

Reproduce the start command with:

```bash
F=fixtures/in-policy-input.json
runx skill . review --json \
  --input-json purchase_request="$(jq -c .purchase_request $F)" \
  --input-json procurement_policy="$(jq -c .procurement_policy $F)" \
  --input-json current_budget_balance="$(jq -c .current_budget_balance $F)" \
  --input-json requested_scope="$(jq -c .requested_scope $F)"
# prints a needs_operator_approval digest; re-run with
#   --approve-operator-context <digest>
# then: runx resume <run-id> fixtures/in-policy-answers.json --json
```

### Local verify caveat (do not paper over)

`runx verify` on a local receipt **fails** without trusted keys and needs
`--allow-local-development-signatures`; the resulting verdict carries
`signature_mode: local-development` and `lineage: unverified`. That is fine for the
local gate (the reference package does the same), but the `receipt_ref` submitted to
#109 must be the **post-publish** dogfood receipt of
`<owner>/purchase-approval@<version>`, whose signature is real — **not** the local
receipt above and **not** the harness fixture seal.

---

## Remaining external gates (in order)

1. **Star** `https://github.com/runxhq/runx` from the verified claimant GitHub account.
   Frantic checks this via the `github.repo_starred_by` verifier; screenshots do not count.
2. **Publish**: `runx login --provider github --for publish`, then
   `runx registry publish ./skills/purchase-approval/SKILL.md --registry https://api.runx.ai`.
   Record the real `<owner>` and `<version>`; confirm with
   `runx registry read <owner>/purchase-approval@<version> --json`.
3. **PR**: open a public PR against `runxhq/runx` containing
   `skills/purchase-approval/{X.yaml,SKILL.md}`, `fixtures/`, and `artifacts/`.
   Capture raw URLs from the PR head commit for `x_yaml` and `skill_md`.
4. **Clean install + hosted harness**: `runx add <owner>/purchase-approval@<version>`;
   confirm the hosted registry harness is green.
5. **Post-publish dogfood**: `runx skill <owner>/purchase-approval@<version> --json`
   with the `fixtures/in-policy-input.json` inputs, resume with
   `fixtures/in-policy-answers.json`, then
   `runx verify --receipt <receipt.json> --json`. Record `{package, input, command,
   receipt_ref, verify_verdict, harness_cases}` into `evidence_json.dogfood`.
6. **Fill the blanks** in `artifacts/evidence.json`, `artifacts/verification.json`, and
   `artifacts/report.md` from real output, then host `evidence_json`,
   `verification_json`, and `report` at public URLs.
7. **Preflight** `POST https://gofrantic.com/v1/deliveries/preflight` with bounty 109
   and the artifact refs, and only then claim. Note the claim window is **~60 minutes
   measured**, not the 3 hours the board advertises — claim only when every artifact
   above already exists.

## Package layout

```
skills/purchase-approval/
  SKILL.md                       skill contract (graph; no cli-tool source)
  X.yaml                         catalog.kind: graph, emits, 2 harness cases, graph runner
  fixtures/
    in-policy-input.json         start inputs, in-policy lane
    in-policy-answers.json       resume answer: approve + one bounded ceiling
    over-budget-input.json       start inputs, stop lane
    over-budget-answers.json     resume answer: refusal, zero ceilings, names the overage
  artifacts/
    evidence.json                evidence_json (local filled, external blank)
    verification.json            verification_json (local checks, external blank)
    report.md                    report
```

## Design notes (why the draft was rebuilt)

- The prior draft was `source.type: cli-tool` running `run.mjs`. A CLI process
  **cannot** express an `agent-task` review boundary and **cannot** block to
  `needs_agent`, which acceptance line 7 requires explicitly. The cli-tool shortcut
  and `run.mjs` were removed; the package is now `catalog.kind: graph` with a single
  `agent-task` step (`review-purchase`), matching the structure proven by public PR
  `runxhq/runx#279` (`dh0h/runx@0f4cdcc`, revenue-leakage-auditor).
- The draft's 7 harness cases expected `process_failed` for every stop. Acceptance
  wants a stop that **blocks** (`needs_agent`), not one that fails. There are now
  exactly the two cases the bounty names.
- The draft had no `requested_scope` input, so the "requested budget-bounded scope"
  was missing and no ceiling could be clamped.
- `allowed_tools: []` is deliberate: with no filesystem or network access the skill
  *cannot* invent a vendor, cap, threshold, or balance (acceptance line 10). It also
  keeps the graph runnable with no local tool prerequisites.
- `current_budget_balance` is typed `{amount, currency}` rather than a bare number so
  that a currency mismatch is detectable and escalates, instead of being assumed.

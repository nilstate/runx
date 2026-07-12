# purchase-approval — report (Frantic #109)

`purchase-approval` is a runx **graph** skill that makes the approval call on one
purchase request *before* any money moves, and emits the bounded spend ceiling a
downstream runner is allowed to consume. The dangerous part of a purchase is the
approval, not the payment.

External refs below are blank because the corresponding external action has not
been performed. They must be filled by running the command that produces them.

- **runx CLI version** — `runx --version` → `runx-cli 0.7.0` (minimum required 0.6.14).
- **Publisher owner** — _(blank: not published)_
- **Package name / version** — `purchase-approval` / `0.1.0`, `catalog.kind: graph`.
- **Registry ref / public_url** — _(blank: not published)_
- **pr_url / source_url / raw x_yaml / raw skill_md** — _(blank: no PR opened)_
- **verification_json** — `artifacts/verification.json` (local checks only, external gates blank).
- **Publish method** — `runx login --provider github --for publish`, then
  `runx registry publish ./skills/purchase-approval/SKILL.md --registry https://api.runx.ai`.
- **Install command** — `runx add <owner>/purchase-approval@<version>` _(blank owner/version until published)_.
- **Harness case names** — `purchase-approval-in-policy-ceiling` (sealed) and
  `purchase-approval-stop-over-budget-needs-agent` (needs_agent, refused).
- **Local harness status** — `runx harness . --json` → `passed`, 2 cases, 0 assertion errors,
  sealed receipt `sha256:447122c9…`. This is the fixture seal, not the dogfood receipt.
- **Hosted harness status** — _(blank: not published)_
- **Dogfood command / receipt_ref / verify verdict** — _(blank: the required dogfood is the
  **post-publish** run of `<owner>/purchase-approval@<version>`, which has not happened.
  A local start/resume dogfood did run: it blocked at `needs_agent`, sealed on resume to receipt
  `sha256:d78d0c32…`, and `runx verify … --allow-local-development-signatures --json` returned
  `valid: true` with `signature_mode: local-development` and `lineage: unverified`.)_

## What it decides

Typed inputs are `purchase_request{amount,currency,vendor,purpose}`,
`procurement_policy{approved_vendors,max_single_purchase,requires_approval_above}`,
`current_budget_balance{amount,currency}`, and `requested_scope` — the requested
budget-bounded scope. Typed output is `decision{approved,mode,reason}` plus, **only
when approved**, exactly one bounded `runx.attenuation_request.v1`
ceiling `{amount,currency,counterparty,scopes}` carried as **data** — never a mint,
never a `runx.operational_proposal.v1`, and never an attenuated subset.

The judgment refuses to approve spend exceeding remaining budget authority, refuses
vendors outside the approved list, and never invents an approved vendor, a
single-purchase cap, or an approval threshold absent from `procurement_policy`. The
graph gives it no tools at all (`allowed_tools: []`), so it has no filesystem,
network, or ledger access with which to discover a policy that was not supplied.

## The handoff seam

The bounded ceiling **is** the seam. A downstream driver hands the emitted
`AttenuationRequest` to the core spend/refund accepting runner (C3), which alone
mints, reserves, settles, and seals the attenuated subset — capped at that ceiling.
Because a denial or a blocked approval emits **no ceiling**, C3 has nothing to
consume and **the spend cannot fire**. Out-of-policy spend, a currency mismatch, or
unclear budget authority routes to a human approval lane that **blocks rather than
guesses**: with `caller.answers` omitted the run stops at `needs_agent`.

## Why an operator would install it

It puts a typed, receipt-sealed review boundary in front of spend. The approval and
its reason are sealed into a `runx.receipt.v1`, the emitted ceiling is bounded and
clamped inside the requested scope, and every refusal names the exact policy
violation or budget overage — so an auditor can reconstruct why money was or was not
allowed to move, and an over-budget or unlisted-vendor request cannot silently become
a payment.

## How a new user installs, runs, and verifies

_(Exact commands blank until published; shapes are in `DELIVERY.md`.)_ The flow is
`runx add <owner>/purchase-approval@<version>` → `runx skill
<owner>/purchase-approval@<version> --json` with the four typed inputs (fixtures in
`fixtures/`) → the run blocks at `needs_agent` → `runx resume <run-id>
fixtures/in-policy-answers.json --json` seals it → `runx verify --receipt
<receipt.json> --json` checks the seal. No private context is required.

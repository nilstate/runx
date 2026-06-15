---
name: lead-router
description: Qualify a lead and route it to the right governed action, direct outreach, a nurture campaign, or a recorded hold, sealing which path was taken and why.
runx:
  category: growth
---

# Lead Router

Not every lead gets the same treatment, and pretending otherwise is how teams
burn their list. `lead-router` qualifies a lead once and then takes exactly
one path: reach out now, drop it into nurture, or hold and leave it alone. The
choice is governed and sealed, so a month later you can see why this lead got a
personal email and that one did not.

This is the first skill built on the graph's `when` primitive. A single
`qualify` step decides a route, and three branches each declare the route they
serve. The runtime runs the branch that matches and skips the rest; the receipt
records the route, the rationale, and the one path that executed. There is no
hidden routing inside an agent, the branch is a visible, auditable part of the
graph.

## What this skill does

`lead-router` is a graph that composes existing skills behind one routing
decision:

1. `qualify` reads the lead and engagement signals and emits a `route`:
   `reach_out`, `nurture`, or `hold`, with a rationale.
2. `when route == reach_out`, the `send-as` skill plans a direct, approval-gated
   outreach message.
3. `when route == nurture`, the `nitrosend` skill enrolls the lead in a governed
   nurture campaign.
4. `when route == hold`, a hold is recorded with the reason, and nothing is sent.

Exactly one branch runs. The unselected branches are skipped, not blocked, and
the run seals normally on whichever path executed. Authority narrows per branch:
the outreach and nurture branches carry their own send scopes and approval gates,
the hold branch sends nothing at all.

## When to use this skill

- An inbound or sourced lead needs a consistent, governed qualify-then-act
  decision rather than an ad-hoc judgment call.
- You want the routing decision (and the reason) on the receipt, not buried in a
  prompt.
- Outreach, nurture, and do-not-contact are all real outcomes the workflow must
  choose between.

## When not to use this skill

- To send the same message to everyone. That is a campaign; call `nitrosend`
  directly.
- To draft copy only. Use a drafting skill; this skill decides and routes.
- To contact a lead with no consent basis or against a suppression list. The
  `hold` route exists for exactly that case.

## How the branch is wired

- `qualify` produces `route` (the scalar the branches test) plus `rationale` and
  `segment`.
- each branch declares `when: { field: qualify.route, equals: <route> }`; a
  branch whose route does not match is skipped and the graph continues.
- the run seals after the matching branch; the receipt shows `qualify`'s route
  and the single branch that ran, so the path is provable after the fact.

## Edge cases and stop conditions

- **No `lead`:** the run returns `needs_agent`; there is nothing to qualify.
- **`route: hold`:** outreach and nurture are skipped; the hold branch records
  the reason and the run seals with nothing sent.
- **An ambiguous qualification:** `qualify` should route to `hold` rather than
  guess; a hold is a clean, recorded outcome, not a failure.
- **Send blocked downstream:** the chosen branch carries its own approval gate;
  if approval is withheld, that branch stops at its gate, and the receipt shows
  the route was chosen but the send was not authorized.

## Output

The run seals to `runx.receipt.v1`. The receipt links `qualify` (the route and
rationale) and the single branch that executed (`send_plan`, `campaign_plan`, or
`hold_record`). The branches that did not match are recorded as skipped, so the
receipt proves both the decision and the one action taken.

## Inputs

- `lead` (required): lead, account, and engagement signals to qualify.
- `principal` (required): principal the outreach or nurture is sent as.
- `objective` (optional): what the outreach should accomplish.
- `operator_context` (optional): compliance, consent posture, or campaign
  constraints.

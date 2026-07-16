# business-ops

- Group: Operate
- Source: [skills/business-ops/SKILL.md](https://github.com/runxhq/runx/blob/5afc25a83edf1c1320df7ac0d78c36f1523b5677/skills/business-ops/SKILL.md)
- Commit: `5afc25a83edf1c1320df7ac0d78c36f1523b5677`
- Path: `skills/business-ops/SKILL.md`

# Business Ops

Turn one business signal into a replayable operations graph.

`business-ops` is the generic public example for how runx makes agentic
business work composable without giving the agent ambient authority. It is a
deterministic graph skeleton: it classifies one signal, fans it into bounded
lanes, records why each lane exists, names the real skill or provider lane that
would replace the fixture, and stops before any live send, spend, publish,
merge, deploy, or customer-visible action.

This is not a provider integration and not an operator dashboard. It is the
small core shape that teams copy when they want one objective to fan out into a
chain of skills, then replay that chain with receipts.

When the route itself should become durable, use `route_and_append`. That runner
classifies the signal, appends the classification packet through `data-store`,
and reads back the projection. The same graph can use local JSON, SQLite,
Postgres, D1, Redis, or a product adapter by changing the `data_source_ref`
binding.

## What this skill does

- Classifies one business signal before doing work.
- Fans the signal through representative lanes: docs, release, issue/PR,
  outreach planning, spend quoting, and proof audit.
- Produces structured lane packets with authority, gate, handoff, evidence, and
  readback fields.
- Demonstrates the runx split between proposal work and consequential action:
  drafts and plans can be produced, but sends, spend, merges, publishes, and
  deploys require a separate approval and execution lane.
- Gives downstream agents a clear handoff target instead of vague prose.
- Optionally persists the classified route for replay through `data-store`.

## What this skill deliberately does not do

- It does not call private providers, mutate a repo, post to GitHub, send email,
  schedule campaigns, move money, publish releases, or deploy services.
- It does not duplicate `ops-desk`, product operator skills, `send-as`,
  vendor-specific provider skills, `release`, `issue-to-pr`, `spend`, or
  receipt-audit skills.
- It does not turn "outbound marketing" into a hidden side effect. Outreach is
  a plan lane here; real delivery routes to `send-as` and then a provider
  adapter. Branded provider skills are concrete adapters, not branches in this
  core graph.
- It does not treat the graph receipt as proof that an external provider action
  happened. Provider actions need provider evidence and their own receipt.

## When to use this skill

- To show how runx chains skills into replayable business operations.
- To prototype a team-specific ops graph before wiring private provider tools.
- To route a product signal without giving the agent blanket repo, email,
  wallet, or deployment access.
- To explain why a governed workflow is more useful than a one-shot prompt:
  the route, stops, handoffs, and readbacks are explicit and replayable.
- To smoke-test graph execution and child receipts with no external account.

## When not to use this skill

- To run a production launch, incident, release, campaign, support reply,
  payout, or spend flow as-is. Replace fixture lanes with real skills first.
- To approve a live send, spend, merge, publish, deploy, or customer-visible
  action.
- To hide project policy, customer lists, credentials, wallet keys, provider
  dumps, or private review context in the signal.
- To claim external work completed when only this fixture graph ran.

## Mental model

```text
signal -> classify -> fanout lanes -> approval stops -> governed handoffs -> proof
```

The useful part is the chain. A single objective becomes several typed packets:
some read-only, some draft-only, some blocked until approval, and one proof lane
that states how success should be verified later. A human, agent, dashboard, or
CI loop can replay the same route and see the same stops.

## How this maps to real runx work

- **Docs and public proof** route to a docs skill such as `sourcey` or a
  product-owned documentation lane.
- **Release preparation** routes to `release`, with publish held behind a
  release approval.
- **Code work** routes to `issue-to-pr` or a project-owned implementation lane,
  with merge held behind review.
- **Outreach and customer communication** route first to `send-as`, then to a
  provider adapter that implements the send lane. Branded provider skills are
  the right place for vendor-specific compose, test, review, schedule, or send
  details. Broad outbound marketing should be its own skill or product broadcast
  skill, not extra logic hidden in this graph.
- **Spend and payments** route to quote or payout skills with caps, recipient,
  rail, and settlement proof separated from the planning lane.
- **Proof** routes to receipt/history/audit skills and provider readbacks.

The fixture `ops-lane` step simply returns these packets without performing the
handoff. In a real project, replace each fixture lane with the named governed
skill runner or provider tool.

## Procedure

1. Receive one concise `signal`.
2. Optionally receive `operator_context` with project constraints, policy, or
   the concrete business situation.
3. Run `classify` first. It decides which lanes are relevant and what authority
   class each lane belongs to.
4. Fan out docs, release, issue, outreach, spend, and proof packets.
5. Mark each lane as read-only, draft-only, approval-required, or proof-only.
6. Name the exact downstream handoff that should replace the fixture in a real
   workflow.
7. Seal the graph so the route itself is replayable.
8. If using `route_and_append`, append the classification packet with an
   idempotency key and expected version, then read back the projection.

## Edge cases and stop conditions

- **Missing signal:** return `needs_input`. There is no safe route.
- **Vague objective:** return a narrow classify packet and ask for the missing
  product, audience, repo, release, amount, or provider context.
- **Live send without principal, audience, consent, digest, and approval:** stop
  at the outreach lane and route to `send-as`.
- **Spend without amount, cap, recipient, rail, and approval:** stop at the
  spend lane and route to a quote or payment skill.
- **Merge, publish, deploy, or destructive mutation without approval:** stop at
  the relevant lane and name the missing gate.
- **Provider success without provider evidence:** do not mark complete. Route to
  proof audit.
- **Secret or private data in the signal:** refuse to echo it into outputs;
  require redacted context or a provider-side readback instead.

## Output schema

The graph output contains child step receipts plus one `lane_packet` per lane:

```yaml
lane_packet:
  schema: runx.business_ops_lane.v1
  lane: string
  signal: string
  status: ready | awaiting_approval | needs_input | refused
  decision: route | prepare | draft | quote | verify | stop
  kind: router | docs | release | work | outreach | spend | proof
  consequence: read_only | draft | live_mutation | public_send | money_movement | proof
  summary: string
  why: string
  authority:
    requested: [string]
    provided: fixture_only
  gate:
    approval_required: boolean
    approval_gate: string | null
    stop_reason: string | null
  handoff:
    interface: skill | graph | cli | hosted_api | workflow | provider_tool
    lane_ref: string
    runner_ref: string | null
    command_hint: string | null
  evidence:
    inputs_required: [string]
    readbacks: [string]
    receipt_refs: [string]
  risks: [string]
  next: [string]
```

## Worked example

```bash
runx skill business-ops \
  -i signal="launch readiness for API v2: docs, release, customer comms, and spend checks" \
  --json
```

The graph classifies the launch signal, prepares docs/release/work packets,
routes customer communication to an outreach plan, stops spend at a quote gate,
and names receipt/history checks that would prove later execution. No external
provider is called.

## Inputs

- `signal` (required): concise business operations signal to classify and route.
- `operator_context` (optional): product policy, project topology, audience
  constraints, or known provider state. Context only, not authority.

---
name: orchestrator
description: Compose existing catalog skills into an executable run-graph, scoping authority per hop and naming the receipt each step will produce.
runx:
  category: ops
---

# Orchestrator

Turn an objective into a run-graph over skills you already have.

An operator who wants "refund the customer, then notify them, then file the
dispute response" does not need a new skill; they need three known skills wired
in the right order, each handed only the authority its hop requires. This skill
builds that wiring. It reads the objective, selects from the available catalog,
orders the hops, narrows the grant at each one, and names the receipt every
step will seal. The output is a reviewable run plan, not a started run.

It routes EXISTING skills into a run; `work-plan` decomposes an objective into
reviewable tasks for humans to build. Orchestrator never invents a step that has
no catalog skill behind it. If the objective needs a capability the catalog
cannot cover, that is a blocker, not a hand-written instruction.

## What this skill does

1. Read the objective and the available catalog refs.
2. Select the skills whose declared purpose covers each part of the objective.
3. Order the hops into a topology: which steps depend on which, what runs in
   parallel, where a step consumes a prior step's output.
4. Scope authority per hop. Each step gets the narrowest grant that lets it run,
   and never broader than the parent grant the orchestrator itself holds.
5. Name the gate on each step: which hops need human approval or preflight
   before they proceed.
6. Name the receipt each step is expected to seal, so the run is auditable
   before it starts.
7. Carry a budget and a blocker list. Stop cleanly when no safe routing exists.

## When to use this skill

- An objective spans more than one known skill and the order, dependencies, or
  authority handoff between them needs to be decided before anything runs.
- A run must be reviewed for authority and gates before execution, hop by hop.
- A caller wants a plan it can pin and replay, with the receipt set known up
  front.

## When not to use this skill

- To decompose an objective into tasks a human will build. Use a work-plan
  skill; orchestrator only routes skills that already exist.
- To execute the run. This skill plans and stops; a separate executor consumes
  the plan and runs each hop under its own gates.
- To author a new skill for a gap in the catalog. A gap is a blocker.
- To widen authority. The plan can only narrow per hop, never grant a step more
  than the orchestrator's own parent grant.
- To inline a referenced skill's body, prompt, or secrets into a step. Steps
  carry a `skill_ref` and an `inputs_ref`, never the skill's contents or any
  secret value.

## Procedure

1. Read the objective.
   - Gate: if the objective is missing or empty, stop with `needs_agent`.
   - Restate it in operational terms before routing.

2. Read the available catalog.
   - Each candidate is a catalog ref (skill id plus version or digest), not a
     skill body. Match candidates to the parts of the objective by their
     declared purpose.
   - Gate: if no catalog ref covers a required part of the objective, record a
     blocker. Do not invent a step.

3. Order the hops.
   - Build the topology: edges express dependency, parallel branches express
     independence, and a step that consumes a prior step's output references it
     by step id, never by inlined value.
   - A step's `inputs_ref` points at the upstream step output or a caller-
     provided handle. Raw fetched content, contact lists, card numbers, and
     secret values are never inlined; reference digests and handles only.

4. Scope authority per hop.
   - Each step declares the narrowest scope that lets it run, in concrete policy
     syntax (for example `repo:write:/refunds/*`, `net:allowlist:api.stripe.com`,
     `wallet:spend<=$50`).
   - Invariant: no step's scope exceeds the parent grant the orchestrator holds.
     If a required step needs broader authority than the parent grant, record a
     blocker and stop with `needs_review`.

5. Name the gate per hop.
   - Mark `approval` on any step that mutates state, spends, sends, or crosses a
     trust boundary. Mark `preflight` where a check must pass before the hop
     runs. Read-only or planning hops may carry `none`.
   - The plan does not perform the gate; it declares which gate the executor must
     satisfy.

6. Name the expected receipt per hop.
   - Each step states the receipt it should seal (for example
     `runx.receipt.v1` with the step's skill ref), so the full receipt set is
     known before the run starts and a later audit can check completeness.

7. Carry budget and blockers.
   - Sum any per-hop spend or cost ceilings into the plan budget, bounded by the
     caller constraint. Record every gap, over-scope, or missing-skill condition
     as a blocker.

8. Decide the stop state.
   - Return `routed` when a complete, in-budget, in-scope topology exists.
   - Return `needs_review` when a partial plan exists but a hop has no safe
     routing, exceeds the parent grant, or breaks the budget.
   - Return `needs_agent` when the objective is missing.

## Edge cases and stop conditions

- **No objective:** return `needs_agent`. There is nothing to route.
- **Catalog gap:** a required part of the objective has no covering skill.
  Record the gap as a blocker and return `needs_review` with the partial plan.
- **Over-scope hop:** a required step needs authority broader than the parent
  grant. Record the blocker and return `needs_review`. Never silently widen.
- **Budget exceeded:** the summed per-hop cost exceeds the constraint budget.
  Return `needs_review` with the offending hops named.
- **Cycle in the topology:** dependencies form a loop. Return `needs_review`
  with the cyclic edges named; do not emit an unrunnable graph.
- **Ambiguous routing:** two skills equally cover a part and the choice changes
  authority or cost. Record both candidates on the step and return
  `needs_review`.
- **Secret or PII in a step input:** never inline it. Replace with a digest,
  span, or bound handle. If reference-only routing is impossible, record a
  blocker rather than embedding the value.

## Output

- `run_plan.objective`: the objective restated in operational terms.
- `run_plan.steps`: array of hop objects, each with:
  - `id`: stable step id used by edges and `inputs_ref`.
  - `skill_ref`: catalog ref (skill id plus version or digest). Never the body.
  - `scope`: the narrowest grant for this hop, in policy syntax, bounded by the
    parent grant.
  - `inputs_ref`: references to upstream step outputs or caller handles; digests
    and handles only, never raw secrets, PII, or fetched content.
  - `gates`: the gate the executor must satisfy (`approval`, `preflight`, or
    `none`).
  - `expected_receipt`: the receipt this hop should seal.
- `run_plan.topology`: array of edges (`from` step id, `to` step id) describing
  dependency and parallelism.
- `run_plan.budget`: the plan-level cost ceiling, bounded by the constraint
  budget, with per-hop allocations.
- `run_plan.blockers`: array of unresolved conditions (catalog gap, over-scope
  hop, budget breach, cycle, ambiguous routing). Empty when `routed`.
- `run_plan.status`: `routed`, `needs_review`, or `needs_agent`.

The plan references every skill by ref and stops at the plan boundary. It does
not start the run.

## Quality Profile

- Purpose: route an objective onto existing catalog skills as a hop-by-hop run
  graph that is in scope, in budget, and auditable before any hop runs.
- Audience: the operator who reviews the plan and the executor that will run it
  under each hop's gate.
- Artifact contract: a `run_plan` object carrying `objective`, `steps` (each with
  `id`, `skill_ref`, `scope`, `inputs_ref`, `gates`, `expected_receipt`),
  `topology`, `budget`, `blockers`, and `status`. Skills are referenced by ref;
  bodies are never inlined.
- Evidence bar: every step names a real catalog ref drawn from the available
  catalog. A step with no covering skill is a blocker, not an invented
  instruction. Per-hop scope and budget cite the constraint they were bounded
  by.
- Voice bar: terse operator-to-executor plan. Name skills, scopes, gates, and
  receipts in concrete syntax. No generic automation language; the plan reads
  maintainer-owned.
- Strategic bar: the plan makes authority and ordering reviewable before
  execution, so over-reach, cycles, and budget breaches are caught at plan time
  rather than mid-run.
- Stop conditions: return `needs_agent` when the objective is missing; return
  `needs_review` when no safe routing exists under the constraints (catalog gap,
  a hop that exceeds the parent grant, a budget breach, or a cyclic topology),
  carrying the partial plan and the blockers.

## Inputs

- `objective` (required): the goal to route onto existing skills, in plain
  language.
- `available_skills` (optional): catalog refs the orchestrator may choose from
  (skill ids plus versions or digests, with declared purpose). When omitted, the
  orchestrator routes over the resolvable catalog and names any gap as a blocker.
- `constraints` (optional): bounds the plan must respect, such as budget, the
  parent scope grant, allowed gates, and deadlines.

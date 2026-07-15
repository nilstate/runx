---
name: contract-drafter
version: 0.1.0
description: Assemble a reviewable contract draft from an explicit template, parties, and terms while exposing every baseline departure and preparing a gated send-as handoff.
source:
  type: graph
runx:
  category: business-ops
  tags:
    - contracts
    - drafting
    - governance
---

# Contract Drafter

`contract-drafter` assembles a review draft from three bounded inputs: a
template, explicit parties, and explicit terms. It renders only clause text
present in the template, records each supplied value that differs from the
template baseline, and emits a gated proposal whose consumer inputs match the
canonical `runx/send-as` planner.

The skill does not approve legal terms, provide legal advice, execute a
signature workflow, contact a recipient, or call a provider. A downstream
operator must review the draft, approve the proposal, invoke `send-as`, and
complete any provider-specific preflight under separate authority.

## Inputs

- `template` supplies:
  - `template_id`, `title`, and a checkable `source_ref`;
  - `required_party_roles` and `required_terms`;
  - `clauses[]`, each with a stable `id`, `title`, and `body_template`;
  - `baseline`, keyed by term; and
  - `term_clauses`, mapping every baseline term to the clause it changes.
- `parties` supplies every role named by `required_party_roles`. Each role must
  include an explicit `legal_name`; the runner never creates one.
- `terms` supplies every required deal value and a `send` object containing the
  exact downstream `send-as` planning inputs.

Clause templates may interpolate only scalar `parties.*` and `terms.*` paths.
Every placeholder must resolve from the current run inputs. The runner does not
fall back to a baseline, guess a missing value, or add a clause.

## Outputs

- `draft_doc`: Markdown assembled from the supplied clause bodies, with a
  content digest, stable draft ref, template source, party roles, and the exact
  source paths used.
- `deviations[]`: one item per changed baseline value. Every item names the
  clause, term, baseline, and proposed change.
- `send_proposal`: a `gated_not_sent` packet with `approved: false`. Its
  `consumer` names `runx/send-as`, runner `plan`, and binds the official planner
  inputs `objective`, `principal`, `audience`, `content_ref`, `consent_basis`,
  and `operator_context`.
- `validation`: the required fields and placeholders checked, plus explicit
  no-invention and no-send assertions.

The sealed receipt uses a review act and binds the generated `draft_ref` as the
artifact effect. The receipt proves the draft run occurred; it does not claim
the draft was legally approved or delivered.

## Refusal Rules

The run refuses closed and emits `draft_doc: null`, `deviations: []`, and
`send_proposal: null` when any of these conditions holds:

- a required party or `legal_name` is absent;
- a required term or baseline term is absent;
- the template has no checkable source ref or no clauses;
- a clause id is duplicated;
- a clause placeholder is unresolved, non-scalar, or outside `parties.*` and
  `terms.*`;
- a baseline term lacks a clause mapping; or
- any required downstream `terms.send` field is missing.

Refusal output identifies every missing or invalid field and seals that refusal
for review in the default graph. The package also exposes `refusal_check` for
harness and policy validation; it emits the same refusal packet and exits with
a failure status. Neither path creates a partial draft.

## Send-As Boundary

`send_proposal.consumer.inputs` can be passed to the canonical `send-as` plan
runner after human approval. `send-as` is itself a planning and authority layer;
a provider adapter remains a further separate step. The contract draft body is
referenced by digest and draft ref, not silently copied into a provider call.

Required sequence:

1. Run `contract-drafter` and inspect `draft_doc` and `deviations`.
2. Obtain explicit human approval for `contract-drafter.send.approval`.
3. Pass the unchanged `send_proposal.consumer.inputs` to `runx/send-as`.
4. Let the resulting send plan undergo its own approval and provider preflight.
5. Treat the draft as unsent until a separate provider receipt proves delivery.

## Harness Cases

- `complete-template-produces-gated-draft` seals a draft with four visible
  deviations and a not-approved `runx/send-as` handoff.
- `missing-required-term-refuses-without-proposal` runs `refusal_check`, omits
  `payment_terms`, returns failure, and emits neither a draft nor a proposal.

The fixtures use synthetic parties and nonbinding review data so the public
package contains no private contract or personal information. Production users
must provide their own authorized template and party data.

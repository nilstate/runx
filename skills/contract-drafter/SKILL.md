---
name: contract-drafter
description: Fetch a contract template by source ref, assemble a review draft, expose every baseline departure, and consume the proposal through canonical send-as planning without sending.
runx:
  category: business-ops
  tags:
    - contracts
    - drafting
    - governance
---

# Contract Drafter

`contract-drafter` assembles a review draft from a source-bound template,
explicit parties, and explicit terms. The default graph reads only
`template.source_ref` plus optional `template.source_text` and
`template.source_digest` from the template input, renders only clause text
present in that bound source, records each supplied value that differs from the
template baseline, emits a proposal for the canonical `runx/send-as` planner,
then consumes that proposal through one governed `send-as` planning act bound
to the pinned canonical `runx/send-as@sha-1f90b9364a3a#plan` contract without
executing provider delivery.

The skill does not approve legal terms, provide legal advice, execute a
signature workflow, contact a real recipient, or run a package-local send
adapter. Its boundary is draft plus proposal. Provider delivery belongs to
`send-as` and then a provider-specific adapter outside this skill.

## Inputs

- `template` is a source descriptor with `source_ref`. The runner trusts only
  that reference, then reads the template source at runtime from `repo:` or
  `file:`. For `https:` or `http:` references, pass `template.source_text` from
  an upstream native `http.read`/`web.fetch` step and optionally
  `template.source_digest`; the runner refuses on digest mismatch or missing
  source text. It refuses when the source cannot be resolved, parsed, or matched
  back to the source reference.
  The source document supplies:
  - `template_id`, `title`, and a `source_ref` matching `template.source_ref`;
  - `required_party_roles` and `required_terms`;
  - `clauses[]`, each with a stable `id`, `title`, and `body_template`;
  - `baseline`, keyed by term; and
  - `term_clauses`, mapping every baseline term to the clause it changes.
- `parties` supplies every role named by `required_party_roles`. Each role must
  include an explicit `legal_name`; the runner never creates one.
- `terms` supplies every required deal value and a `send` object containing the
  exact downstream `send-as` planning inputs.

Clause templates use `[[path]]` placeholders and may interpolate only scalar
`parties.*` and `terms.*` paths.
Every placeholder must resolve from the current run inputs. The runner does not
fall back to a baseline, guess a missing value, or add a clause.

## Outputs

- `draft_doc`: Markdown assembled from the supplied clause bodies, with a
  content digest, stable draft ref, template source, party roles, and the exact
  source paths used.
- `deviations[]`: one item per changed baseline value. Every item names the
  clause, term, baseline, and proposed change.
- `review_status` and `delivery_status`: top-level truth fields. A successful
  draft is `requires_review` and `not_sent`; a refusal is `refused` and
  `not_sent`.
- `send_proposal`: a packet with `approved: false` and status
  `ready_for_send_as`. Its `consumer` names `runx/send-as`, runner `plan`, and
  binds the official planner inputs `objective`, `principal`,
  `provider_context`, `audience`, `content_ref`, `consent_basis`, and
  `operator_context`.
- `send_plan`: present only on the default graph result after the governed
  `send-as` act consumes the proposal under the pinned canonical planning
  contract. The deterministic finalizer verifies the plan remains draft-bound,
  approval-gated, and plan-only.
- `send_as_result`: omitted from the contract draft packet. `contract-drafter`
  consumes canonical `send-as` planning, but it never embeds or executes a
  provider send result.
- `validation`: the required fields and placeholders checked, plus explicit
  source binding, canonical send-as target, no-invention, and no-send
  boundary assertions.

The sealed receipt uses a review act and binds the generated `draft_ref` as the
artifact effect. The receipt proves the draft/proposal run; it does not claim
the draft was legally approved or delivered to a real external recipient.

## Refusal Rules

The run refuses closed and omits `draft_doc` and `send_proposal` while emitting
`deviations: []` when any of these conditions holds:

- a required party or `legal_name` is absent;
- a required term or baseline term is absent;
- the template source ref cannot be resolved, external source text is missing,
  source digest mismatches, or the parsed template source does not match the
  template `source_ref`;
- the template has no clauses;
- a clause id is duplicated;
- a clause placeholder is unresolved, non-scalar, or outside `parties.*` and
  `terms.*`;
- a baseline term lacks a clause mapping; or
- any required downstream `terms.send` field is missing.

Refusal output identifies every missing or invalid field. In the default graph
it prevents both send-as planning and finalization, so the graph closes as a
failure with no draft or proposal result. The package also exposes
`refusal_check` for harness and policy validation; it emits the same refusal
packet and exits with a failure status. Neither path creates a partial draft.

## Send-As Boundary

The default runner is a graph with three consequential steps:

1. `draft-contract` runs deterministic package code to produce the draft and
   proposal.
2. `plan-send-as` executes one governed `send-as` planning act with the proposal
   inputs and the pinned canonical `runx/send-as@sha-1f90b9364a3a#plan`
   contract materialized in the package.
3. `finalize` verifies the send plan remains draft-bound and plan-only.

It does not include `./graph/send-as`, a package-local `send-as` namesake,
`mock-send.mjs`, or any provider adapter. The contract draft body is referenced
by digest and draft ref, not copied into a provider call.

Required sequence:

1. Run default `contract-drafter` with `template.source_ref`, `parties`, and
   `terms`.
2. Inspect `draft_doc`, `deviations`, `send_proposal`, and the canonical
   `send_plan`.
3. For a real recipient, run a separate provider-specific adapter under its own
   authority. The default runner proves only draft/proposal preparation.

## Harness Cases

- `complete-template-fetches-source-and-consumes-canonical-send-as-plan` reads the
  template from `template.source_ref`, seals a draft with four visible
  deviations, executes the governed send-as planning act, and leaves provider
  delivery outside `contract-drafter`.
- `missing-required-term-refuses-without-proposal` runs `refusal_check`, omits
  `payment_terms`, returns failure, and emits neither a draft nor a proposal.

The fixtures use synthetic parties and nonbinding review data so the public
package contains no private contract or personal information. Production users
must provide their own authorized template and party data.

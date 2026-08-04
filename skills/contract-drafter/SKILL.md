---
name: contract-drafter
description: Fetch a contract template by source ref, assemble a review draft, expose every baseline departure, and prepare a canonical send-as proposal without sending.
runx:
  category: business-ops
  tags:
    - contracts
    - drafting
    - governance
---

# Contract Drafter

`contract-drafter` assembles a review draft from a runtime-fetched template,
explicit parties, and explicit terms. It reads only `template.source_ref` from
the template input, fetches the template document at run time, renders only
clause text present in that fetched source, records each supplied value that
differs from the template baseline, and emits a proposal for the canonical
`runx/send-as` planner without executing provider delivery.

The skill does not approve legal terms, provide legal advice, execute a
signature workflow, contact a real recipient, or run a package-local send
adapter. Its boundary is draft plus proposal. Provider delivery belongs to
`send-as` and then a provider-specific adapter outside this skill.

## Inputs

- `template` is a source descriptor with `source_ref`. The runner trusts only
  that reference, then reads the template source at runtime from `repo:`,
  `file:`, `https:`, or `http:`. It refuses when the source cannot be resolved,
  fetched, parsed, or matched back to the fetched template's own `source_ref`.
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
- `send_proposal`: a packet with `approved: false` and status
  `ready_for_send_as`. Its `consumer` names `runx/send-as`, runner `plan`, and
  binds the official planner inputs `objective`, `principal`,
  `provider_context`, `audience`, `content_ref`, `consent_basis`, and
  `operator_context`.
- `send_as_result`: omitted from the contract draft packet. `contract-drafter`
  emits the proposal only; run canonical `send-as` separately to plan delivery.
- `validation`: the required fields and placeholders checked, plus explicit
  runtime template fetch, canonical send-as target, no-invention, and no-send
  boundary assertions.

The sealed receipt uses a review act and binds the generated `draft_ref` as the
artifact effect. The receipt proves the draft/proposal run; it does not claim
the draft was legally approved or delivered to a real external recipient.

## Refusal Rules

The run refuses closed and omits `draft_doc` and `send_proposal` while emitting
`deviations: []` when any of these conditions holds:

- a required party or `legal_name` is absent;
- a required term or baseline term is absent;
- the template source ref cannot be resolved or does not match the template
  `source_ref`;
- the template has no clauses;
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

The default runner emits `send_proposal.consumer.inputs` for the canonical
`runx/send-as` plan runner. It does not include `./graph/send-as`, a
package-local `send-as` namesake, `mock-send.mjs`, any graph dependency, or any
provider adapter. The contract draft body is referenced by digest and draft ref,
not copied into a provider call.

Required sequence:

1. Run `contract-drafter` with `template.source_ref`, `parties`, and `terms`.
2. Inspect `draft_doc`, `deviations`, and `send_proposal`.
3. Run or inspect `send-as` planning under its own authority before any
   provider-specific adapter executes.
4. For a real recipient, run a separate provider-specific adapter under its own
   authority. The default runner proves only draft/proposal preparation.

## Harness Cases

- `complete-template-fetches-source-and-emits-canonical-send-as-proposal` fetches the
  template from `template.source_ref`, seals a draft with four visible
  deviations, emits a canonical `runx/send-as` proposal, and leaves planning
  plus provider delivery outside `contract-drafter`.
- `missing-required-term-refuses-without-proposal` runs `refusal_check`, omits
  `payment_terms`, returns failure, and emits neither a draft nor a proposal.

The fixtures use synthetic parties and nonbinding review data so the public
package contains no private contract or personal information. Production users
must provide their own authorized template and party data.

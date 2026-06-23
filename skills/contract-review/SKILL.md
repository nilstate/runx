---
name: contract-review
description: Review a contract against a supplied playbook, extract cited clauses, redline risky terms, and summarize risk without emitting effects.
runx:
  category: legal
---

# Contract Review

Review contract text against a supplied acceptable-terms playbook.

This skill extracts clauses from a contract, checks only the supplied playbook
rules, emits playbook-cited redlines, and summarizes risk for a human reviewer.
It is read-only over the inputs and never emits an approval, signature,
negotiation, filing, or payment effect.

## What this skill does

This skill converts contract and playbook inputs into a review packet:

- `clauses`: contract clauses that are actually present in the input.
- `redlines`: risk findings that cite both the contract clause and the breached
  playbook rule.
- `risk_summary`: risk level, counts, and read-only constraints.

It emits one of three decision states:

- `reviewed`: the input looked like a contract and supplied playbook rules were
  evaluated.
- `refused`: the input was not a contract or was unparseable as contract text.
- `needs_input`: the playbook did not supply review rules.

## When to use this skill

- A legal, sales, security, or operations reviewer needs a first-pass contract
  risk packet.
- The contract text and acceptable-terms playbook are both available as inputs.
- A reviewer needs redlines that cite exact clause text and exact supplied
  playbook rules.
- A workflow needs a read-only artifact before a human decides whether to
  accept, reject, negotiate, or escalate terms.

## When not to use this skill

- To sign, approve, reject, negotiate, file, or send a contract.
- To infer hidden terms, oral side agreements, or external legal standards not
  in the supplied playbook.
- To summarize a document without clause-level evidence.
- To review non-contract inputs such as emails, menus, resumes, tickets, or
  policies.
- To provide legal advice without human review.

## Procedure

1. Confirm `contract` is a JSON object with `text` or `clauses`.
2. Confirm `playbook` is a JSON object with a non-empty `rules` array.
3. Extract clauses only from `contract.clauses` or clearly labelled contract
   sections in `contract.text`.
4. For each playbook rule, locate the matching clause by `clause_type` or
   supplied keywords.
5. If a required clause is missing, create a redline that cites the playbook
   rule and marks the clause as absent.
6. If a present clause breaches a supplied rule, create a redline with
   `clause_id`, quoted `clause_text`, the `playbook_rule`, severity, and a
   recommendation.
7. Produce a risk summary from the redlines.
8. Stop with `refused` or `needs_input` instead of inventing missing contract
   clauses or missing playbook rules.

## Edge cases and stop conditions

- Non-contract text: return `refused`.
- Empty or absent `playbook.rules`: return `needs_input`.
- Missing required clause: redline the absence; do not invent clause text.
- Rule has no matching clause and is not required: skip it without asserting a
  breach.
- Ambiguous clause mapping: prefer `needs_input` or a conservative redline only
  when clause text and rule citation are both present.
- Secrets, credentials, or private account numbers in contract text: do not
  echo them; cite a redacted evidence id instead.
- Requests to approve, sign, send, or negotiate the contract: refuse those
  effects and return the read-only review artifact.

## Output schema

```yaml
decision:
  status: reviewed | refused | needs_input
  contract_ref: string
  playbook_ref: string
  reasons: [string]
clauses:
  - id: string
    type: string
    title: string
    text: string
redlines:
  - rule_id: string
    playbook_ref: string
    clause_id: string | null
    clause_type: string
    severity: low | medium | high
    issue: string
    citation:
      clause_text: string | null
      playbook_rule: string
    recommendation: string
risk_summary:
  level: low | medium | high | not_reviewed
  redline_count: number
  clause_count: number
  read_only: true
  no_effects_emitted: true
```

## Worked example

Input:

```yaml
contract:
  id: msa-acme-2026
  clauses:
    - id: c1
      type: termination
      text: Either party may terminate this Agreement with 90 days notice.
playbook:
  id: legal-playbook-2026-06
  rules:
    - id: term-notice-max-30
      clause_type: termination
      description: Termination for convenience must not require more than 30 days notice.
      max_notice_days: 30
      severity: medium
      recommendation: Change notice period to 30 days or less.
```

Output:

```yaml
decision:
  status: reviewed
clauses:
  - id: c1
    type: termination
redlines:
  - rule_id: term-notice-max-30
    clause_id: c1
    issue: Notice period is 90 days, above playbook maximum 30 days.
    citation:
      clause_text: Either party may terminate this Agreement with 90 days notice.
      playbook_rule: Termination for convenience must not require more than 30 days notice.
risk_summary:
  level: medium
  read_only: true
  no_effects_emitted: true
```

If the same input is a lunch menu or ordinary note, the result is `refused` and
no clauses or redlines are emitted.

## Inputs

- `contract`: JSON object with `id`, optional `text`, and optional `clauses`.
  Each clause should include `id`, `type`, `title`, and `text`.
- `playbook`: JSON object with `id` and `rules`.

Playbook rules may include:

```yaml
rules:
  - id: term-notice-max-30
    clause_type: termination
    description: Termination notice must be 30 days or less.
    max_notice_days: 30
    severity: medium
    recommendation: Reduce notice period to 30 days or less.
  - id: liability-cap-required
    clause_type: liability
    description: Liability must be expressly capped.
    requires_liability_cap: true
    severity: high
```

## Output

Return JSON with:

- `decision`: review/refusal status and input refs.
- `clauses`: extracted contract clauses that are present in the input.
- `redlines`: playbook-cited clause issues or missing required clauses.
- `risk_summary`: risk level, counts, and read-only/no-effect constraints.

## Safety Rules

- Stay read-only. Do not sign, approve, reject, send, file, pay, or negotiate.
- Never assert a clause that is absent from the contract input.
- Never invent a playbook rule that was not supplied.
- Cite both the clause and the playbook rule for every redline.
- Refuse non-contract or unparseable documents.
- Route legal decisions to a human reviewer.

## Local Verification

Run:

```sh
node test.mjs
```

The test covers a contract that yields extracted clauses and playbook-cited
redlines, plus a non-contract input that is refused.

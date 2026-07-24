---
name: contract-drafter
version: 0.1.0
description: Turn a contract brief (parties[], term, jurisdiction, payment_terms) into a bounded contract outline with clauses[], defined_terms[], risk_flags[], and a missing_fields[] list. Emits a draft outline only; never sends for signature, never files anywhere.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/contract-drafter
runx:
  category: ops
  input_resolution:
    required:
      - parties
      - term
---

## What this skill does

Compose a bounded contract outline from a bounded contract brief. The runner
emits `runx.contract.draft.v1` with `clauses[]`, `defined_terms[]`,
`risk_flags[]`, and `missing_fields[]`. It is a deterministic local
composer; it never sends for signature, never uploads to DocuSign, never
files anywhere.

The skill proposes a draft outline; a separate legal-review skill can
review, approve, and emit authority grants before any external action.

## When to use this skill

Use this skill when an agent has a bounded contract brief and needs a
first-pass structured outline. It is useful in commercial rotations,
pre-deal hygiene, and template-driven contract intake where the same
bounded inputs need a bounded output every time.

It is intentionally read-only by design. It emits drafts; it never
enforces them.

## When not to use this skill

Do not use this skill as a contract-of-record, an authoritative legal
opinion, or a substitute for legal counsel. Do not use it to send for
signature, upload to DocuSign / HelloSign, or file with any registry.
Do not use it to negotiate, counter-offer, or amend a signed agreement.

If `parties[]` is empty or `term` is missing, the skill refuses with
`needs_input`. If the brief carries private party data that has not been
summarized, the skill refuses with `refused`.

## Procedure

1. Require `parties[]` to be a non-empty array of `{role, name}` records.
2. Require `term` to be a non-empty string describing duration.
3. Accept optional `jurisdiction`, `payment_terms`, `governing_law`,
   `renewal`, `termination_for_convenience`, `liability_cap`.
4. Compose a clause list: parties, term, payment, termination, governing
   law, liability cap, IP, confidentiality, dispute resolution,
   boilerplate.
5. Compose `defined_terms[]` from party names + named jurisdictions +
   recurring terms.
6. Compose `risk_flags[]` from absent optional fields that are normally
   expected (governing_law, liability_cap, etc.).
7. Compose `missing_fields[]` from absent required fields beyond
   parties/term.
8. Emit `runx.contract.draft.v1` packet and meta block.

## Edge cases and stop conditions

Return `needs_input` when parties or term are missing. Return `refused`
when the brief carries private party data not previously summarized.
Never invent clauses not implied by the input. Never propose a liability
cap that exceeds the highest present in the input.

Authority scope is contract outline composition only. The proof surface
is the sealed packet with clauses, defined_terms, risk_flags,
missing_fields, and handoff envelope. Any live signature, upload, or
filing requires a separate governed outbound skill.

## Output schema

The runner emits `runx.contract.draft.v1`:

```json
{
  "clauses": [
    { "id": "parties", "summary": "Buyer (Acme Corp) and Seller (Lumen LLC)..." },
    { "id": "term", "summary": "Initial term of 12 months from effective date." },
    { "id": "payment", "summary": "Net-30 USD invoicing; late fee 1.5% per month." },
    { "id": "termination", "summary": "Either party may terminate for material breach..." },
    { "id": "governing_law", "summary": "Governed by the laws of Delaware, USA." },
    { "id": "liability_cap", "summary": "Liability capped at fees paid in prior 12 months." }
  ],
  "defined_terms": [
    { "term": "Acme Corp", "definition": "The buyer party." },
    { "term": "Lumen LLC", "definition": "The seller party." }
  ],
  "risk_flags": [
    "no_explicit_liability_cap",
    "no_termination_for_convenience_window"
  ],
  "missing_fields": [
    "governing_law",
    "auto_renewal_notice_days"
  ],
  "handoff": {
    "next_skill": "governed-outbound",
    "requires_human_approval": true
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --runner draft \
  --input-json parties='[{"role":"buyer","name":"Acme Corp"},{"role":"seller","name":"Lumen LLC"}]' \
  --input-json term='12 months from effective date' \
  --input-json jurisdiction='Delaware, USA' \
  --input-json payment_terms='Net-30 USD; late fee 1.5% per month' \
  --json
```

Expected result: `clauses` includes parties, term, payment, termination,
governing_law, liability_cap, IP, confidentiality, dispute resolution,
boilerplate; `defined_terms` includes both party names; `risk_flags`
includes `no_explicit_liability_cap`. The run does not send for signature
or upload anywhere.

## Inputs

- `parties`: non-empty array of `{role, name}` records.
- `term`: non-empty duration string.
- `jurisdiction`: optional jurisdiction hint.
- `payment_terms`: optional payment terms.
- `governing_law`: optional governing law string.
- `renewal`: optional renewal terms.
- `termination_for_convenience`: optional termination-for-convenience hint.
- `liability_cap`: optional liability cap hint.

## Outputs

- `clauses`: bounded outline clauses.
- `defined_terms`: bounded defined-term list.
- `risk_flags`: bounded risk flags from missing optional fields.
- `missing_fields`: bounded list of absent optional fields.
- `handoff`: pointer to the next governed skill.
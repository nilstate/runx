---
name: ledger
description: Answer a cross-run audit question against the receipt ledger, returning matched receipts and a chain-verification result.
runx:
  category: security
---

# Ledger

Answer one audit question against the whole receipt ledger, and prove the chain
behind the answer.

runx seals a receipt for every run. Those receipts accumulate into a ledger:
every act, every approval, every refusal, across every principal and every
skill, in sealed order. When an auditor asks "did anyone spend over $500 last
week", "how many sends did this principal authorize", or "which runs touched the
billing scope", the answer lives in that ledger. This skill turns the question
into a ledger query, returns the receipts that match by id, and, when asked,
verifies that the matched stretch of the chain is intact. It reads; it never
writes.

It queries and proves history across many runs; `receipt-auditor` audits the
integrity of a single receipt chain. Ask `ledger` "what happened" and "is the
record whole"; ask `receipt-auditor` "did this one run stay inside its grant".

## What this skill does

1. **Parse the question into a query.** Turn the audit question and any filter
   into a bounded ledger query over principal, skill ref, status, and time
   range.
2. **Match receipts.** Return the receipts that satisfy the query as id-keyed
   stubs only: `receipt_id`, `skill_ref`, `status`, `created_at`. Never inline a
   receipt body.
3. **Verify the chain when asked.** When `proof` requests it, walk the link
   field across the matched receipts and confirm the hash chain is unbroken,
   reporting any break by the two receipt ids that fail to link.
4. **Summarize the answer.** State the answer to the question in one or two
   sentences, grounded only in the matched receipts and the verification result.
5. **Stop when the ledger is silent.** No matching receipts means
   `needs_more_evidence`, not a fabricated zero with implied coverage.

## Core principles

- **Read-only over the ledger.** This skill holds `ledger:read` and nothing
  else. It never seals, amends, deletes, or reorders a receipt.
- **Reference by id, never by body.** A matched receipt is named by its id and a
  few stub fields. Receipt bodies, act payloads, proofs, and material refs stay
  out of this skill's output.
- **The chain is the proof, not the prose.** A claim that history is intact must
  rest on a verified link walk, not on the count looking plausible.
- **Silence is a stop, not a zero.** An empty match set means the question is
  unanswered from the ledger, so the skill stops rather than asserting nothing
  happened.
- **The question bounds the answer.** The summary answers the asked question and
  nothing wider; it does not generalize from the matched slice to the whole
  ledger.

## When to use this skill

- An auditor needs a cross-run answer: counts, totals-by-reference, who did what,
  which runs touched a scope or skill over a window.
- A review needs the set of receipts that match a condition before drilling into
  any single one.
- A compliance check needs proof that a stretch of ledger history is unbroken.

## When not to use this skill

- To audit whether one run stayed inside its grant. Use `receipt-auditor`.
- To narrow a grant from observed usage. Use `least-privilege-auditor`.
- To mutate, redact, export, or archive receipts. This skill is read-only and
  refuses any write framing.
- To return receipt bodies, act payloads, or any secret-bearing field. Matched
  receipts are id stubs only.

## Governance

- **Scope:** `ledger:read` only. No write, mutate, export, or network scope is
  requested or used.
- **Gate:** none required, because the skill cannot mutate. A request framed as a
  delete, redact, reseal, or reorder is refused, not gated.
- **Receipt:** the run's own receipt carries the question, the resolved query
  filter, the count of matched receipts, the list of matched `receipt_id`
  values, and the chain-verification result. It does not carry any matched
  receipt body, principal PII, or secret material; matched receipts are
  referenced by id.

## Procedure

1. Read the question. With no question, return `needs_agent`.
2. Resolve the filter into a bounded query: principal handle, `skill_ref`,
   status set, and `time_range`. An absent filter means the question alone bounds
   the query.
3. Match receipts against the query and collect id-keyed stubs.
4. With zero matches, return `needs_more_evidence` and name the query that found
   nothing.
5. When `proof` requests chain verification, walk the link field across the
   matched receipts in sealed order and record `intact` plus any `breaks` by id
   pair. When `proof` is absent, set `chain_verification.checked` to false and
   leave `intact` null.
6. Write a one or two sentence `summary` that answers the question from the
   matched set and the verification result only.
7. Return the `ledger_answer` with `decision: answered`.

## Edge cases and stop conditions

- **No question:** return `needs_agent`; there is nothing to query.
- **No matching receipts:** return `needs_more_evidence` with the resolved query,
  so the gap is the query, not a silent zero.
- **Filter references an unknown principal or skill_ref:** treat as zero matches
  and return `needs_more_evidence`; do not guess a near match.
- **Chain break found:** keep `decision: answered` but set
  `chain_verification.intact` false and list the breaking id pairs; an intact
  answer set with a broken chain is still a reportable result.
- **Verification requested over an empty match set:** the stop is
  `needs_more_evidence` for the match, not a chain claim over nothing.
- **Write, delete, or reseal framing in the question:** refuse; this skill holds
  read scope only.

## Output

- `ledger_answer.question`: the audit question this run answered, restated in
  operational terms.
- `ledger_answer.query`: the resolved filter actually run (principal, skill_ref,
  status, time_range), so the answer is reproducible.
- `matched_receipts`: array of id-keyed stubs, each with `receipt_id`,
  `skill_ref`, `status`, and `created_at`. No receipt body.
- `chain_verification`: object with `checked` (was verification requested),
  `intact` (true, false, or null when unchecked), and `breaks` (array of
  `{ from_receipt_id, to_receipt_id, reason }`).
- `summary`: one or two sentences answering the question from the matched set and
  the verification result.

The `ledger_answer` object is the named packet `runx.ledger_answer.v1`. Matched
receipts are always referenced by id; their bodies, acts, proofs, principals,
and material refs are never inlined.

## Quality Profile

- Purpose: answer one cross-run audit question from the receipt ledger and, when
  asked, prove that the matched stretch of the chain is unbroken.
- Audience: the auditor, compliance reviewer, or follow-on skill that needs a set
  of matching receipts and a chain verdict before drilling into any single run.
- Artifact contract: a `runx.ledger_answer.v1` packet carrying
  `ledger_answer.question`, `ledger_answer.query`, `matched_receipts` (id stubs:
  `receipt_id`, `skill_ref`, `status`, `created_at`), `chain_verification`
  (`checked`, `intact`, `breaks`), and a bounded `summary`. Matched receipts are
  referenced by id; no receipt body is inlined.
- Evidence bar: every count or claim in the summary is backed by the
  `matched_receipts` set; every chain claim is backed by a recorded link walk in
  `chain_verification`. A plausible number without a matching id set is not
  evidence.
- Voice bar: terse analyst-to-auditor prose. State the answer first, then the
  query that produced it. No narration of the query, no padding, no generic audit
  language.
- Strategic bar: the answer must let the auditor decide a next move: accept the
  finding, escalate a chain break, or drill into a named receipt. A summary that
  does not change that decision is not worth returning.
- Stop conditions: return `needs_agent` when the question is missing; return
  `needs_more_evidence` when the resolved query matches zero receipts. Never
  assert an intact chain over an empty set, and never report a zero as a clean
  answer.

## Inputs

- `question` (required): the audit question to answer against the ledger.
- `filter` (optional): JSON narrowing the query by `principal`, `skill_ref`,
  `status`, and `time_range` (`from`/`to`).
- `proof` (optional): JSON requesting chain verification over the matched
  receipts, for example `{ "verify_chain": true }`.

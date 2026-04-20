# AI AGENT — HARDEN MODE

**Status:** ACTIVE
**Mode:** HARDEN
**Output:** Append a round to `harden_rounds` in the spec; update `harden_status`.
**Do NOT:** Modify code outside the spec file while hardening.

---

## Mission

Interrogate the draft spec relentlessly until the operator and agent reach shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one — upstream choices first, so downstream questions are not wasted on premises that may shift. Stop when the operator says so, or when you run out of grounded questions.

Harden is OPTIONAL and operator-driven. `scafld approve` does NOT gate on harden status. The operator runs `scafld harden <task-id>` when they want to stress-test a draft; they can skip it for trivial or well-understood specs.

---

## Grounding Contract (load-bearing — read carefully)

**Every question you emit MUST carry a `grounded_in` value matching EXACTLY ONE of these three patterns:**

- `spec_gap:<field>` — a TODO, `?`, empty array, vague clause, or internal contradiction at the named spec field. Example: `spec_gap:task.context.files_impacted`.
- `code:<file>:<line>` — a symbol or location verified by `Read` or `Grep` in the CURRENT session before the question is emitted. You must actually look at the file. Example: `code:cli/scafld:1152`.
- `archive:<task_id>` — a precedent in `.ai/specs/archive/` that bears on the current decision. Example: `archive:configurable-review-pipeline`.

**Forbidden:**

- Questions about behaviour the spec already answers.
- Citations to files you have not verified in this session.
- Recommended answers without their own citation.
- Invented file paths, function names, or archive task_ids.

If you cannot produce a grounded question, stop. Do not invent one to pad the round.

---

## Question Loop

Ask ONE question at a time. For each question, provide:

- The question itself (specific, answerable).
- `grounded_in` using one of the three patterns above.
- A **recommended answer** with its own citation (code, spec section, or archive).
- An `if_unanswered` default — what to write into the spec if the operator does not answer. This lets the loop terminate on a single side.

Cap at `max_questions_per_round` from `.ai/config.yaml` (default 8). If you reach the cap without resolving the tree, stop and let the operator decide whether to start another round.

Dependency ordering: before asking a downstream question, confirm its upstream premise is settled. If you ask "how does phase 3 validate X" before confirming "does the spec actually do X in phase 2", you are wasting the round.

---

## Termination

The loop ends when ANY of these happens:

- Operator types `done` or `stop`.
- You run out of grounded questions (your three patterns are exhausted).
- You hit `max_questions_per_round`.

There is no in-prompt `skip` keyword. If the operator does not want to harden, they simply do not run `scafld harden`.

---

## Output Contract

Write your round into the spec's `harden_rounds` array using the schema in `.ai/schemas/spec.json`. Each round:

```yaml
harden_rounds:
  - round: 1
    started_at: "2026-04-20T15:00:00Z"
    ended_at: "2026-04-20T15:12:00Z"
    outcome: "in_progress"          # or passed, abandoned
    questions:
      - question: "Which module owns the session cleanup hook?"
        grounded_in: "code:src/auth/session.ts:84"
        recommended_answer: "src/auth/session.ts:cleanupSession (already defined)"
        if_unanswered: "Default to existing cleanupSession; flag for confirmation."
        answered_with: "(operator fills in)"
```

While the loop runs, set top-level `harden_status: "in_progress"`. The operator finalises a satisfactory round by running `scafld harden <task-id> --mark-passed` — do NOT set `harden_status: passed` from the prompt loop.

Re-running `scafld harden` on a spec that is already `passed` resets status to `in_progress` and appends a new round; prior rounds are preserved as audit trail.

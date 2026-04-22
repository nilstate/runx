# AI AGENT — HARDEN MODE

**Status:** ACTIVE
**Mode:** HARDEN
**Output:** Append a round to `harden_rounds` in the spec; keep `harden_status: "in_progress"` until the operator runs `--mark-passed`.
**Do NOT:** Modify code outside the spec file while hardening.

---

Interview the operator relentlessly about the draft spec until you reach shared understanding.

Walk the design tree upstream first, so downstream questions are not wasted on premises that may still move.

Ask one question at a time. For each question, provide your recommended answer.

If a question can be answered by exploring the codebase, explore the codebase instead of asking. Bring back the verified finding and use it to sharpen the next question.

Record why each question exists with a single `grounded_in` value:

- `spec_gap:<field>` for a missing, vague, or contradictory spec field
- `code:<file>:<line>` for code you actually verified in this session
- `archive:<task_id>` for a relevant archived spec precedent

Use `grounded_in` as audit trail, not ceremony. Do not invent citations. Do not cite code you have not read. Do not ask about behavior the spec already settles.

If useful, include `if_unanswered` with the default you would write into the spec if the operator declines to answer.

If you cannot form a genuine grounded question, stop. Do not pad the round.

`max_questions_per_round` from `.ai/config.yaml` is a cap, not a target.

The operator can end the loop by saying `done` or `stop`. A satisfactory round is finalized by running `scafld harden <task-id> --mark-passed`.

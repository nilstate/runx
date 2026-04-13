# scafld — Operator Cheat Sheet

A short, human-friendly guide for working with scafld task specs.
For full details, see `.ai/README.md` and `.ai/specs/README.md`.

---

## 1. Tiny Change (Micro/Small, Low Risk)

Use this for trivial, low-risk edits (comments, copy tweaks, tiny refactors).

- In the spec:
  - `task.size: "micro"` or `"small"`
  - `task.risk_level: "low"`
  - Optionally set `task.acceptance.validation_profile: "light"`
- Workflow:
  - Plan: generate/update spec under `.ai/specs/drafts/`
  - Approve: move to `.ai/specs/approved/` and set `status: "approved"`
  - Execute: move to `.ai/specs/active/` and set `status: "in_progress"`
  - Complete: move to `.ai/specs/archive/YYYY-MM/` and set `status: "completed"`

---

## 2. Normal Task (Small/Medium, Medium Risk)

Use this for typical feature work and non-trivial refactors.

- In the spec:
  - `task.size: "small"` or `"medium"`
  - `task.risk_level: "medium"`
  - Usually `task.acceptance.validation_profile: "standard"`
- Workflow:
  - Plan: ensure `task.acceptance.definition_of_done` and `phases[*].acceptance_criteria` tell the same story.
  - Approve: move to approved folder
  - Execute: run all `acceptance_criteria` plus per-phase validation
  - Complete: run full standard profile validation before archiving

---

## 3. Big Change (Medium/Large, High Risk)

Use this for high-impact work (auth, persistence, complex refactors).

- In the spec:
  - `task.size: "medium"` or `"large"`
  - `task.risk_level: "high"`
  - Usually `task.acceptance.validation_profile: "strict"`
- Workflow:
  - Plan:
    - Explicitly call out invariants and risks
    - Use multiple phases with narrow scopes and strong acceptance criteria
  - Approve: move to approved folder
  - Execute: run all per-phase checks plus full `strict` profile
  - Complete: thorough validation before archiving

---

## 4. Quick Commands Reference

```bash
scafld new my-task -t "My feature" -s small -r low   # scaffold spec
scafld list                      # show all specs
scafld list active               # filter by status
scafld status my-task            # show details + phase progress
scafld validate my-task          # check against schema
scafld approve my-task           # drafts/ -> approved/
scafld start my-task             # approved/ -> active/
scafld exec my-task              # run acceptance criteria, record results
scafld exec my-task -p phase1    # run criteria for one phase only
scafld audit my-task             # compare spec files vs git diff
scafld audit my-task -b main     # audit against specific base ref
scafld diff my-task              # show git history for spec
scafld review my-task            # run configured automated passes + scaffold Review Artifact v3
scafld complete my-task          # read review, record verdict, archive (requires review)
scafld complete my-task --human-reviewed --reason "manual audit"  # exceptional audited override when the review gate is blocked
scafld fail my-task              # active/ -> archive/ (failed)
scafld cancel my-task            # active/ -> archive/ (cancelled)
scafld report                    # aggregate stats across all specs
```

---

## 5. Validation Profiles

| Profile | When to Use | What Runs |
|---------|-------------|-----------|
| `light` | micro/small, low risk | compile, acceptance items, perf eval |
| `standard` | small/medium, medium risk | compile, tests, lint, typecheck, security, perf eval |
| `strict` | medium/large, high risk | all standard checks + broader coverage |

---

## 6. Status Lifecycle

```
draft → under_review → approved → in_progress → review → completed
                                      ↓           ↓
                                   (blocked)     failed
                                      ↓           ↑
                                   (resume)    fix + re-review
```

---

## 7. Review & Completion Workflow

After execution, before completing:

```bash
scafld review my-task            # runs automated passes, scaffolds adversarial review
                                  # reviewer fills in findings + Review Artifact v3 metadata in .ai/reviews/my-task.md
scafld complete my-task          # reads review, records verdict, archives
                                  # refuses if the latest review round is missing, malformed, incomplete, or failed
scafld complete my-task --human-reviewed --reason "manual audit"
                                  # exceptional audited override; requires interactive confirmation
```

Review rounds accumulate — each `scafld review` appends a numbered Review Artifact v3 section with per-pass `pass_results`. The default five-layer pipeline is `spec_compliance`, `scope_drift`, `regression_hunt`, `convention_check`, and `dark_patterns`, ordered by explicit `order` fields in `.ai/config.yaml`. Prior rounds provide context for subsequent reviewers and make review provenance visible.

---

## 8. Tips

- **Always read the spec before executing** — understand what you're building
- **Keep phases small** — easier to validate and rollback
- **Run `scafld review` before completing** — the adversarial review catches what acceptance criteria miss
- **Review in a fresh session when possible** — avoids confirmation bias from the execution session
- **Self-eval honestly** — the 7/10 threshold keeps quality high; 10/10 requires justification
- **Archive completed specs** — they're your project history

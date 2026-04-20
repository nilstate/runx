# AI AGENT — PLANNING MODE

**Status:** ACTIVE
**Mode:** PLAN
**Output:** Conversational task specification file (`.ai/specs/{task-id}.yaml`)
**Do NOT:** Modify code outside `.ai/specs/` while planning

---

## Mission

You are in **PLANNING MODE**. Partner with the user conversationally to shape a single **task** artifact that fully describes the work: context, touchpoints, risks, acceptance checklist, and execution phases. The spec must be executable by another agent without more back-and-forth.

---

## Conversational ReAct Loop

Iterate until the task artifact feels complete:

1. **THOUGHT:** Interpret the request in repo terms. Identify unknowns.
2. **ACTION:** Gather evidence (search, read, diff) to answer the unknowns.
3. **OBSERVATION:** Capture what you learned (files, invariants, risks).
4. **THOUGHT:** Update the `task` block, acceptance, and phases. Ask clarifying questions when information is missing.
5. **REPEAT** until all required fields are filled and assumptions are explicit.

Constraints:
- Max 20 cycles; document assumptions if still uncertain.
- Keep planning conversational - confirm intent before locking the `task` spec.
- Every update to the spec should be reflected in `planning_log`.

**Context window awareness:** If planning exceeds context limits, document assumptions and save the spec with `status: "under_review"`. Resuming planning later is better than losing work.

---

## Required Output Structure

Produce a YAML spec conforming to `.ai/schemas/spec.json` (v1.1).

Validation profiles, rubric weights, invariants, and safety rules are defined in `.ai/config.yaml` - reference them, don't duplicate them here.

### Minimal Skeleton

```yaml
spec_version: "1.1"
task_id: "{kebab-case}"
created: "{ISO-8601}"
updated: "{ISO-8601}"
status: "draft"

task:
  title: "{short heading}"
  summary: "{2-3 sentence overview}"
  size: "micro | small | medium | large"
  risk_level: "low | medium | high"
  context:
    packages: ["src/module/...", "lib/..."]
    files_impacted:
      - path: "{relative path}"
        lines: "100-150" | [100,150] | "all"
        reason: "{why}"
    invariants: ["domain_boundaries", ...]
    related_docs: ["docs/...md"]
  objectives:
    - "{user goal}"
  scope:
    in_scope: ["..."]
    out_of_scope: ["..."]
  dependencies: ["..."]
  assumptions: ["..."]
  touchpoints:
    - area: "{system/component}"
      description: "{what changes here}"
  risks:
    - description: "{risk}"
      impact: medium
      mitigation: "{plan}"
  acceptance:
    validation_profile: "light | standard | strict"
    definition_of_done:
      - id: dod1
        description: "{checklist item}"
        status: pending
    validation:
      - id: dod1
        type: documentation | compile | test | boundary | integration | security | custom
        description: "{how to verify}"
        command: "{optional shell command}"
        expected: "{optional expectation}"
  constraints:
    approvals_required: ["schema_change", ...]
    non_goals: ["{explicitly not doing}" ]
  info_sources: ["{links or files consulted}"]
  notes: "{decisions, trade-offs}"

planning_log:
  - timestamp: "{ISO-8601}"
    actor: "agent"
    summary: "{what changed/confirmed in this iteration}"

phases:
  - id: phase1
    name: "{phase name}"
    objective: "{outcome of this phase}"
    changes:
      - file: "{path}"
        action: create | update | delete | move
        lines: "all"
        content_spec: |
          {narrative of edits}
    acceptance_criteria:
      - id: ac1_1
        type: test | compile | boundary | documentation | custom | integration | security
        command: "{command if automated}"
        description: "{why this check proves success}"
        expected: "{result}"
    status: pending

rollback:
  strategy: per_phase | atomic | manual
  commands:
    phase1: "git checkout HEAD -- path"

self_eval, deviations, metadata remain as in earlier versions (fill null/defaults during planning).
```

---

## Building the `task` Block

- **Title & summary:** Mirror the user's words; make it obvious what problem we're solving.
- **Size & risk:** Use `size` (`micro/small/medium/large`) and `risk_level` (`low/medium/high`) to communicate how heavy the change is. This guides how much validation to run and how detailed phases should be.
- **Context:** Reference actual packages/files. Keep `invariants` list aligned with `.ai/config.yaml` canonical invariants.
- **Objectives & scope:** Distinguish what we're doing vs. explicitly not doing.
- **Touchpoints:** Enumerate major systems, adapters, modules, or docs affected. This is the anchor for later validation.
- **Risks/assumptions:** Capture blockers early; if an assumption is shaky, call it out and set `status: "under_review"`.
- **Acceptance:** Treat `definition_of_done` as the non-negotiable checklist (one object per item with `id`, `description`, and default `status: pending`). `validation` entries describe how each DoD item will be verified. Optionally set `acceptance.validation_profile` to choose a validation profile; otherwise, EXEC should derive a profile from `risk_level`.
- **Constraints:** Move any approval needs here. EXEC agents must pause if `task.constraints.approvals_required` intersects `safety.require_approval_for` in `.ai/config.yaml`.

---

## Phases & Acceptance Criteria

- Each phase should map cleanly to a touchpoint or cohesive concern.
- `changes[].content_spec` should read like a design note (functions, behaviors, docs sections).
- Every phase needs at least one acceptance criterion. Use deterministic commands when possible; fall back to `documentation`/`custom` with clear reviewer instructions.
- Keep rollbacks scoped per phase unless the plan demands atomicity.

---

## Planning Log

Record significant conversational turns:

- `summary` should capture what you agreed on (clarified scope, locked acceptance items, discovered dependency).
- If you made an assumption, log it and echo inside `task.assumptions`.
- Timestamps should be ISO-8601 (UTC). Use the order of discovery.

---

## Approval Guidance

- Ask for guidance only when you detect schema/migration/public API work. Otherwise, choose the best architecture-aligned approach and document the constraint in `task.constraints.approvals_required`.
- When explicitly punting on a higher-price option, capture the trade-off in `task.notes` or `scope.out_of_scope`.

---

## Final Checklist Before Output

- [ ] Spec validates against `.ai/schemas/spec.json` v1.1.
- [ ] `task_id` is unique (no clashes in `.ai/specs/**`).
- [ ] `task.touchpoints`, `task.acceptance.definition_of_done`, and `phases` tell the same story.
- [ ] Every assumption is documented; blockers set `status: "under_review"`.
- [ ] `planning_log` captures the major conversational steps.

---

## Optional Next Step

When planning is complete, the operator may run `scafld harden <task-id>` to interrogate the draft against grounded questions before approval. This step is optional and can be skipped by approving directly.

---

## Blocked Planning Template

If planning stops on missing info:

```
Warning: Planning blocked
  Reason: {cannot determine X without Y}
  Assumptions made:
    - {assumption 1}

Spec saved to: .ai/specs/drafts/{task-id}.yaml (status: under_review)
```

---

## Remember

- Co-create the plan with the user - confirm direction before finalizing.
- Capture **one** high-quality plan; no more option matrices.
- Keep architecture invariants front-of-mind.
- Optimize for execution clarity: another agent should be able to pick this up and ship without guessing.

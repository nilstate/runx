# scafld - Planning & Execution Framework

**Version:** 1.0

scafld is a spec-driven framework for AI agent task planning and execution. Every task becomes a machine-readable YAML specification that flows through a defined lifecycle: plan, approve, execute, archive.

---

## How It Works

1. **Plan:** AI generates a task spec in `.ai/specs/drafts/` via conversational ReAct loop
2. **Approve:** Developer reviews and moves spec to `.ai/specs/approved/`
3. **Execute:** AI picks up the approved spec, executes phases, validates at each checkpoint
4. **Review:** Adversarial review finds what execution missed — `scafld review` runs the configured `spec_compliance` and `scope_drift` checks, scaffolds Review Artifact v3, and prepares the adversarial `regression_hunt`, `convention_check`, and `dark_patterns` passes in the latest round
5. **Archive:** Completed specs move to `.ai/specs/archive/YYYY-MM/` with truthful review results recorded, or a human-reviewed override audited explicitly when the gate is blocked

The approval gate is the human oversight boundary. The review gate is the quality boundary. During execution, the agent operates autonomously through all phases, pausing only when blocked or deviating from the spec. A normal completion path still stays agent-driven; the human-reviewed override is an exceptional audited escape hatch, not the default workflow.

The default review topology lives in `config.yaml` and uses five ordered built-in passes: `spec_compliance`, `scope_drift`, `regression_hunt`, `convention_check`, and `dark_patterns`. Review Artifact v3 stores per-pass `pass_results`, reviewer provenance, and round status for that configured topology.

---

## Directory Structure

```
.ai/
├── README.md              # This file
├── config.yaml            # Global configuration (invariants, validation, rubric)
├── prompts/
│   ├── plan.md            # Planning mode instructions
│   ├── exec.md            # Execution mode instructions
│   └── review.md          # Adversarial review mode instructions
├── reviews/               # Review findings per spec (gitignored)
├── schemas/
│   └── spec.json          # JSON schema for task specifications
├── specs/                 # Task specs organized by lifecycle status
│   ├── README.md          # Spec workflow and naming conventions
│   ├── drafts/            # status: draft | under_review
│   ├── approved/          # status: approved
│   ├── active/            # status: in_progress
│   └── archive/YYYY-MM/   # status: completed | failed | cancelled
├── playbooks/             # Reusable workflow templates (optional)
└── logs/                  # Execution logs (optional, supplementary)
```

---

## Key Files

| File | Purpose |
|------|---------|
| `config.yaml` | Invariants, validation profiles, rubric weights, safety rules |
| `prompts/plan.md` | System prompt for planning mode agents |
| `prompts/exec.md` | System prompt for execution mode agents |
| `prompts/review.md` | System prompt for adversarial review mode |
| `schemas/spec.json` | JSON schema for spec validation |
| `specs/README.md` | Spec directory structure, naming, and workflow |

---

## Related Docs

- [AGENTS.md](../AGENTS.md) - High-level AI agent policies
- [OPERATORS.md](OPERATORS.md) - Human-facing cheat sheet for working with specs
- [CONVENTIONS.md](../CONVENTIONS.md) - Coding standards and patterns

---

## License

MIT License - Free to use, modify, and distribute.

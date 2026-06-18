# Operator Skills

Operator skills are the agent-facing control layer for running a project,
tenant, or product through runx. They are not a second CLI and not a second
backend. They turn evidence into a bounded plan, name the existing governed lane
that should execute, require the right approval, and verify the result.

## Boundary

```text
projection/context -> operator skill -> governed lane -> existing interface -> receipt -> readback
```

The CLI, hosted API, GitHub workflow, or provider tool remains the execution
interface. The operator skill supplies judgment and governance:

- inspect state and classify risk;
- decide whether the request is read-only, proposal-only, or consequential;
- choose the smallest existing lane;
- prepare approval copy;
- hand off to the existing command, workflow, API, or skill runner;
- verify the outside world after execution.

Do not reimplement CLI behavior inside a skill. If an operation is easier by
shelling out directly, the skill should name that existing command or workflow
as the deterministic execution step. If the command is awkward, fix the CLI.

## Project Skill Pattern

A project operator skill uses runx the right way:

- the project skill carries product vocabulary, voice, review rules, and
  procedure;
- Graph runners let the model author a line, verdict, or draft.
- Deterministic steps perform the board mutation.
- The receipt seals the domain act: target, authority, decision, reason, and
  effect.

Project-owned operator skills should copy that shape. Keep tenant vocabulary and
policy in the tenant skill or project profile. Keep OSS skills generic and
consume them from the project skill.

## Project Profiles

A project profile describes project topology, not new implementation logic. It
may name:

- release lanes and expected artifacts;
- hosted endpoints and health checks;
- registry targets;
- provider accounts by redacted ref;
- verification URLs;
- approval gates;
- existing commands or workflow ids.

It must not duplicate the CLI, provider SDK, deploy logic, or registry publish
logic. Profiles tell an operator skill what already exists and how success is
verified.

## Dogfood Contract

Projects should operate themselves through the same surfaces they ship:

- use `release` for release preparation, approval, publication handoff, and
  verification;
- use `ledger` and receipt skills for proof and after-action review;
- use `send-as` for live communications;
- use provider/branded skills for provider-specific work;
- use project-owned operator skills as the desk that diagnoses, routes, and
  verifies.

Every consequential self-operation should produce a receipt or name why it cannot
yet be receipt-backed. Private project topology stays in the project skill or
profile, not in OSS.

## Generic Operator Skill

The generic operator shape is:

- summarize the projected state;
- find drift, risk, missing evidence, and blocked lanes;
- propose one bounded action;
- decide whether the proposed action is sufficiently bounded;
- check the receipt/effect/readback after the action.

Execution belongs to the named lane. For example, a release proposal should
point at `release` plus the existing GitHub Actions release workflow and release
verification commands; it should not contain a custom release implementation.

## Add A Project Operator Skill Only When

- the project has real domain vocabulary or policy the generic desk should not
  own;
- a recurring operator workflow needs rich context;
- the skill can route to governed lanes rather than raw side effects;
- receipts can prove the action that matters.

Do not add a new operator skill for a dashboard button, one-off shell script, or
provider wrapper that already belongs in a domain skill.

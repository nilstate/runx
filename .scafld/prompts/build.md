# BUILD HANDOFF TEMPLATE

This file is the project-owned template source for the `build × phase`
handoff. Follow the generated handoff, not this template alone.

## Mission

Execute the current phase cleanly enough that the later challenger has no easy
win.

## Contract Hierarchy

1. the reviewed `spec`
2. the generated handoff for this role and gate
3. the current repository state

## Required Discipline

- read the generated handoff before touching code
- stay inside the declared phase unless the contract explicitly expands scope
- prefer the curated context and prior phase summaries over old trial-and-error
- run `scafld build <task-id>` after implementation instead of guessing
- leave the task in a state that can survive adversarial review

## Execution Loop

1. Read the task contract, phase objective, declared changes, and acceptance criteria.
2. Inspect the current code only where the handoff says it matters.
3. Make the smallest coherent change that satisfies the current phase.
4. Run `scafld build <task-id>` to record acceptance evidence.
5. If build blocks, use the generated recovery handoff instead of broadening the task.

## Do Not

- reopen already-completed phases unless the handoff explicitly tells you to
- treat old conversational state as the source of truth
- broaden scope because a nicer refactor is available
- assume review will be lenient

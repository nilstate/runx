---
name: skill-lab
description: Turn one bounded skill opportunity into a concrete proposal packet with explicit approval before packaging.
---

# Skill Lab

Turn one bounded opportunity into a concrete skill proposal.

`skill-lab` is the public chain that packages the internal builder stack into
one reviewable surface. It does not hide the builder capabilities; it composes
them into one governed proposal flow:

`work-plan` -> `prior-art` -> `write-harness` -> `draft-content`

Use it when the real output is not code yet, but a candidate skill package and
proposal packet that a maintainer can review, amend, approve, or reject.

The chain is intentionally honest about the boundary:

- it designs the candidate skill
- it drafts the proposal in maintainer-facing language
- it requires explicit approval before the proposal is packaged for handoff

Proposal quality is part of the contract, not a later editorial pass. The
proposal should:

- read like a first-party runx skill or chain proposal, not a builder trace
- identify the concrete pain point being addressed
- explain fit against the current runx catalog
- say when the right answer is an amendment to Sourcey, `draft-content`, an
  existing skill, or an existing chain instead of a new skill
- describe the concrete artifact a maintainer would ship or use
- keep issue-thread evidence and approval mechanics as provenance, not proposal
  prose
- surface the remaining maintainer decisions cleanly
- avoid builder-source framing such as "supplied work-plan", "supplied
  catalog", "supplied decomposition", "agent output", or "model output"
- write catalog fit from the maintainer's point of view: name the adjacent
  skill or chain and the boundary directly
- never use `supplied` or `envelope` in proposal prose; if provenance is thin,
  say what source was unavailable in plain maintainer language

It does not silently open PRs, mutate external repos, or imply that a proposed
skill is already accepted. Those outward moves belong to provider-bound lanes
such as `aster`'s live issue-ledger flow.

## Inputs

- `objective` (required): the capability to propose.
- `project_context` (optional): repo, product, or operator context that
  constrains the proposal.
- `thread_title` (optional): original thread title when the proposal comes
  from an issue, chat, ticket, or other work thread.
- `thread_body` (optional): original thread body or request text.
- `thread_locator` (optional): canonical locator for the bounded thread.
- `thread` (optional): provider-backed thread for the source
  thread.
- `channel` (optional): proposal delivery channel; defaults to
  `skill-proposal`.
- `operator_context` (optional): maintainer posture, constraints, or teaching
  notes that should shape the proposal.

## Outputs

- `work_plan`: bounded decomposition for the candidate capability.
- `prior_art_report`: verified findings and risks that constrain the design.
- `skill_design_packet`: candidate skill spec, execution plan, harness
  fixtures, and acceptance checks.
- `content_draft_packet`: maintainer-facing proposal draft.
- `content_publish_packet`: packaged proposal after approval.

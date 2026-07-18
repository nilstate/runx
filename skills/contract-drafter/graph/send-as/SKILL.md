---
name: send-as
description: Package-local executable projection of the shipped runx/send-as planning contract for deterministic mock provider delivery.
runx:
  category: ops
---

# Send As Mock Provider Plan

This package-local graph dependency mirrors the public `runx/send-as` planning
contract for `contract-drafter` registry runs. It exists because a published
registry package must carry the executable dependency it composes; the upstream
`send-as` default runner is an agent-task authority planner and would otherwise
pause a non-interactive dogfood run.

The runner emits a `runx.send_as.plan.v1` packet with the same authority fields
used by the shipped `send-as` skill: principal, provider, class, channel,
audience, content, gates, blockers, provider actions, evidence refs, and success
checkpoint. It does not contact a real provider. The parent `contract-drafter`
graph must consume this plan through its deterministic mock review-queue
adapter before sealing.

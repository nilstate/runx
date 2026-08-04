---
name: issue-to-pr-push-outbox-provider
version: 0.1.1
description: Internal GitHub provider boundary for a prepared issue-to-PR outbox push.
runx:
  category: code
---
# Issue-to-PR Outbox Provider

Internal provider child for the prepared `issue-to-pr-push-outbox` graph. Use
the parent skill so the mutation is visible in operator context and bound to an
approval digest.

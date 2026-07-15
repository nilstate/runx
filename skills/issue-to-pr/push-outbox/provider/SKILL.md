---
name: issue-to-pr-push-outbox-provider
version: 0.1.0
description: Internal GitHub provider boundary for a prepared issue-to-PR outbox push.
runx:
  category: code
source:
  type: thread-outbox-provider
  thread_outbox_provider:
    operation: push
    manifest_path: manifest.json
---
# Issue-to-PR Outbox Provider

Internal provider child for the prepared `issue-to-pr-push-outbox` graph. Use
the parent skill so the mutation is visible in operator context and bound to an
approval digest.

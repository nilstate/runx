---
name: issue-to-pr-push-outbox
version: 0.1.1
description: Publish issue-to-PR outbox entries through the governed Rust thread-outbox-provider front.
runx:
  category: code
---
# Issue-to-PR Outbox Publisher

Publishes issue-to-PR outbox entries through the governed Rust provider front.
The public runner is a one-step graph so `runx skill` can prepare, show, and
digest-bind the mutation before execution. Its internal provider child
constructs the provider frame from graph inputs and supervises the provider
process, credential delivery, redaction, and sealed observation.

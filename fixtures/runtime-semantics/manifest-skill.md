---
name: manifest-runtime-semantics
description: Fixture skill that projects optional execution hints into the runtime contract.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
inputs:
  message:
    type: string
    required: true
execution:
  disposition: observing
  outcome_state: pending
  input_context:
    capture: true
    max_bytes: 128
  surface_refs:
    - type: issue
      uri: github://owner/repo/issues/77
---

Fixture skill used to prove that manifests can project optional execution hints
without becoming the source of truth for runtime semantics.

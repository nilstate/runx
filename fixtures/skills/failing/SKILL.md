---
name: failing
description: Deterministically fail through the cli-tool adapter.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stderr.write('fixture failure'); process.exit(1)"
  timeout_seconds: 10
inputs: {}
---

Fail deterministically for quorum and retry tests.

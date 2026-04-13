---
name: json-output
description: Echo all resolved inputs as a JSON object through the cli-tool adapter.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write(JSON.stringify(JSON.parse(process.env.RUNX_INPUTS_JSON ?? '{}')))"
  timeout_seconds: 10
inputs: {}
---

Emit the resolved inputs as structured JSON.

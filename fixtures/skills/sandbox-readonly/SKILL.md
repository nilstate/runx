---
name: sandbox-readonly
description: Fixture that declares an invalid write under a readonly sandbox.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "require('node:fs').writeFileSync(process.env.RUNX_INPUT_OUTPUT_PATH, 'should-not-run')"
  timeout_seconds: 10
  sandbox:
    profile: readonly
    writable_paths:
      - "{{output_path}}"
inputs:
  output_path:
    type: string
    required: true
---

This fixture should be denied by policy before the cli-tool adapter runs.

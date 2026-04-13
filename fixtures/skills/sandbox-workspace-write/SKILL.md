---
name: sandbox-workspace-write
description: Fixture that writes to an explicitly declared output path.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "require('node:fs').writeFileSync(process.env.RUNX_INPUT_OUTPUT_PATH, 'sandbox-ok'); process.stdout.write('sandbox-ok')"
  timeout_seconds: 10
  sandbox:
    profile: workspace-write
    env_allowlist:
      - PATH
    writable_paths:
      - "{{output_path}}"
inputs:
  output_path:
    type: string
    required: true
---

This fixture records the local sandbox profile in the receipt metadata.

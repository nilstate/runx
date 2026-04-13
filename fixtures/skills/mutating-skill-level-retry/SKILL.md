---
name: mutating-skill-level-retry
description: Mutating skill with retry metadata declared on the skill.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE ?? '')"
  timeout_seconds: 10
retry:
  max_attempts: 2
risk:
  mutating: true
inputs:
  message:
    type: string
    required: true
---

Mutating skill with skill-level retry metadata.

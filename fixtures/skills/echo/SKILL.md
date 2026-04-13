---
name: echo
description: Echo a message through the cli-tool adapter.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE ?? '')"
  timeout_seconds: 10
inputs:
  message:
    type: string
    required: true
    description: Message to echo
runx:
  input_resolution:
    required:
      - message
---

Echo the provided message.

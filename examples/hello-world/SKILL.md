---
name: hello-world
description: Echo a first runx message through a checked-in cli-tool script.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  message:
    type: string
    required: true
    description: Message to print from the example skill.
runx:
  input_resolution:
    required:
      - message
---

Print one message so a new contributor can verify the local runx execution path.

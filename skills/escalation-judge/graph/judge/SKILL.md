---
name: escalation-judge-decision
version: 0.1.0
description: Deterministically evaluate a support escalation policy without sending or posting anything.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
---

Internal deterministic decision runner for `escalation-judge`. Use the public
parent skill rather than invoking this package directly.


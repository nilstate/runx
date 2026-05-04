---
name: scafld-native-smoke
description: Prove the hosted scafld binary through the native v2 lifecycle.
source:
  type: cli-tool
  command: node
  args:
    - ./run.mjs
  timeout_seconds: 60
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  task_id:
    type: string
    required: false
    description: Optional scafld task id for the smoke workspace.
  title:
    type: string
    required: false
    description: Optional task title.
  scafld_bin:
    type: string
    required: false
    description: Explicit scafld executable path; defaults to SCAFLD_BIN.
---

Run a temporary scafld v2 workspace and prove the installed binary can create,
validate, approve, build, inspect, and hand off a task.

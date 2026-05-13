---
name: reviewer-boundary
description: Test-only explicit agent-task boundary fixture.
source:
  type: agent-task
  agent: codex
  task: review-boundary
  outputs:
    verdict: string
inputs:
  prompt:
    type: string
    required: true
---
Review the prompt and return a structured verdict.

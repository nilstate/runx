---
name: reviewer-boundary
description: Test-only explicit agent-step boundary fixture.
source:
  type: agent-step
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

---
name: mcp-echo
description: Echo a message through a local MCP stdio fixture server.
source:
  type: mcp
  server:
    command: node
    args:
      - --import
      - tsx
      - packages/harness/src/mcp-fixture.ts
    cwd: ../../..
  tool: echo
  arguments:
    message: "{{message}}"
  timeout_seconds: 15
inputs:
  message:
    type: string
    required: true
    description: Message to echo through MCP
runx:
  input_resolution:
    required:
      - message
---

Echo the provided message through a local MCP server fixture.

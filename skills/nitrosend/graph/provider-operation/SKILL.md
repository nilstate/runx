---
name: nitrosend-provider-operation
description: Execute one bounded Nitrosend MCP operation through Runx native HTTP.
runx:
  category: communications
---

# Nitrosend provider operation

Internal graph stage for the public `nitrosend` skill. It owns only the
Nitrosend operation allowlist, argument validation, MCP request mapping, and
provider-result projection. Runx native HTTP owns transport, credential
delivery, destination admission, response limits, retries, and secret
redaction.

Do not call this stage as an operator entrypoint. Use `nitrosend`.

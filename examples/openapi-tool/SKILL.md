---
name: openapi-adapter
description: External-adapter sub-skill; turns an OpenAPI operation into a sealed tool result.
---
An OpenAPI front, expressed as an external adapter. The adapter reads a
checked-in OpenAPI spec (`openapi.json`), resolves the requested operation,
validates parameters against the spec, performs the adapter-owned HTTP call, and seals
the response. The network leg lives on the adapter, the supervised side of the
boundary; when the endpoint is unreachable (the bare harness, no fixture server)
it falls back to the resolved request so the example still runs offline. This
proves the governed core runs from an external spec, not only from MCP: the same
`external-adapter` lane carries any protocol.

`examples/openapi-graph/run.sh` starts a local fixture endpoint and shows the real
response sealed into the receipt. external-adapter is a graph-step front, not a
top-level runner.

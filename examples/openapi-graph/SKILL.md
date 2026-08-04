---
name: openapi-graph
description: OpenAPI front example; a graph whose step turns an OpenAPI operation into a sealed tool result.
---
# OpenAPI graph

A single-step graph that drives the OpenAPI external-adapter sub-skill. The
runtime routes the graph step's `external-adapter` source through the
source-adapter registry to the external-adapter executor, which spawns the
declared adapter process. The adapter resolves an OpenAPI operation
into a concrete HTTP request and the runtime seals it. Its manifest declares a
required network scope because the adapter performs the outbound fetch.

This is the concrete proof that the core runs from other specs, not just MCP.
Run `examples/openapi-graph/run.sh` to start the local fixture endpoint and fail
hard unless the graph state proves the GET executed and returned the expected
pet payload, and the receipt directory contains a signed `runx.receipt.v1`.

The inline harness case expects that fixture endpoint to be running. Use
`run.sh` for the hermetic demo entrypoint; bare `runx harness
examples/openapi-graph` is only useful after starting `server.mjs` separately.

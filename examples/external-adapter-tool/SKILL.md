---
name: external-adapter-echo
description: External-adapter sub-skill; a governed subprocess adapter that echoes its inputs.
---
A minimal external adapter (`runx.external_adapter.v1`). The runtime resolves the
manifest, spawns the declared trusted host subprocess, delivers its resolved
grant, hands it the invocation over stdio, and seals the adapter's reported
result. The process is not an OS confinement boundary. Run it as a step in a
graph (the external-adapter source is a graph-step front, not a top-level
runner).

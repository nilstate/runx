---
name: external-adapter-graph
description: External-adapter front example; a graph whose step runs a governed subprocess adapter.
---
# External-adapter graph

A single-step graph that drives an external-adapter sub-skill. The runtime routes
the graph step's `external-adapter` source through the source-adapter registry to
the external-adapter executor, which resolves the manifest, spawns the declared
trusted host subprocess, delivers its resolved grant, exchanges the invocation
and response frames, and seals the reported result. The process is not an OS
confinement boundary.

External-adapter is a graph-step front, not a top-level runner. Run this skill's
inline harness with `runx harness examples/external-adapter-graph`.

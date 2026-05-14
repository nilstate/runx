# Skill To Graph

Start with [Getting Started](./getting-started.md). This page takes the same
`examples/hello-world` skill and composes it into a two-step graph.

## Graph Shape

The example graph lives at `examples/hello-graph/graph.yaml`:

```yaml
name: hello-graph
owner: runx
steps:
  - id: first
    skill: ../hello-world
    inputs:
      message: hello from graph
  - id: second
    skill: ../hello-world
    context:
      message: first.stdout
```

The first step runs the skill with an explicit input. The second step reads the
first step's `stdout` and passes it as the next `message` input. The graph
receipt links both step receipts, so inspection can show what ran and how the
steps connected.

## Run The Harness

Use the graph harness as the executable contract:

```bash
cd oss
pnpm exec runx harness examples/hello-graph/harness.yaml --json
```

The harness expects a successful `graph_execution` receipt and the ordered
steps `first`, then `second`.

## When To Use A Graph

Use a single skill when one bounded operation can produce the result. Use a
graph when the work has explicit phases, when a later step should consume a
previous receipt-backed output, or when approval/revision boundaries need to be
visible in the execution record.

Graphs should stay small enough to review. If the graph is carrying hidden
policy decisions, split the policy into the skill profile or a separate
governed step instead of burying it in prose.

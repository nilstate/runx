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

Graph steps may also execute a cataloged skill from the local registry:

```yaml
steps:
  - id: build_docs
    skill: registry:runx/sourcey@1.0.0
    runner: sourcey
    inputs:
      objective: refresh the public docs
```

Executable registry refs are explicit (`registry:...`, `runx-registry:...`, or
`runx://skill/...`) and resolve only from `RUNX_REGISTRY_DIR`. Graph execution
does not fetch remote registry content implicitly; the operator must install,
publish, or sync the skill into the local registry first. At runtime runx
materializes the resolved `SKILL.md` and optional `X.yaml` into
`.runx/registry-step-skills/` as a generated cache, then executes the normal
skill runner path against that materialized package.

## Skill Context For Agents

Agent steps can also ask for whole skills as context without executing those
skills. Use `context_skills` when a downstream agent should read a reusable
capability, guideline, rubric, or operating procedure as part of its prompt
context:

```yaml
steps:
  - id: apply_taste
    run:
      type: agent-task
      agent: builder
      task: apply taste guidance
      outputs:
        summary: string
    context_skills:
      - taste-profile
      - registry:runx/taste-profile@1.0.0
```

Each entry becomes a `runx.skill.context` artifact in the agent invocation's
generic `current_context` array. The artifact carries the source ref, skill
name, digest, and `SKILL.md` content. It does not create a domain schema for the
skill; the skill remains an abstract context/capability document.

Local path refs resolve relative to the graph skill directory and must stay
inside the owning skill root. Use registry refs for cataloged skills shared
across skill roots. Registry refs use the local registry (`RUNX_REGISTRY_DIR`)
and must be explicit (`registry:...`, `runx-registry:...`, or
`runx://skill/...`). Graph execution does not fetch remote registry content
implicitly; install or ingest the skill first, then reference the local registry.

The gates are intentionally narrow:

- `context_skills` is accepted only on direct `agent-task` steps or nested skills
  and stages that resolve to `agent`/`agent-task`.
- Local refs must be relative paths, must not contain `..`, must not target
  private graph stages under `skills/<name>/graph/<stage>/`, and must contain a
  valid `SKILL.md`.
- A context skill with an `X.yaml` catalog entry cannot use an implementation-only
  role (`graph-stage`, `runtime-path`, or `harness-fixture`).
  Internal catalog entries are context-loadable only when they explicitly declare
  `catalog.role: context`.
- Registry refs resolve only from the configured local registry.
- Each context skill is capped at 64 KiB, the step is capped at 12 context
  skills, and total resolved skill context is capped at 256 KiB.
- Duplicate context refs are rejected.
- Every context artifact is digest-bound and labeled
  `security_boundary: untrusted-agent-context`.
- Native managed-agent execution passes the artifacts to the provider with an
  explicit instruction that context artifacts are advisory data, not system
  instructions or authority to change tools, reveal secrets, or bypass policy.

## Run The Harness

Use the graph harness as the executable contract:

```bash
cd oss
cargo build --manifest-path crates/Cargo.toml -p runx-cli
crates/target/debug/runx harness examples/hello-graph/harness.yaml --json
```

The harness expects a sealed `runx.receipt.v1` receipt and the ordered
steps `first`, then `second`.

## When To Use A Graph

Use a single skill when one bounded operation can produce the result. Use a
graph when the work has explicit phases, when a later step should consume a
previous receipt-backed output, or when approval/revision boundaries need to be
visible in the execution record.

Graphs should stay small enough to review. If the graph is carrying hidden
policy decisions, split the policy into the skill profile or a separate
governed step instead of burying it in prose.

For long-running agent workflows, do not turn a graph into an unbounded resident
loop. Use [Loop Orchestration](./loop-orchestration.md): an outer loop host
submits one governed runx turn at a time, reads receipts and projections, and
continues only when explicit stop policy allows.

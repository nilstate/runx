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

A single `agent-task` runner is one bounded managed-agent act. It carries its own
`instructions` and `allowed_tools`, runs the configured provider, and seals one
receipt; not everything needs a graph. Reach for one when a single model run
produces the result.

Reach for a graph when the work has explicit phases, when a later step consumes
an earlier step's receipt-backed output, or when approval and revision boundaries
need to be visible in the execution record.

The line between them is not how many model calls there are; it is **what must be
guaranteed**. The model is for judgment and authoring, never for guaranteeing a
side effect: an agent handed a mutating tool may narrate the action ("done,
claimed it") instead of calling it. So an action that *must* happen, a mutation,
an API call, a payment, belongs in a deterministic step (`tool:`, `http:`, or
`skill:`), not in an agent's `allowed_tools` where the call is optional. The
governed shape is a graph where an agent step authors or decides and the next
deterministic step performs the act; one receipt seals both. An agent step inside
a graph runs the configured provider inline, the same as a top-level `agent-task`
runner (with no provider configured it yields `needs_agent` to the host instead).

Graphs should stay small enough to review. If the graph is carrying hidden
policy decisions, split the policy into the skill profile or a separate
governed step instead of burying it in prose.

For long-running agent workflows, do not turn a graph into an unbounded resident
loop. Use [Loop Orchestration](./loop-orchestration.md): an outer loop host
submits one governed runx turn at a time, reads receipts and projections, and
continues only when explicit stop policy allows.

## Domain Receipts: The `act:` Declaration

By default a receipt records that a step ran. A runner can instead declare an
`act:` block so the sealed receipt reads as the **domain act** it performed: what
was decided, on what, under what authority, with what effect, and what it follows.

The discipline is a trust boundary. The model authors only the human reason; the
structure and authority come from the declaration plus trusted inputs, never from
the model, so it cannot forge what kind of act happened, what it targeted, or
under what right. A run that declares no `act:` block seals exactly as before.

Each field maps to a trusted source, a literal or driver-pinned from an input
(`<field>_from: <input>`):

```yaml
runners:
  approve:
    type: agent-task            # or a graph; see below
    act:
      form_from: act_form        # review | revision | reply | observation | verification
      purpose_from: act_purpose  # what this act is
      target_from: target_ref    # the entity acted on (a ref uri)
      decision_from: decision    # accept | reject | continue | ... -> the receipt decision
      authority_from: authority  # the right exercised (a grant ref)
      actor_from: actor          # who acted (a principal ref)
      reason_from: note          # the agent's authored line -> the act summary
      previous_from: prior       # the receipt this one chains from (lineage)
```

For a **graph**, the reason and effect come from steps, not the agent's final
answer, so the effect is read from the deterministic action step's real result,
never the model's restatement of it:

```yaml
    act:
      reason_step: decide        # the agent step whose output holds the reason
      reason_from: line          # the field in that step's output
      effect_step: act           # the deterministic action step
      effect_from: id            # the field of its result that is the consequence id
      effect_prefix_from: ns     # wraps it, e.g. ticket: -> ticket:<id>
      # form/purpose/target/decision/authority/actor as above
```

Transport never enters the receipt: the tool name, url, status, and any token
stay out; only the domain act and its effect ref are sealed. See
[the act model](./act-model-reconciliation.md) for the receipt's act/decision
shape.

## HTTP Steps And Credentials

A graph step, or a top-level skill source, can be a governed HTTP call: declare
`source.type: http` with the `url`, `method`, and `headers`. A **header** value
may reference a delivered secret with `${secret:NAME}`; it is injected at the
boundary and never reaches the model or the receipt (secret substitution applies
to headers, not the request body, so put auth in a header, not a body field). The
URL's `{placeholder}` path segments and the request body are filled from the
step's inputs. A `tool: ns.name` step resolves an `http` tool manifest from
`RUNX_TOOL_ROOTS`; the namespaced ref is required and is handled correctly when
offered to an inline agent.

Secrets are delivered per run, never baked into the skill or passed on argv:

```bash
runx skill <skill> \
  --credential <provider>:<auth_mode>:<material_ref>:<scope> \
  --secret-env NAME
```

`--secret-env NAME` names an environment variable to deliver as the secret;
`--credential`'s final segment is the scope, which must match the tool's declared
`scopes`. See `examples/byo-http-tool` and `examples/http-tool-catalog`.

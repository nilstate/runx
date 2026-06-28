<h1 align="center">runx</h1>

<p align="center"><strong>force multiplier for AI agents</strong></p>

<p align="center">Composable skill chains, governed authority, verifiable receipts.</p>

<p align="center">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@runxhq/cli"><img alt="npm @runxhq/cli" src="https://img.shields.io/npm/v/@runxhq/cli?style=flat-square&color=cb3837&label=%40runxhq%2Fcli"></a>
  <a href="https://github.com/runxhq/runx/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/runxhq/runx/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://runx.ai/x"><img alt="catalog" src="https://img.shields.io/badge/catalog-runx.ai%2Fx-ff2e88?style=flat-square"></a>
  <a href="https://runx.ai/spec"><img alt="spec" src="https://img.shields.io/badge/spec-read-7c5cff?style=flat-square"></a>
</p>

---

runx turns expertise into portable agent infrastructure. A skill is a
`SKILL.md` published at a URL; agents can pull it into their own environment,
compose it with other skills, and build chains of useful work without bespoke
glue code.

That power needs a boundary. runx admits each act under explicit authority,
delivers credentials without turning them into prompt material, runs the
declared profile, and seals the result into a receipt. Authority narrows through
the chain, so agent work can compound without becoming ambient trust.

```text
a skill is a URL.
a graph is what unfolds.
authority narrows. it does not pass through.
every act produces a receipt.
```

## quickstart

Install the CLI:

```bash
npm i -g @runxhq/cli
# or: curl -fsSL https://runx.ai/install | sh
```

Then choose how you want to run skills.

### agent path

Paste [runx.ai/SKILL.md](https://runx.ai/SKILL.md) into your agent. It teaches
the agent how to use the runx CLI, discover skills from the catalog at
[runx.ai/x](https://runx.ai/x), and return receipts.

```text
Use runx to plan and execute end-to-end business ops for my company.
Goal: prepare API v2 for launch.
Stop before sends, spend, merges, deploys, or publishing. Return receipts.
```

### CLI path

Run any catalog skill directly:

```bash
runx skill <skill-name> -i key=value --json
```

`business-ops` is one prebuilt skill for managing a business goal:

```bash
runx skill business-ops \
  -i signal="prepare API v2 for launch: docs, release, customer comms, issue-to-PR, spend review, and audit" \
  --json
```

![runx business ops execution trace](docs/assets/ops-fanout.svg)

The graph is the core shape: goal in, governed lanes out, receipts and approval
gates back. Real teams replace the demo lanes with private context, policies,
tools, and readbacks.

Some other examples:

```bash
# Docs/product engineering: plan, author, build, critique, and verify docs.
runx skill sourcey -i project=. --json

# Research/strategy: produce a governed decision brief.
runx skill deep-research-brief \
  -i objective="Which launch risks should we resolve first?" \
  --json

# Maintainer ops: draft a useful issue response.
runx skill issue-triage \
  -i issue_url=https://github.com/runxhq/runx/issues/241 \
  -i objective="Draft the next helpful maintainer response" \
  --json
```

For payment or spend lanes, inspect the skill before granting authority:

```bash
runx registry search payments
runx registry read runx/x402-pay@sha-008aef3f3b2e
```

## skills and execution profiles

A skill is expertise as a URL. It starts as a portable `SKILL.md`: prose for
the model and a human-readable contract for the operator. When the skill needs
deterministic runners, typed inputs, graph stages, receipt mapping, harness
cases, or governed side effects, it also carries an execution profile named
`X.yaml`.

```yaml
---
name: hello-world
description: Echo a first runx message through a checked-in cli-tool script.
source:
  type: cli-tool
  command: node
  args: [run.mjs]
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  message: { type: string, required: true }
runx:
  category: ops
---

Print one message so a new contributor can verify the local runx execution path.
```

`SKILL.md` is the capability. `X.yaml` is the execution profile. Keep the
profile explicit: runner wiring, typed inputs and outputs, tool/context refs,
authority and receipt mapping, side-effect posture, and harness cases. Do not
use it as a strategy document, private state file, target registry, copy deck,
or secret container.

Browse the public catalog at [runx.ai/x](https://runx.ai/x).

## graphs make acts composable

Graphs let one governed act consume the receipt-backed output of another:

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

The important boundary is not "how many model calls happened." The boundary is
what must be guaranteed. Agents are for judgment and authoring. Required
mutations, API calls, payments, and provider writes belong in deterministic
steps, where the runtime can admit the authority, perform the act, and seal the
result.

Use a graph when phases, approvals, or side effects need to be visible in the
execution record. Use one bounded skill run when a single act is enough.

See [docs/skill-to-graph.md](docs/skill-to-graph.md).

## authority without secret leakage

runx receipts explain the authority boundary without becoming a secret side
channel.

Public proof may include:

- requested scopes, granted scopes, grant id, and admission decision;
- provider, connection id, grant reference, and credential material hash;
- sandbox profile, declared enforcement, runtime enforcer, and approval result;
- redaction status and output hashes.

Public proof must not include:

- raw access tokens, refresh tokens, API keys, passwords, or client secrets;
- full private stdout or stderr bodies;
- ambient environment dumps;
- unchecked provider output bodies in public evidence.

Provider-permission effects fail closed unless the operator supplies explicit
grant evidence. Spend-class payment authority must carry aggregate caps, not
only per-call limits. `runx doctor authority --json` reports readiness without
printing secret values.

See [docs/security-authority-proof.md](docs/security-authority-proof.md).

## demos that prove boundaries

These demos are runnable from this repo and produce receipts:

| Demo | What it proves | Run |
| --- | --- | --- |
| `examples/hello-world` | Native CLI skill path, sealed receipt baseline | `runx harness examples/hello-world` |
| `skills/business-ops` | One business signal fans out through governed ops lanes and seals a graph receipt | `runx harness skills/business-ops` |
| `examples/github-mcp-hero` | Governed GitHub read succeeds, out-of-scope write is refused, denial receipt verifies | `sh examples/github-mcp-hero/run.sh` |
| `examples/http-graph` | Governed HTTP front call against a local fixture seals a receipt tree | `sh examples/http-graph/run.sh` |
| `examples/openapi-graph` | OpenAPI operation runs through the external-adapter lane and seals | `sh examples/openapi-graph/run.sh` |
| `examples/governed-spend/skills/overspend-refused` | Spend above authority is refused before rail execution | `runx harness examples/governed-spend/skills/overspend-refused` |
| `examples/loop-orchestration` | Bounded outer loop submits governed turns, prints receipt ids, and demonstrates refusal | `sh examples/loop-orchestration/run.sh` |

For deterministic payment dogfood without funded wallets or provider keys:

```bash
pnpm demos:check
```

See [docs/demos.md](docs/demos.md).

## what a receipt proves

A runx receipt is designed to answer the questions that matter after the agent
has moved on:

| Question | Receipt surface |
| --- | --- |
| What ran? | `subject`, skill ref, source type, runner metadata |
| Who or what admitted it? | `authority.actor_ref`, grant refs, authority proof refs |
| What was allowed? | requested scopes, granted scopes, sandbox policy, approval metadata |
| What happened? | act entries, output artifacts, exit status, closure summary |
| Can it be checked later? | content-addressed id, canonical digest, signature, lineage |
| Did secrets leak into proof? | redacted metadata, hashed material refs, banned raw credential bodies |

Shape, abbreviated:

```json
{
  "schema": "runx.receipt.v1",
  "subject": { "kind": "skill" },
  "authority": {
    "actor_ref": { "type": "principal", "uri": "runx:principal:local_runtime" },
    "grant_refs": []
  },
  "seal": {
    "disposition": "closed",
    "reason_code": "process_closed"
  },
  "lineage": {
    "parent": null,
    "children": []
  }
}
```

Offline verification recomputes the canonical body digest, checks the
content-addressed id, verifies signatures when trusted keys are configured, and
can walk receipt ancestry from a receipt store.

The receipt is not the product by itself. It is where authority, action,
evidence, and future learning meet in one verifiable object.

## governed execution invariant

Every governed execution passes through the same four stages:

```text
admit -> deliver credentials -> sandbox -> seal
```

| Stage | What runx protects |
| --- | --- |
| `admit` | Policy checks the requested act before any step handler runs. An unadmitted act never reaches execution. |
| `deliver credentials` | Secret material crosses only a structured delivery boundary. Receipts carry grant refs, public observations, and hashes, not tokens. |
| `sandbox` | The declared cwd, env, filesystem, network, and enforcement posture are resolved and recorded. Runs can fail closed when OS-level enforcement is required. |
| `seal` | The runtime writes a signed `runx.receipt.v1` record with subject, authority witness, outputs, lineage, and closure. |

## publish and trust

Community skills should be standalone packages: `SKILL.md`, optional `X.yaml`,
and only the files runx can consume. Publish locally first:

```bash
runx registry publish ./skills/<your-skill>/SKILL.md
```

Then publish to the hosted catalog when you want shared discovery:

```bash
runx login --for publish
runx registry publish ./skills/<your-skill>/SKILL.md --registry https://api.runx.ai
```

Hosted publishing reconstructs the submitted package, reruns the harness, rejects
failed cases, and stores immutable package digests. New rows start as
`community`; verification and evidence promote discovery. Publisher declaration
alone is not trust.

See [docs/publishing.md](docs/publishing.md).

## architecture

Rust owns the trusted local runtime path.

| Layer | Owner |
| --- | --- |
| policy, state machine, authority admission | `runx-core` |
| skill, graph, runner, and tool manifest parsing | `runx-parser` |
| canonical receipts, hashing, signatures, tree verification | `runx-receipts` |
| local runtime, adapters, sandbox planning, harness, registry, MCP, payment gates | `runx-runtime` |
| native binary | `runx-cli` |
| generated TypeScript contracts and npm wrapper | `@runxhq/contracts`, `@runxhq/cli` |

TypeScript remains for generated contracts, client wrappers, cloud/product
integrations, host adapters, authoring tooling, and helper SDKs. It must not be
a fallback executor for trusted local behavior.

See [docs/reference.md](docs/reference.md) and
[docs/rust-kernel-architecture.md](docs/rust-kernel-architecture.md).

## docs

| Read this | When you need |
| --- | --- |
| [getting started](docs/getting-started.md) | first skill, first receipt |
| [skill to graph](docs/skill-to-graph.md) | compose governed acts |
| [security authority proof](docs/security-authority-proof.md) | scope, credentials, grants, verification |
| [demos](docs/demos.md) | runnable proof paths |
| [publishing](docs/publishing.md) | local and hosted skill publishing |
| [reference](docs/reference.md) | CLI, crates, registry, receipts, extension protocols |
| [the spec](https://runx.ai/spec) | act model, receipt grammar, public contracts |
| [the catalog](https://runx.ai/x) | governed skills by URL |

## contributing

Setup, test selection, and sign-off rules are in
[CONTRIBUTING.md](CONTRIBUTING.md). Security policy:
[SECURITY.md](SECURITY.md). runx is MIT licensed; see [LICENSE](LICENSE).

---

<p align="center"><sub>built in Rust &middot; MIT &middot; <a href="https://runx.ai">runx.ai</a></sub></p>

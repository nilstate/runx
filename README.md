<h1 align="center">runx</h1>

<p align="center"><strong>the governed runtime for agent skills</strong></p>

<p align="center">expertise as a URL, run under the authority you grant, sealed in a receipt you can replay.</p>

<p align="center">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@runxhq/cli"><img alt="npm @runxhq/cli" src="https://img.shields.io/npm/v/@runxhq/cli?style=flat-square&color=cb3837&label=%40runxhq%2Fcli"></a>
  <a href="https://github.com/runxhq/runx/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/runxhq/runx/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://runx.ai/x"><img alt="catalog" src="https://img.shields.io/badge/catalog-runx.ai%2Fx-ff2e88?style=flat-square"></a>
  <a href="https://runx.ai/spec"><img alt="spec" src="https://img.shields.io/badge/spec-read-7c5cff?style=flat-square"></a>
</p>

---

Agents are getting capable faster than we can trust them. They write code, move money, and reach into production. The missing piece is not more intelligence. It is a way to hand an agent a capability and still answer for what it did with it.

runx is that layer. A skill is a `SKILL.md` you publish at a URL. Drop the URL into any agent and it runs in your environment, under the authority you grant, and every step seals into a signed receipt you can replay months later.

```text
a skill is a URL.
a graph is what unfolds.
authority narrows. it does not pass through.
every act produces a receipt.
```

## quickstart

```bash
npm i -g @runxhq/cli        # ships the native runx binary
```

Run the checked-in example and read its receipt. The signing key below is a public demo key, for local smoke tests only:

```bash
git clone https://github.com/runxhq/runx && cd runx/oss

export RUNX_RECEIPT_SIGN_KID=runx-demo-key
export RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=
export RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted
export RUNX_RECEIPT_DIR="$(mktemp -d)"

runx skill examples/hello-world --message "hello from runx" --json   # -> status: "sealed"
runx history                                                         # what ran, under what authority, with what result
```

Full walkthrough, including production signing keys, is in [docs/getting-started.md](docs/getting-started.md).

## a skill is a URL

A skill is one file: prose for the model, a typed execution profile for the runtime.

```yaml
---
name: hello-world
description: Echo a first runx message through a checked-in cli-tool script.
source:
  type: cli-tool
  command: node
  args: [run.mjs]
  sandbox:
    profile: readonly            # what it is allowed to touch
    cwd_policy: skill-directory
inputs:
  message: { type: string, required: true }
---

Print one message so a new contributor can verify the local runx execution path.
```

The prose tells the agent what to do. The frontmatter tells runx what it is allowed to do. Publish it and the URL is the skill. Browse the open catalog at [runx.ai/x](https://runx.ai/x).

## the model

Nine objects, one runtime. A run is a graph; every hop runs the same four steps, and authority only narrows as it descends.

- **skill**: expertise plus a typed execution profile.
- **graph**: skills calling skills. runx renders the topology from the skills themselves and scopes authority at every branch, with no orchestration layer to maintain.
- **bounds**: least privilege by default. Grants are explicit, and an over-scope request is refused before anything runs.
- **receipt**: every act is signed and linked into one reproducible record. The artifact a CISO accepts and a developer can replay.

The full grammar (the four-step hop, guards, conditional `when` branches, the act model) lives in the [spec](https://runx.ai/spec).

## three things you couldn't do before

- **expertise ships as a link.** A skill is a URL any agent can run in its own environment, under its own grants and approval gates.
- **graphs compose themselves.** One skill calls another, which calls a third. The topology comes from the skills, not from glue code you maintain.
- **receipts are proof.** Signed, linked, replayable. Reputation becomes something you verify instead of something you take on faith.

## run it yourself

runx is MIT and runs entirely in your environment. Your keys, your boundary; your data and network never leave your control. The trusted local runtime is Rust, with no hosted dependency for local execution:

```bash
cd oss && cargo build --manifest-path crates/Cargo.toml -p runx-cli
```

`@runxhq/cli` is the published distribution of that same binary.

## author and publish

```bash
runx new my-skill                         # scaffold a standalone skill package
npm create @runxhq/skill@latest my-skill  # or start from npm
```

Write the prose, declare the profile, run it locally, then publish from a public repo at [runx.ai/x/publish](https://runx.ai/x/publish) or with `runx login && runx registry publish`. This repo is the first-party lane for official skills and the runtime; community skills ship as standalone packages.

## docs

| | |
| --- | --- |
| [getting started](docs/getting-started.md) | install, first skill, first receipt |
| [skill to graph](docs/skill-to-graph.md) | compose skills into a governed graph |
| [the spec](https://runx.ai/spec) | the act model, the four-step hop, the grammar |
| [the catalog](https://runx.ai/x) | every governed skill, by URL |
| [architecture and reference](docs/reference.md) | crate topology, sandbox posture, tool authoring, the full surface |

## contributing

Setup, test selection, and sign-off rules are in [CONTRIBUTING.md](CONTRIBUTING.md). Security policy: [SECURITY.md](SECURITY.md). runx is MIT licensed; see [LICENSE](LICENSE).

---

<p align="center"><sub>built in Rust &middot; MIT &middot; <a href="https://runx.ai">runx.ai</a></sub></p>

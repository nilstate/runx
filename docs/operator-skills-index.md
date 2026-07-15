# Operator Skills Index

This page lists every operator-style skill that ships under `skills/`, grouped by lane, so new contributors can discover what already exists without grepping the directory tree.

For the project-skill **pattern** (how to author a new one, the dogfood contract, and the "Add A Project Operator Skill Only When" decision rule), see [docs/operator-skills.md](./operator-skills.md). For the registry search path and canonical category slugs, see [docs/skill-catalog.md](./skill-catalog.md).

---

## Core Operator Skills

These three skills are the canonical examples referenced in the operator-skill pattern doc. They dogfood the governed lifecycle end-to-end.

| Directory | Purpose |
|---|---|
| `release/` | Prepare, gate, publish, and verify a versioned release of a runx project through governed phases. |
| `ledger/` | Answer a cross-run audit question against the receipt ledger and produce a sealed finding. |
| `send-as/` | Govern a message or campaign send on behalf of a principal, with scoped egress and gating. |

## Agency & Operations

Skills that run a standing mandate, route work, or operate a project workspace.

| Directory | Purpose |
|---|---|
| `agency/` | Run a standing team with a mandate, advanced one governed case at a time. |
| `business-ops/` | Route one business signal through a replayable governed ops chain. |
| `ops-desk/` | Operate a project, workspace, or account from an agent or machine principal. |
| `policy-author/` | Turn a plain-English governance brief into one validated runx policy. |
| `messageboard/` | Govern a bounty-style messageboard from post through moderation. |
| `lead-router/` | Qualify a lead and route it to the right governed action. |
| `lead-enrichment/` | Enrich a lead from supplied account signals and produce a reviewable packet. |
| `knowledge-router/` | Route a question or source event to the right knowledge source. |
| `issue-intake/` | Turn a noisy inbound request into a bounded intake artifact. |
| `issue-triage/` | Discover, analyze, and draft high-signal issue-thread responses. |
| `issue-to-pr/` | Govern a scafld-backed issue-to-PR lane with native scafld receipts. |

## Governance & Audit

Skills that enforce policy, audit receipts, or review skill quality.

| Directory | Purpose |
|---|---|
| `audit-receipt/` | Audit a sealed runx receipt for governance, comparing the authority chain to the evidence. |
| `run-history/` | Produce a read-only report over runx's own run history, summarizing sealed runs. |
| `review-skill/` | Assess a skill package for capability, trust, and operator risk. |
| `review-receipt/` | Review receipts and harness failures to propose bounded skill improvements. |
| `improve-skill/` | Turn a failed receipt or harness outcome into a bounded skill improvement. |
| `least-privilege/` | Compare granted scopes against the scopes a subject actually used. |
| `sign-receipt/` | Prepare an evidence-bound attestation of an off-runtime act. |
| `reflect-digest/` | Aggregate projected reflect knowledge into bounded skill improvement proposals. |

## Content & Research

| Directory | Purpose |
|---|---|
| `content-pipeline/` | Research a topic, draft the content, and package the approved output. |
| `ghostwrite/` | Turn evidence and operator intent into publication-ready drafts. |
| `deep-research/` | Produce an approved deep-research brief from bounded research. |
| `ecosystem-brief/` | Produce an approved ecosystem briefing from bounded research. |
| `research/` | Produce bounded, source-backed research packets for product decisions. |
| `brand-voice/` | Build a scoped brand voice packet from source material. |
| `taste-profile/` | Build a scoped taste profile packet from examples and preferences. |
| `prior-art/` | Compare existing approaches, catalog surfaces, and domain patterns. |
| `sourcey/` | Generate documentation for a project using Sourcey. |

## Code & Dependency Security

| Directory | Purpose |
|---|---|
| `dependency-cve-audit/` | Audit locked npm dependencies against OSV advisories and emit findings. |
| `ecosystem-vuln-scan/` | Scan one dependency surface, draft the advisory, and package it. |
| `vuln-scan/` | Analyze dependency or ecosystem risk and produce remediation guidance. |
| `pr-review-note/` | Govern a GitHub PR review-note lane over MCP. |
| `sandbox-harden/` | Produce a least-privilege runtime hardening profile (seccomp, capabilities). |
| `redact-pii/` | Scrub personal data out of content before it crosses a trust boundary. |
| `vault-unseal/` | Plan a scoped, time-bounded unseal of a secret under explicit policy. |
| `governed-outbound/` | Gather an external source, scrub personal data, and publish governed output. |

## Payments & Settlement

Skills that model, charge, pay, or refund through payment providers. The `mock-*` lanes are deterministic test lanes; the `stripe-*` and `mpp-*` lanes run against live or sandbox providers.

### Mock Lanes (Test Only)

| Directory | Purpose |
|---|---|
| `mock-charge/` | Model provider-side charge verification through the deterministic mock graph. |
| `mock-pay/` | Run the deterministic mock payment graph from quote to sealed settlement. |
| `mock-refund/` | Model a same-family mock refund against a sealed charge receipt. |

### Provider Lanes

| Directory | Purpose |
|---|---|
| `charge/` | Govern one inbound provider-side paid tool call through pricing and receipt. |
| `spend/` | Execute one governed outbound payment across a selected runtime. |
| `refund/` | Govern one refund linked to a sealed original charge receipt. |
| `settle-invoice/` | Settle a known, approved invoice under a spend-bounded grant. |
| `stripe-charge/` | Model provider-side charge verification through the Stripe settlement graph. |
| `stripe-pay/` | Execute a governed Stripe Shared Payment Token spend by delegation. |
| `stripe-refund/` | Model a same-family Stripe refund against a sealed charge receipt. |
| `mpp-charge/` | Model provider-side charge verification through the MPP settlement graph. |
| `mpp-pay/` | Run the MPP payment graph from quote to sealed settlement proof. |
| `mpp-refund/` | Model a same-family MPP refund against a sealed charge receipt. |
| `x402-pay/` | Execute a governed x402 payment by delegating to the canonical x402 runtime. |

## Data & Infrastructure

| Directory | Purpose |
|---|---|
| `data-store/` | Govern provider-agnostic data reads and state transitions through a receipt. |
| `github-sync/` | Plan a scoped pull or push of GitHub issues, threads, or PRs. |
| `chief-of-staff/` | Convert mailbox and calendar context into a reviewable execution plan. |
| `n8n-handoff/` | Validate a runx execution context and hand off a governed payload to n8n. |
| `zapier-handoff/` | Validate a runx execution context and hand off a governed payload to Zapier. |
| `slack-notify/` | Plan a governed Slack notification under scoped egress and gating. |
| `web-fetch/` | Fetch and extract one web source within an explicit allowlist. |

## Communications & Campaigns

| Directory | Purpose |
|---|---|
| `nitrosend/` | Govern Nitrosend campaign, flow, transactional, audience, and send operations. |
| `dispute-respond/` | Prepare a governed dispute response artifact from a linked case. |
| `helpdesk/` | Classify a bounded support request and choose the safe next path. |

## Weather & External Data

| Directory | Purpose |
|---|---|
| `weather-forecast/` | Normalize provider weather evidence into an action-safe forecast. |
| `nws-weather-forecast/` | Fetch National Weather Service forecast evidence through the NWS API. |
| `open-meteo-weather-forecast/` | Resolve a place and fetch global forecast and air-quality evidence. |

## Skill Development & Testing

| Directory | Purpose |
|---|---|
| `skill-lab/` | Turn one bounded skill opportunity into a concrete proposal and scaffold. |
| `skill-testing/` | Evaluate a skill, draft the trust audit, and package the approval. |
| `write-harness/` | Draft replayable runx harness fixtures for a proposed skill. |
| `design-skill/` | Turn a product or automation objective into a bounded runx skill design. |
| `overlay/` | Wrap a borrowed Anthropic SKILL.md under a governed runx overlay. |
| `evolve/` | Governed repo evolution with fixed phase semantics and bounded changes. |
| `moltbook/` | Scan for posting opportunities and prepare governed Moltbook entries. |

## SQL & Structured Data

| Directory | Purpose |
|---|---|
| `sql-analyst/` | Turn a bounded data question, schema summary, and sample rows into findings. |
| `extract/` | Extract schema-validated JSON from messy HTML or text fixtures. |

## Planning & Work Management

| Directory | Purpose |
|---|---|
| `work-plan/` | Decompose a build objective into governed runx execution steps. |

---

## When to Add a New Operator Skill vs. Extending an Existing One

Refer to the ["Add A Project Operator Skill Only When"](./operator-skills.md) section in the operator-skills doc for the decision rule. In summary:

- **Add a new skill** when the work has a distinct lifecycle, its own evidence shape, or needs a separate trust boundary.
- **Extend an existing skill** when the new capability shares the same lifecycle phase, evidence type, and governance gate as an existing skill.
- **Mock lanes** (`mock-*`) should always be paired with their live counterpart — don't add a mock lane without a corresponding provider lane, and don't ship a provider lane without a deterministic mock.

## Mock vs. Live Lanes

Skills prefixed with `mock-` are deterministic test lanes that model the same payment graph as their live counterparts without touching real providers. They share the same receipt format and evidence structure. Use mock lanes for dogfooding, harness testing, and CI verification. Provider lanes (`stripe-*`, `mpp-*`, `x402-pay`) run against real or sandbox payment providers under governed spend caps.

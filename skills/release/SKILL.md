---
name: release
description: Prepare, gate, publish, and verify a versioned release of a package or project through a project-owned release profile.
runx:
  category: code
---

# Release

Turn a proposed release into an audited publication. The skill owns the release
decision process: evidence gathering, changelog preparation, approval, publish
handoff, verification, and announcement. It does not own a project's custom
release implementation. Project-specific topology lives in a release profile
that names existing commands, workflows, registries, deploy targets, and
verification readbacks.

Two runners:

- **`prepare`** (read-only) — survey the commit range since the last tag,
  classify commits, stage a changelog, run the declared checks, and emit a
  `release_brief` describing what would ship, what is blocked, and what
  remains unresolved. Safe to run unattended and in CI.
- **`release`** (default, graph) — wires `prepare` → approval gate →
  `publish` → `verify`. `publish` is not exposed as a standalone runner; it is
  only reachable inside the graph after the approval transition clears.

Invoke `runx skill release prepare` for a CI dry-run. Invoke
`runx skill release` to run the governed end-to-end flow.

## Phases

### prepare

The read-only phase. Reads git history, classifies each commit since the
previous semver tag (`feat`, `fix`, `refactor`, `chore`, `breaking`),
stages a changelog, reads the project release profile when supplied, and runs
the declared release checks. Emits a `release_brief` with the findings.

The brief is the only artifact that flows forward. If it is not
`publishable`, the graph stops at the approval gate with the reasons
attached.

### approve-publish

A typed approval step. The gate id is `release.publish.approval`. The
brief is provided as context so the approver sees what would ship before
deciding.

The policy transition only advances to `publish-release` when
`approve-publish.approval_decision.data.approved` is `true`. No back
channel, no implicit approval on timeout.

### publish-release

The destructive phase. Takes the approved `release_brief` from graph context and
hands off to the project-declared release interface: an existing CLI command,
GitHub Actions workflow, hosted API route, provider tool, or manual release
gate. Every side effect is recorded in `publish_report.side_effects[]` with its
locator and evidence; the graph receipt seals the trail.

Refuses to act if the brief is missing, unpublishable, or not carried
through the approval gate. Refuses to act if the project profile asks the agent
to reimplement release logic instead of naming an existing execution surface.

### verify-release

The proof phase. Reads the `publish_report`, release brief, and project profile,
then verifies external state: registry versions, release assets, deploy health,
site/changelog readbacks, package-manager manifests, or any other project-owned
release acceptance criteria. Emits a `release_report` for operator review and
public audit.

## Quality Profile

- Purpose: turn release evidence into an audited publish/no-publish decision
  and, after approval, a versioned release.
- Audience: maintainers, package consumers, and operators reviewing the release
  trail.
- Artifact contract: release brief, changelog, check results, unresolved flags,
  approval decision, publish report, verification report, and announcement
  packet.
- Evidence bar: changelog and version claims must trace to commits, tags,
  checks, package metadata, or explicit operator context.
- Voice bar: release writing should be concrete and user-facing. Do not pad
  with generic launch language or hide blockers behind positive wording.
- Strategic bar: the release should explain why this version matters and what
  users should do next.
- Stop conditions: stop at prepare or approval when checks fail, versioning is
  unclear, changelog evidence is thin, or the announcement would overstate the
  release.

## Inputs

| Name | Required | Description |
|---|---|---|
| `project_root` | yes | Absolute path to the project being released. |
| `channel` | yes | Publishing target (`npm`, `pypi`, `github-release`). |
| `profile_ref` | no | Path or registry ref for a project-owned release profile. The profile describes existing commands/workflows and verification expectations; it is not authority. |
| `last_tag` | no | Previous release anchor. Defaults to the latest semver tag reachable from the current branch. |
| `operator_context` | no | Cadence, campaign, or posture guidance for this release. |

## Outputs

- `prepare` emits `release_brief_packet` carrying `release_brief`:
  changelog, check results, proposed version, unresolved flags,
  publishable verdict.
- The graph emits a graph receipt that links the prepare brief, the
  approval decision, publish report, and verification report into one auditable
  trail.
- `publish-release` (inside the graph) emits `publish_report`: registry
  URL, release tag, announcement packet, and a `side_effects[]` list with
  a locator and evidence per write action.
- `verify-release` emits `release_report`: expected lanes, observed readbacks,
  missing artifacts, conditional skips, and final release verdict.

## Trust boundary

`prepare` is safe to run unattended and in CI. The destructive work is only
reachable through the graph, and the graph refuses to transition to
`publish-release` without an approved decision from `release.publish.approval`.
The graph enforces the gate; the skill does not bypass it.

Project profiles are context, not authority. A profile may say which workflow,
command, registry, or URL should be used. It cannot grant credentials, skip
approval, or authorize a destructive release by itself.

## Scopes

- `runx:release:read` — required by the prepare phase.
- `runx:release:publish` — required by the publish phase; the graph grant
  must include this only when the approval transition has cleared.
- `runx:release:verify` — required by the verification phase.

## Tasks

- `release-prepare` — the read-only phase task. Provides the
  `release_brief` output shape.
- `release-publish` — the destructive phase task. Only reachable inside
  the graph; requires the approved brief in context.
- `release-verify` — the proof phase task. Reads external state and reports
  whether the release actually landed.

These are managed-agent task contracts carried by the skill package and its
`X.yaml` graph definition. They are not a separate registered task catalog.

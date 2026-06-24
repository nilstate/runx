---
name: dep-upgrade-plan
description: Build a ranked dependency upgrade plan from a real npm lockfile, live OSV advisories, and release constraints without changing project files.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - dependencies
    - upgrades
    - release-planning
links:
  source: https://github.com/RYDE-PLAY/runx/tree/ryde-play/dep-upgrade-plan/skills/dep-upgrade-plan
---

## What this skill does

`dep-upgrade-plan` reads a public npm `package-lock.json`, extracts locked npm
dependencies, queries OSV.dev at run time for advisories affecting those exact
versions, and emits a ranked upgrade plan. Each plan entry includes the package
name, exact `from` version, exact `to` version, risk level, advisory source, and
a breaking-change note. The skill also writes a changelog-style reviewer
summary when `output_dir` is provided.

This is a planning skill. It does not edit manifests, install packages, run
target project code, open pull requests, or perform package bumps. The proposed
plan is meant to be consumed by release catalog or remediation workflows after a
human reviews the evidence.

## When to use this skill

Use this skill when a release operator needs a reproducible upgrade queue for a
real npm project. It is useful for triage because it preserves the lockfile
hash, live OSV advisory source, constraints, selected target versions, ranking
reasons, and refusal reasons.

## Inputs

- `target_name`: human-readable project name.
- `target_repo`: public source repository URL.
- `target_ref`: immutable commit, tag, or release reference.
- `lockfile_path`: local path to a `package-lock.json` inside the skill directory.
- `lockfile_url`: public HTTPS URL for a `package-lock.json`.
- `lockfile_json`: package-lock contents as a JSON string.
- `scan_scope`: optional; `direct` by default. Use `all` to scan transitive
  lockfile packages.
- `include_dev`: optional; `false` by default.
- `advisories_path`: optional supplemental local advisory facts.
- `advisories_url`: optional supplemental public HTTPS advisory facts.
- `advisories_json`: optional supplemental advisory facts as a JSON string.
- `constraints_path`: local JSON file containing package constraints.
- `constraints_url`: public HTTPS URL containing package constraints.
- `constraints_json`: constraints as a JSON string.
- `output_dir`: optional directory inside the skill directory for `evidence.json`
  and `report.md`.

The skill queries OSV.dev for live npm advisories. Supplemental advisories may
include package records with `package`, `current`, `fixed`, `severity`,
`advisory`, `source`, and `breaking` fields. Constraints may include
package-specific `allowed`, `blocked`, `max_major`, `notes`, or `require_note`
fields.

## Outputs

The primary output is `dependency_upgrade_plan` with schema
`dep.upgrade.plan.v1`:

```json
{
  "schema": "dep.upgrade.plan.v1",
  "target": {},
  "source": {},
  "summary": {},
  "plan": [
    {
      "pkg": "express",
      "from": "4.16.4",
      "to": "4.20.0",
      "risk": "medium",
      "breaking": "OSV fixed version stays within major 4; review release notes before shipping."
    }
  ],
  "changelog": [],
  "refused": false
}
```

When `output_dir` is supplied, the runner writes `evidence.json` and `report.md`
inside that directory and returns their relative paths.

## Ranking rules

1. Read package versions from the lockfile and record the lockfile SHA-256.
2. Query OSV.dev for advisories affecting exact locked npm package versions.
3. Ignore advisory records where `current` disagrees with the lockfile.
4. Refuse a target version blocked by constraints.
5. Refuse a target major above a configured `max_major`.
6. Rank by severity, then whether a breaking note exists, then package name.
7. Emit exact `from` and `to` versions for every plan entry.

## Refusal behavior

The skill refuses to seal when no upgrade can be recommended, when every
candidate violates constraints, when required inputs are missing, when a URL is
not HTTPS, when JSON is invalid, when OSV cannot be queried, or when a package
cannot be found in the lockfile. The refusal is intentional evidence for
reviewers: it prevents silent or unsafe upgrade advice.

## Worked example

```bash
runx skill ./skills/dep-upgrade-plan \
  --input target_name="OWASP NodeGoat" \
  --input target_repo=https://github.com/OWASP/NodeGoat \
  --input target_ref=c5cb68a7084e4ae7dcc60e6a98768720a81841e8 \
  --input lockfile_url=https://raw.githubusercontent.com/OWASP/NodeGoat/c5cb68a7084e4ae7dcc60e6a98768720a81841e8/package-lock.json \
  --input scan_scope=direct \
  --input include_dev=false \
  --input output_dir=artifacts/nodegoat-live \
  --json
```

The sealed dogfood run scans OWASP NodeGoat at an immutable commit, queries live
OSV advisories for its locked direct production dependencies, and produces a
ranked plan. The hosted harness uses a checked-in snapshot of the same
NodeGoat lockfile so publish-time verification is not dependent on raw GitHub
availability. The refused dogfood case uses constraints that block every
available upgrade and therefore exits non-zero without mutating project files.

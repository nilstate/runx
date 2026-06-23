---
name: dependency-advisory-graph
description: Build an exact-version dependency advisory graph from a dependency manifest and advisory facts.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  manifest:
    type: json
    required: true
    description: Dependency manifest data with package names and installed versions.
  advisory_database:
    type: json
    required: true
    description: Advisory records with package, vulnerable range, evidence URL, severity, and fix version.
  ecosystem:
    type: string
    required: false
    description: Dependency ecosystem label. Defaults to npm.
runx:
  category: security
  input_resolution:
    required:
      - manifest
      - advisory_database
---

## What this skill does

This skill builds a checkable dependency advisory graph for one dependency
manifest and one supplied advisory fact set. It parses installed package
versions, matches advisory records by package name and exact installed version
range, and returns a graph-shaped JSON packet that separates confirmed advisory
matches from clean or unknown packages.

The runner is intentionally conservative. It requires installed versions from
the provided manifest, evaluates advisory ranges against the exact installed
version, never reports a package-name-only finding, and emits a false-positive
guard for every package-name match that did not satisfy the advisory version
evidence.

## When to use this skill

Use this skill when an agent needs a reproducible dependency advisory packet for
a public project, security handoff, Frantic delivery, runx receipt, or review
fixture where the advisory facts have already been selected. It is appropriate
when the caller needs exact-version proof fields such as `package`,
`installed_version`, `advisory_id`, `evidence_url`, `advisory_source`,
`retrieved_at`, `severity`, `fix_version`, and `confidence`.

Use it to turn a dependency manifest plus advisory database into evidence JSON,
verification JSON, and a concise Markdown report. The output can support later
upgrade planning, receipt review, or human triage, but it is not by itself an
authority to publish an advisory or mutate a target repository.

## When not to use this skill

Do not use this skill as a package installer, exploitability assessment, full
application security review, SBOM generator, or automated remediation tool. Do
not use it for private manifests unless the package names, installed versions,
and advisory facts have an explicit disclosure grant.

Do not treat a zero-finding packet as proof that the project is vulnerability
free. It only means no supplied advisory matched both the package name and exact
installed version evidence. If the manifest is missing installed versions,
return `needs_input` or stop instead of guessing from broad semver
declarations.

## Procedure

1. Read `manifest`, `advisory_database`, and optional `ecosystem`.
2. Extract installed package names and exact installed versions.
3. Normalize advisory facts from `advisory_database.advisories`.
4. Compare each advisory only against matching package names in the same
   ecosystem.
5. Emit a finding only when the installed version satisfies the advisory range
   or appears in `affected_versions`.
6. Record false-positive guards for package-name matches where the version does
   not match.
7. Build graph nodes for scanned packages and matched advisories.
8. Write `evidence.json`, `verification.json`, and `report.md` when `output_dir`
   is provided.

## Edge cases and stop conditions

Return `needs_input` or stop when the caller omits `manifest` or
`advisory_database`. Stop when the manifest is not valid JSON-like data, when it
does not contain `packages` or `dependencies`, or when
`advisory_database.advisories` is not an array.

Return `needs_more_evidence` when a finding would rely only on package name,
when the advisory record lacks a stable evidence URL, or when the caller cannot
show the authority or scope grant for publishing the result. Return `refused`
when asked to install packages, execute target project code, read private
repositories without approval, submit a vulnerability report, or mutate a
repository.

For `output_dir`, the resolved path must stay inside the skill directory. This
keeps artifacts bounded to the package and prevents accidental writes outside
the current receipt proof surface.

## Output schema

The primary output is `runx.dependency_advisory_graph.v1`:

```json
{
  "schema": "runx.dependency_advisory_graph.v1",
  "ecosystem": "npm",
  "package": "minimist",
  "installed_version": "0.0.8",
  "advisory_id": "GHSA-vh95-rmgr-6w4m",
  "evidence_url": "https://github.com/advisories/GHSA-vh95-rmgr-6w4m",
  "advisory_source": "GitHub Advisory Database",
  "retrieved_at": "2026-06-23T00:00:00.000Z",
  "severity": "critical",
  "fix_version": "0.2.1",
  "confidence": "high",
  "exact_version_match": true,
  "false_positive_guard": "Finding emitted only after package name matched and installed_version matched the advisory version evidence.",
  "findings": [],
  "clean_packages": [],
  "graph": {
    "nodes": [],
    "edges": []
  },
  "false_positive_guards": [],
  "validation": {
    "exact_version_match": true,
    "no_package_name_only_false_positives": true,
    "package_name_only_guard_count": 0,
    "target_code_executed": false,
    "target_packages_installed": false
  }
}
```

When `output_dir` is provided, the runner also writes `evidence.json`,
`verification.json`, and `report.md` inside that directory.

## Worked example

Run the skill against a small npm manifest and an advisory database that includes
both a real vulnerable range and a package-name-only false-positive guard:

```bash
runx skill ./skills/dependency-advisory-graph \
  --input ecosystem=npm \
  --input manifest='{"packages":[{"name":"minimist","version":"0.0.8","path":"node_modules/minimist"}]}' \
  --input advisory_database='{"retrieved_at":"2026-06-23T00:00:00.000Z","advisories":[{"id":"GHSA-vh95-rmgr-6w4m","package":"minimist","ecosystem":"npm","vulnerable_range":"<0.2.1","severity":"critical","fix_version":"0.2.1","evidence_url":"https://github.com/advisories/GHSA-vh95-rmgr-6w4m","source":"GitHub Advisory Database"}]}' \
  --input output_dir=artifacts/sealed-advisory-minimist-008 \
  --json
```

The receipt should include a high-confidence finding for
`minimist@0.0.8`, graph edges from the dependency node to the advisory node,
and a validation block proving exact-version matching.

## Inputs

- `manifest`: JSON object with either `packages` entries or dependency
  declarations that resolve to installed versions.
- `advisory_database`: JSON object with an `advisories` array. Each advisory
  should include package, ecosystem, vulnerable range or affected versions,
  evidence URL, severity, fix version, and source.
- `ecosystem`: optional ecosystem label. Defaults to `npm`.
- `output_dir`: optional directory inside the skill package for generated
  artifacts.

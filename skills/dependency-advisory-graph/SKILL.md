---
name: dependency-advisory-graph
description: Build an exact-version dependency advisory graph by scanning a real project lockfile and querying OSV advisories.
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
  lockfile:
    type: json
    required: false
    description: npm package-lock JSON object for the target project.
  lockfile_path:
    type: string
    required: false
    description: Path inside the skill package to a real target package-lock.json.
  lockfile_url:
    type: string
    required: false
    description: Public URL to a target package-lock.json, fetched at run time.
  osv_response:
    type: json
    required: false
    description: Optional OSV querybatch response for offline harness fixtures.
  osv_response_path:
    type: string
    required: false
    description: Optional path inside the skill package to an OSV querybatch fixture.
  ecosystem:
    type: string
    required: false
    description: Dependency ecosystem label. Defaults to npm.
  project_name:
    type: string
    required: false
    description: Name of the target project being scanned.
  project_url:
    type: string
    required: false
    description: Public URL of the target project being scanned.
runx:
  category: security
---

## What this skill does

This skill builds a checkable dependency advisory graph for one real dependency
lockfile. It parses installed package versions from an npm `package-lock.json`,
queries OSV for those exact package/version pairs at run time, and returns a
graph-shaped JSON packet that separates confirmed advisory matches from clean or
unknown packages.

The runner is intentionally conservative. It requires installed versions from a
lockfile, uses OSV `querybatch` with exact package versions, never reports a
package-name-only finding, and emits a direct dependency fix path for each
finding so the operator can see which top-level dependency to bump.

## When to use this skill

Use this skill when an agent needs a reproducible dependency advisory packet for
a public project, security handoff, Frantic delivery, runx receipt, or review
fixture where the target project has a dependency lockfile. It is appropriate
when the caller needs exact-version proof fields such as `package`,
`installed_version`, `advisory_id`, `evidence_url`, `advisory_source`,
`retrieved_at`, `severity`, `fix_version`, `direct_dependency_to_bump`,
`fix_path`, and `confidence`.

Use it to turn a real package-lock plus live OSV advisory data into evidence
JSON, verification JSON, and a concise Markdown report. The output can support
later upgrade planning, receipt review, or human triage, but it is not by itself
an authority to publish an advisory or mutate a target repository.

## When not to use this skill

Do not use this skill as a package installer, exploitability assessment, full
application security review, SBOM generator, or automated remediation tool. Do
not use it for private manifests unless the package names, installed versions,
and advisory facts have an explicit disclosure grant.

Do not treat a zero-finding packet as proof that the project is vulnerability
free. It only means OSV returned no vulnerability for the exact package versions
found in this lockfile. If the lockfile is missing installed versions, return
`needs_input` or stop instead of guessing from broad semver declarations.

## Procedure

1. Read `lockfile`, `lockfile_path`, or `lockfile_url`, optional `ecosystem`, and optional
   `project_name` / `project_url`.
2. Parse installed package names and exact installed versions from npm
   `package-lock.json`.
3. Identify whether each vulnerable package is a direct dependency or which
   direct dependency owns its dependency path.
4. Query OSV `querybatch` for each package/version pair. Harness fixtures may
   pass `osv_response` or `osv_response_path` so tests remain deterministic.
5. Emit a finding only when OSV returns a vulnerability for the exact package and
   installed version queried.
6. Emit `direct_dependency_to_bump` and `fix_path` for each finding.
7. Build graph nodes for scanned packages and matched advisories.
8. Write `evidence.json`, `verification.json`, and `report.md` when
   `output_dir` is provided.

## Edge cases and stop conditions

Return `needs_input` or stop when the caller omits `lockfile`, `lockfile_path`,
and `lockfile_url`. Stop when the lockfile is not valid JSON-like data, when it
does not contain npm `packages` or `dependencies`, or when OSV cannot be queried
and no explicit `osv_response` fixture was supplied.

Return `needs_more_evidence` when a finding would rely only on package name,
when OSV lacks a stable evidence URL, or when the caller cannot show the
authority or scope grant for publishing the result. Return `refused` when asked
to install packages, execute application code, read private repositories without
approval, submit a vulnerability report, or mutate a repository.

For `output_dir`, the resolved path must stay inside the skill directory. This
keeps artifacts bounded to the package and prevents accidental writes outside
the current receipt proof surface.

## Output schema

The primary output is `runx.dependency_advisory_graph.v2`:

```json
{
  "schema": "runx.dependency_advisory_graph.v2",
  "ecosystem": "npm",
  "project": {
    "name": "fixture-vulnerable-app",
    "url": "https://example.com/fixture-vulnerable-app",
    "lockfile_source": "fixtures/package-lock-advisory.json",
    "lockfile_path": "fixtures/package-lock-advisory.json",
    "lockfile_url": null
  },
  "package": "minimist",
  "installed_version": "0.0.8",
  "advisory_id": "GHSA-vh95-rmgr-6w4m",
  "evidence_url": "https://osv.dev/vulnerability/GHSA-vh95-rmgr-6w4m",
  "advisory_source": "https://api.osv.dev/v1/querybatch",
  "retrieved_at": "2026-06-23T00:00:00.000Z",
  "severity": "critical",
  "fix_version": "0.2.1",
  "fix_path": "Bump minimist so minimist@0.0.8 is replaced by a non-vulnerable version; OSV first fixed version: 0.2.1.",
  "direct_dependency_to_bump": "minimist",
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
    "target_lockfile_ingested": true,
    "target_code_executed": true,
    "target_code_execution_note": "The scanner executed against and parsed the target project's dependency lockfile; it did not run application code.",
    "target_packages_installed": false,
    "osv_runtime_query_performed": true,
    "advisory_source_mode": "live_osv_querybatch",
    "direct_dependency_fix_paths_count": 1
  }
}
```

When `output_dir` is provided, the runner also writes `evidence.json`,
`verification.json`, and `report.md` inside that directory.

## Worked example

Run the skill against a real npm `package-lock.json` and OSV:

```bash
runx skill ./skills/dependency-advisory-graph \
  --input ecosystem=npm \
  --input project_name=fixture-vulnerable-app \
  --input project_url=https://example.com/fixture-vulnerable-app \
  --input lockfile_path=fixtures/package-lock-advisory.json \
  --input output_dir=artifacts/sealed-advisory-minimist-008 \
  --json
```

The receipt should include a high-confidence finding for `minimist@0.0.8`,
graph edges from the dependency node to the advisory node, `osv_runtime_query`
evidence, and a fix path naming `minimist` as the direct dependency to bump.

## Inputs

- `lockfile`: JSON object containing an npm `package-lock.json`.
- `lockfile_path`: path inside the skill package to an npm `package-lock.json`.
- `lockfile_url`: public URL to an npm `package-lock.json`, fetched at run
  time. This is the preferred dogfood path for public projects because it proves
  the skill scanned a real target lockfile.
- `osv_response`: optional OSV `querybatch` response used only for deterministic
  offline harness fixtures.
- `osv_response_path`: path inside the skill package to an OSV fixture response.
- `ecosystem`: optional ecosystem label. Defaults to `npm`.
- `project_name`: optional target project name.
- `project_url`: optional public target project URL.
- `output_dir`: optional directory inside the skill package for generated
  artifacts.

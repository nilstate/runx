---
name: sbom-maker
description: Generate a CycloneDX-style Software Bill of Materials from one fixtured lockfile, including components, license summary, and license-risk findings.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - security
    - dependencies
    - sbom
    - compliance
links:
  source: https://github.com/runxhq/runx
  spec: https://cyclonedx.org/specification/overview/
---

## What this skill does

`sbom-maker` produces a reproducible Software Bill of Materials (SBOM) from a
single fixtured lockfile. The skill reads one lockfile text payload plus a
`lockfile_type` identifier and emits a CycloneDX-style SBOM with a component
list, a license summary, and a license-risk list. Every component is grounded
in the supplied lockfile; the skill never reaches a registry, never installs
packages, and never executes target code.

The default `dogfood` runner is a deterministic Node CLI that performs the
read-only parse + compose pass and emits a single SBOM packet. The
`harness.cases` declare one sealed case (supported lockfile yields a populated
SBOM) and one refused case (unsupported or malformed lockfile yields no SBOM).

## When to use it

- A security review needs a reproducible SBOM from a pinned lockfile before
  any registry call, install, or build step.
- An auditor or compliance gate needs a license summary and risk list grounded
  in exact versions that the lockfile already pins.
- A workflow needs to attach SBOM evidence to a CI artifact without leaking
  network calls to private registries.

## When not to use it

- To resolve transitive dependency versions, perform license audits of
  unmaintained packages, or recommend replacements. Use a separate dependency
  policy skill for those effects.
- To install, execute, or evaluate the dependencies it lists.
- To produce an SBOM from a source tree without a committed lockfile.
- To guess or invent a license when the lockfile does not declare one.

## Procedure

1. Read `lockfile` (text supplied inline) and `lockfile_type` (one of the
   supported format identifiers).
2. Refuse if the type is unsupported or the structural sanity check fails.
3. Parse the lockfile into a list of `{ name, version, purl }` components
   grounded in the supplied lockfile positions.
4. Compose a CycloneDX-style SBOM (`bomFormat`, `specVersion`, `serialNumber`,
   `metadata`, `components`).
5. Summarize licenses into `declared`, `detected`, and `unknown` buckets.
6. Emit `license_risks[]` for licenses that warrant manual downstream review.
7. Return the packet as JSON; never perform a network call.

## Output shape

```
{
  "sbom": { /* CycloneDX-style */ },
  "components": [{ "type": "library", "name": ..., "version": ..., "purl": ..., "evidence": {...} }],
  "license_summary": { "declared_count": ..., "detected_count": ..., "unknown_count": ..., "declared": [...], "detected": [...] },
  "license_risks": [{ "level": "review", "license_id": ..., "component_purl": ..., "reason": ... }],
  "refusal": { "reason": null }
}
```

When the input is malformed or unsupported, `refusal.reason` carries a
deterministic string and `sbom`, `components`, `license_summary`, and
`license_risks` are empty / null.

## Supported lockfile types

- `package-lock.json`
- `Cargo.lock`
- `requirements.txt`
- `go.sum`
- `Gemfile.lock`
- `pnpm-lock.yaml`
- `yarn.lock`
- `composer.lock`

## Non-goals

- No network registry lookups.
- No package installation or execution.
- No source-tree scan without a committed lockfile.
- No license recommendation or substitution.
- No mutation of repositories, registries, or external services.
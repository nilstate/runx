---
name: sbom-maker
description: Read a lockfile (package-lock.json, requirements.txt, or Cargo.lock) and generate a CycloneDX-style SBOM with a license summary and license-risk findings. No network lookups; everything is derived from the lockfile fixture.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: security
  tags:
    - sbom
    - cyclonedx
    - license-compliance
    - dependencies
---

# SBOM Maker

Turn one committed lockfile into a CycloneDX-style Software Bill of Materials with
a license summary and a license-risk finding list. The skill is fully offline:
every field is read from the lockfile itself, never from a registry or network
advisory source.

## What this skill does

1. Read `lockfile` (a parsed JSON/string object) and `lockfile_type`
   (`npm`, `pip`, or `cargo`).
2. Parse the lockfile into a flat component list: name, version, license (when
   the lockfile carries one), and an evidence location pointing back into the
   lockfile.
3. Emit a CycloneDX-style BOM (`bomFormat: CycloneDX`, `specVersion: 1.4`) with
   one `components` entry per dependency.
4. Produce a `license_summary` counting components per license type, including an
   `unknown` bucket when no license is declared.
5. Produce `license_risks` flagging components whose license is GPL, AGPL, or
   unknown — the categories that commonly block distribution or require review.
6. Return all four outputs as a single JSON object on stdout.

## When to use this skill

- Before release, to attach a reproducible SBOM to a build artifact.
- During license review, to see the license distribution and flag risky
  components in one pass.
- In CI, as a deterministic, network-free gate that fails on GPL/AGPL/unknown
  license exposure.

## When not to use this skill

- As a vulnerability scanner. This skill reports licenses, not CVEs.
- As an authoritative license clearance tool. License fields in lockfiles are
  advisory metadata, not a legal determination.
- When the lockfile is unavailable. The skill reads only the supplied fixture;
  it never fetches packages or metadata.

## Inputs

- `lockfile` (required, json): the parsed lockfile contents. For `npm` this is
  the `package-lock.json` object; for `pip` it is the text of
  `requirements.txt`; for `cargo` it is the `Cargo.lock` object.
- `lockfile_type` (required, string): one of `npm`, `pip`, `cargo`.

## Outputs

- `sbom`: CycloneDX-style BOM object (`bomFormat`, `specVersion`, `components`).
- `components`: flat array of `{ name, version, license, evidence_location }`.
- `license_summary`: object mapping license labels to component counts.
- `license_risks`: array of risk findings for GPL, AGPL, and unknown licenses.

## Error handling

For malformed or unsupported input — an unrecognized `lockfile_type`, a lockfile
that does not parse, or a lockfile missing the expected top-level structure — the
runner exits with code 64 and writes an error message to stderr. No SBOM is
emitted.

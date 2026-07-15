---
name: sbom-maker
description: Fetches a pinned npm lockfile, emits a grounded CycloneDX SBOM with license risks, and stores it as a project-version event that downstream runs can read.
---

# SBOM Maker

Use this skill when security review needs a reproducible bill of materials from a real public project. One governed graph reads an immutable lockfile URL, resolves pinned npm components, appends the result to `data.source`, reads it back, and emits typed outputs only after storage is verified.

## Inputs

- `source_handle`: An immutable raw GitHub URL or public GitHub Contents API file URL containing a real `package-lock.json` or `npm-shrinkwrap.json`. The Contents API form must use a hexadecimal commit in its sole `ref` query parameter. Bundled `fixture://` handles are reserved for the harness.
- `lockfile_type`: `package-lock` or `npm-shrinkwrap`.
- `data_source_ref`: Optional logical data-source reference. It defaults to `local://sbom-maker/artifacts`.
- `store_id`: Optional deterministic local fixture store ID.

## Outputs

- `source_read`: HTTP or fixture provenance with final URL, status, byte count, timestamp, and SHA-256 content digest.
- `sbom`: CycloneDX 1.5 document for the named project and version.
- `components`: Pinned name, version, license, and exact lockfile evidence location for each dependency.
- `license_summary`: Component total and license counts derived from the lockfile.
- `license_risks`: Strong or weak copyleft findings plus dependencies with missing license evidence.
- `stored_artifact_ref`: Data-source, `software_boms` resource, project-version aggregate ID, idempotency key, and verified readback state.

## Runtime Contract

The HTTPS reader only admits `raw.githubusercontent.com` and `api.github.com` file URLs pinned to a hexadecimal commit and caps decoded source bodies at 5 MB. GitHub Contents responses must identify a Base64-encoded file; the output records the repository file URL and blob SHA. Malformed files, unsupported lockfile types, unavailable sources, and unapproved hosts fail before the append step and emit no SBOM.

Successful runs append a `sbom.generated` event to `software_boms`, keyed by `<project>@<version>`. The idempotency key binds the project-version key to the fetched lockfile digest. The graph then reads that stream and refuses to finalize unless the event is present.

The package carries the canonical runx `data.local` and `data.sqlite` adapters so registry installs can execute both deterministic harness storage and durable local SQLite storage without private tool catalogs.

## Harness

- `supported-source-stored` reads a bundled npm v3 lockfile, generates four typed SBOM outputs, appends the event, reads it back, and seals.
- `malformed-source-refused` reads a malformed fixture and fails at `generate`; no append, readback, or SBOM emit occurs.

Run locally with `runx harness ./skills/sbom-maker`. A production run should pass an immutable raw lockfile URL and retain the emitted receipt for `runx verify`.

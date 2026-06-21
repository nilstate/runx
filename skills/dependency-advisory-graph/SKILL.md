---
name: dependency-advisory-graph
description: Match dependency manifests to advisory evidence with exact package and version checks.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: security
---

# Dependency Advisory Graph

Produce a reviewer-safe advisory packet for one dependency manifest.

This skill is intentionally conservative. It only reports a finding when the
package name, ecosystem, and installed version exactly match supplied advisory
evidence. Package-name-only matches are treated as insufficient evidence.

## Procedure

1. Read one manifest and one advisory list.
2. Normalize dependency names, ecosystems, and versions.
3. Match only exact installed versions against advisory `affected_versions`.
4. Emit a clean or unknown result when no exact version match exists.
5. Preserve the advisory source URL, retrieved timestamp, and optional graph
   receipt so a reviewer can trace the evidence.

## Inputs

- `manifest`: dependency manifest with `ecosystem` and `dependencies`.
- `advisories`: advisory records with package, affected versions, and source.
- `graph_receipt`: optional receipt ref from an upstream research graph.

## Outputs

- `package`, `installed_version`, `advisory_id`, `evidence_url`.
- `advisory_source`, `retrieved_at`, `severity`, `fix_version`.
- `confidence`, `graph_receipt`, `findings`, and `evidence`.


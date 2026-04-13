---
name: ecosystem-vuln-scan
description: Scan one dependency surface, draft the advisory, and package the approved publication bundle.
---

# Ecosystem Vulnerability Scan

This is the public-facing advisory lane built on top of `vuln-scan`.

It keeps the security flow bounded and reviewable:

1. produce the risk packet
2. draft the advisory
3. require approval before anything is packaged for publication

## Inputs

- `target` (required): repo, lockfile, package set, or ecosystem slice.
- `objective` (optional): what the operator wants from the scan.
- `channel` (optional): final advisory channel; defaults to `advisory`.
- `scan_context` (optional): known incidents or previous findings.

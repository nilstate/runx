---
name: ecosystem-vuln-scan
description: Scan one dependency surface, draft the advisory, and package the approved publication bundle.
runx:
  category: security
---

# Ecosystem Vulnerability Scan

This is the public-facing advisory lane built on top of `vuln-scan`.

It keeps the security flow bounded and reviewable:

1. produce the risk packet
2. draft the advisory
3. require approval before anything is packaged for publication

Every public claim must trace to the risk packet and a verified advisory source.
State affected scope, impact, and remediation precisely, without alarmism;
speculation stays in private operator notes. If severity, exposure,
remediation, or disclosure authority is unclear, stop at review. If publication
would not materially help affected users, keep the result as an operator
remediation packet instead.

## Output

- `risk_packet`: inventory, confirmed exposure, possible risk, and remediation evidence.
- `advisory_draft`: precise affected scope, impact, and next steps.
- `approval_decision`: disclosure and wording review.
- `publish_packet`: approved advisory and channel metadata.

## Inputs

- `target` (required): repo, lockfile, package set, or ecosystem slice.
- `objective` (optional): what the operator wants from the scan.
- `channel` (optional): final advisory channel; defaults to `advisory`.
- `scan_context` (optional): known incidents or previous findings.
